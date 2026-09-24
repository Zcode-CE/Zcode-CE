/* eslint-disable max-lines -- HTTP、WebSocket 与静态资源路由集中注册，保持同一鉴权顺序。 */
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";
import { basename, extname, relative, resolve, sep } from "node:path";
import { hostname } from "node:os";
import { Hono, type Context } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { WebSocket } from "ws";
import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelServer,
  LoggingChannelServer,
  type ISocket,
} from "@zcode/rpc";
import {
  ServiceCollection,
  IZCodeAgentService,
  createZCodeAgentConnectionScope,
  IFileService,
  IGitService,
  ISystemService,
  ITerminalService,
  IProviderProvisioningTargetService,
  IWorkspaceRegistryService,
} from "@zcode/services";
import {
  formatLogPrefix,
  formatZodError,
  remoteTargetSchema,
  SERVER_REMOTE_PROTOCOL_VERSION,
  ZCODE_RPC_HOST_CAPABILITY_HEADER,
  ZCODE_VERSION,
  type ServerRemoteInfo,
  type ServerRemoteWorkspaceInfo,
} from "@zcode/shared";
import { connectRemote, createRemoteBackend, type RemoteConnection } from "./remote/index.js";
import { createHostCapabilityStore } from "./hostCapability.js";
import { createBotIngressGate } from "./botIngress.js";
import {
  buildSecurityHeaders,
  createCrossSiteGuard,
  createSecurityHeaders,
  evaluateUpgradeOrigin,
  parseTrustedOrigins,
  rejectUpgrade,
} from "./webExposureGuard.js";
import type { AuthTokenSource } from "./authToken.js";
import {
  createAuthThrottle,
  parseTrustedProxies,
  resolveClientAddress,
  type AuthThrottle,
  type TrustedProxyRange,
} from "./authThrottle.js";
import { buildTrustedHostEntries, evaluateHost, type TrustedHostEntry } from "./hostAllowlist.js";
import {
  buildLoopbackExposureRefusal,
  buildProxySignalWithoutTokenWarning,
  collectExposureSignals,
  refusalSignals,
} from "./exposureGate.js";
import { createAuditLog, type AuditLog } from "./auditLog.js";

function wrapWebSocket(ws: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    onData.fire(VSBuffer.wrap(new Uint8Array(buf)));
  });
  ws.on("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  ws.on("error", () => {
    onClose.fire();
    onEnd.fire();
  });

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      if (ws.readyState === ws.OPEN) {
        ws.send(buffer.buffer);
      }
    },
    end() {
      ws.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      ws.close();
    },
  };
}

const log = (...args: unknown[]) =>
  console.log(formatLogPrefix("zcode-server:http", process.pid), ...args);

/** 暴露面告警专用：走 console.warn（与普通 log 区分），测试通过替换 console.warn 捕获。 */
const warn = (...args: unknown[]) =>
  console.warn(formatLogPrefix("zcode-server:http", process.pid), ...args);

/** 连接级审计所需的上下文（在 upgrade gate 里算好，避免这一层再依赖中间件状态）。 */
interface ConnectionAuditContext {
  audit: AuditLog;
  activeConnections: Map<
    string,
    { role: string; peer: string; authenticated: boolean; startedAt: number }
  >;
  peer: string;
  path: string;
  authenticated: boolean;
  tokenLabel?: string;
}

function setupChannelServer(
  ws: WebSocket,
  services: ServiceCollection,
  clientMode: "desktop-continuous" | "web-remote-replayable",
  auditContext?: ConnectionAuditContext,
) {
  const socket = wrapWebSocket(ws);
  // 连接级审计（B1）：建立与断开各一条，close 带存活时长与连接 id（可把 open/close 配对）。
  // 注意：**不写令牌**，只写标签；不写查询串（`?token=` 会进浏览器历史，进审计等于多一处落盘）。
  const connectionId = randomUUID();
  const startedAt = Date.now();
  const role = clientMode === "desktop-continuous" ? "trusted-host-relay" : "terminal-client";
  if (auditContext) {
    auditContext.activeConnections.set(connectionId, {
      role,
      peer: auditContext.peer,
      authenticated: auditContext.authenticated,
      startedAt,
    });
    auditContext.audit.record({
      kind: "audit:ws-open",
      peer: auditContext.peer,
      role,
      connectionId,
      path: auditContext.path,
      authenticated: auditContext.authenticated,
      ...(auditContext.tokenLabel ? { tokenLabel: auditContext.tokenLabel } : {}),
    });
  }
  const protocol = new SocketProtocol(socket);
  const rawServer = new ChannelServer(protocol, "server");
  // 用日志中间件包装，统一记录所有 RPC 调用
  const server = new LoggingChannelServer(rawServer, log);
  const agentService = services.getOptional(IZCodeAgentService);
  const connectionScope = agentService
    ? createZCodeAgentConnectionScope(agentService, {
        connectionId: `server-ws-${randomUUID()}`,
        clientMode,
        role: clientMode === "desktop-continuous" ? "trusted-host-relay" : "terminal-client",
      })
    : undefined;
  const overrides = new Map<string, unknown>();
  if (connectionScope) {
    overrides.set(IZCodeAgentService.channelName, connectionScope.service);
  }
  // Provisioning 携带跨 Environment 凭据，只允许 Desktop trusted host 使用；普通 Web
  // remote/replayable 客户端即使知道频道名，也不能获得 target 写入接口。
  if (
    clientMode !== "desktop-continuous" &&
    services.getOptional(IProviderProvisioningTargetService)
  ) {
    overrides.set(IProviderProvisioningTargetService.channelName, {
      apply: async () => {
        throw new Error("Provider Provisioning 仅支持受信 Desktop Host");
      },
    });
  }
  services.exposeOnChannelServer(server, overrides);
  socket.onClose(() => {
    if (auditContext) {
      auditContext.activeConnections.delete(connectionId);
      auditContext.audit.record({
        kind: "audit:ws-close",
        peer: auditContext.peer,
        role,
        connectionId,
        path: auditContext.path,
        authenticated: auditContext.authenticated,
        durationMs: Date.now() - startedAt,
        ...(auditContext.tokenLabel ? { tokenLabel: auditContext.tokenLabel } : {}),
      });
    }
    void connectionScope?.dispose();
    rawServer.dispose();
  });
}

/** 存储 web 模式下的远程连接，key 为随机 ID */
const remoteConnections = new Map<string, RemoteConnection>();

function generateId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export interface HttpServerOptions {
  serverId?: string;
  name?: string;
  host?: string;
  authRequired?: boolean;
  authToken?: string;
  spaFallback?: boolean;
  staticRoot?: string;
  workspaces?: ServerRemoteWorkspaceInfo[];
  /**
   * 跨源合法部署的白名单（反代在不同域名/端口时）。空 = 只接受同源。
   * 来源：`ZCODE_SERVER_TRUSTED_ORIGINS`（逗号分隔），解析在 entry-http.ts。
   */
  trustedOrigins?: string[];
  /** 随 https 请求下发 HSTS。默认 false —— HSTS 一旦下发就无法回退（见 local-setup.md）。 */
  hsts?: boolean;
  /** CSP 模式：默认 report-only（观察期），见 webExposureGuard.ts 的说明。 */
  cspMode?: "report-only" | "enforce" | "off";
  /**
   * 令牌来源。缺省时由 `authToken` 包装成一个只读集合（既有调用方的契约不变）；
   * 传 AuthTokenSource 时使用它的 `enabled`/`verify`（令牌文件与 SIGHUP 重载由此接入）。
   */
  tokenSource?: AuthTokenSource;
  /**
   * 可信代理（IP 或 CIDR）。**默认空 = 不采信 X-Forwarded-For**，一律用 socket 对端地址。
   * 来源：`ZCODE_SERVER_TRUSTED_PROXIES`（逗号分隔），解析在 entry-http.ts。
   */
  trustedProxies?: TrustedProxyRange[];
  /** 鉴权失败限流（A3）。缺省用默认阈值；测试可注入短窗口。 */
  throttle?: AuthThrottle;
  /**
   * 运维显式登记的 Host 白名单条目（`ZCODE_SERVER_TRUSTED_HOSTS`）。**追加**在默认白名单
   * （回环 + 本机网卡 + 实际监听地址）之后，不替换默认值。见 hostAllowlist.ts。
   */
  trustedHosts?: { host: string; port?: number }[];
  /** 直接注入白名单条目（测试用；给定时不再从监听地址/接口推导）。 */
  trustedHostEntries?: TrustedHostEntry[];
  /** 审计日志（B1）。缺省由本函数创建一个；测试可注入以捕获事件。 */
  audit?: AuditLog;
  /**
   * 并发 WebSocket 连接上限（B3）：**防资源耗尽**，与限流（防爆破，按地址计数、时间窗封禁）
   * 职责不同、互不替代。超限时拒绝新升级（HTTP 403 + 明确原因），已建立的连接不受影响。
   * 默认 32：单机自托管下「本人所有设备 + 少量浏览器标签」远低于此值。
   */
  maxConcurrentConnections?: number;
  /**
   * IM 机器人**入站**面（/bot/**）。**默认不启用** ⇒ 未启用时该路径与「不存在」逐字节相同（404）。
   *
   * `enabled` 只是**快速短路**，不承担安全边界：真正的边界是 gate 内逐请求的
   * 「运行期判定 + 凭据校验 + 限流」。见 botIngress.ts 的文件头。
   *
   * 判定由 `entry-http.ts` 在启动期求出（`listBots()` 是异步的，而本函数是同步的）。
   */
  botIngress?: { enabled: boolean; maxBodyBytes?: number };
  /** bot 入站面的限流桶（测试可注入短窗口）。缺省用默认阈值。 */
  botIngressThrottle?: AuthThrottle;
}

function readTrimmedEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function resolveServerId(options: HttpServerOptions): string {
  return (
    options.serverId?.trim() || readTrimmedEnv("ZCODE_SERVER_ID") || hostname() || "zcode-server"
  );
}

function fallbackServerWorkspaces(): ServerRemoteWorkspaceInfo[] {
  const workspacePath = readTrimmedEnv("ZCODE_SERVER_WORKSPACE") || process.cwd();
  return [
    {
      path: workspacePath,
      label: basename(workspacePath) || workspacePath,
    },
  ];
}

/**
 * server-info 的 workspaces（M1.3）——**由服务端注册表驱动**。
 *
 * 为什么改：client 启动时用 `workspaces[0]` 作为初始 workspace。此前它只会是
 * `ZCODE_SERVER_WORKSPACE`/cwd —— 手机打开服务后落在一个跟用户无关的目录，而真实数据侧有
 * 50+ 个 workspace（见 docs/development/workspace-registry.md §1）。现在取注册表默认视图的
 * 首项（最近活跃），与侧栏口径一致。
 *
 * 三条硬约束：
 * ① **只读**：这里不得启动任何 Agent runtime（§3.1 架构不变式）；
 * ② **不改变显式声明**：`options.workspaces` 仍优先（server-core 与测试的显式契约）；
 * ③ **失败不炸**：注册表读失败（库缺失/被锁）时回落到 cwd 并告警 —— server-info 同时承担
 *    web 启动期的鉴权探测，让它 500 会把「授权问题」和「注册表问题」混成一件事。
 */
async function resolveServerWorkspaces(
  options: HttpServerOptions,
  services: ServiceCollection,
): Promise<ServerRemoteWorkspaceInfo[]> {
  if (options.workspaces) {
    return options.workspaces;
  }
  const registry = services.getOptional(IWorkspaceRegistryService);
  if (!registry) {
    return fallbackServerWorkspaces();
  }
  try {
    const { defaultView } = await registry.listWorkspaceRegistry();
    if (defaultView.length === 0) {
      return fallbackServerWorkspaces();
    }
    return defaultView.map((entry) => ({
      path: entry.workspacePath,
      label: basename(entry.workspacePath) || entry.workspacePath,
      ...(entry.workspaceIdentity ? { workspaceIdentity: entry.workspaceIdentity } : {}),
    }));
  } catch (error) {
    warn(
      "读取工作区注册表失败，server-info 回落到 ZCODE_SERVER_WORKSPACE/cwd：" +
        (error instanceof Error ? error.message : String(error)),
    );
    return fallbackServerWorkspaces();
  }
}

async function createServerInfo(
  options: HttpServerOptions,
  services: ServiceCollection,
): Promise<ServerRemoteInfo> {
  return {
    serverId: resolveServerId(options),
    ...(options.name?.trim() || readTrimmedEnv("ZCODE_SERVER_NAME")
      ? { name: options.name?.trim() || readTrimmedEnv("ZCODE_SERVER_NAME") }
      : {}),
    version: ZCODE_VERSION,
    protocolVersion: SERVER_REMOTE_PROTOCOL_VERSION,
    authRequired: options.authRequired ?? Boolean(readTrimmedEnv("ZCODE_SERVER_TOKEN")),
    workspaces: await resolveServerWorkspaces(options, services),
    capabilities: {
      desktopContinuous: true,
      websocketRpc: true,
      processResourceTelemetry: true,
    },
  };
}

const zcodeLiteTokenCookieName = "zcode_lite_token";

const staticMimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function parseCookieHeader(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) {
    return cookies;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) {
      cookies.set(name, value);
    }
  }
  return cookies;
}

/**
 * 请求是否走 https —— 决定 token cookie 是否带 `Secure`。
 *
 * 两种来源：① Node 侧直接就是 https（本仓库目前没有 TLS 服务端，留作未来接入）；
 * ② 反代终止 TLS（TLS 反代场景的常规做法，见 docs/development/local-setup.md）。
 * `x-forwarded-proto` 可被伪造，但伪造它只会让 cookie 多一个 `Secure`
 * （http 下浏览器不会回发该 cookie），不会造成提权；反之若不看它，
 * https 反代下种出的 cookie 会缺少 `Secure`，明文 http 上照发。
 */
function isSecureRequest(c: Context): boolean {
  if (new URL(c.req.url).protocol === "https:") {
    return true;
  }
  const forwardedProto = c.req.header("x-forwarded-proto");
  return forwardedProto?.split(",")[0]?.trim().toLowerCase() === "https";
}

/** HttpOnly + SameSite=Lax 保持不变；`Secure` 只在 https（含反代）请求上下发。 */
function buildLiteTokenCookie(token: string, secure: boolean): string {
  const attributes = ["Path=/", "HttpOnly", "SameSite=Lax"];
  if (secure) {
    attributes.push("Secure");
  }
  return `${zcodeLiteTokenCookieName}=${encodeURIComponent(token)}; ${attributes.join("; ")}`;
}

/** 回环判定（含 ::ffff:127.x 映射形态）；未知/空地址按 false 处理，不据此告警。 */
export function isNonLoopbackAddress(address: string | undefined): boolean {
  const value = address?.trim().toLowerCase();
  if (!value) return false;
  if (value === "localhost" || value === "::1" || value === "[::1]") return false;
  if (value.startsWith("127.")) return false;
  if (value.startsWith("::ffff:127.")) return false;
  return true;
}

/**
 * 启动期暴露面告警（绑定非回环时必须打印，且内容要可操作）。
 *
 * 为什么必须：非回环绑定下 agent 级服务只剩 token 一道屏障，而明文 http 的 token cookie 不带
 * Secure（见 buildLiteTokenCookie），同网段可嗅探。这里只告警、不拒绝：用户手机验收走的就是
 * http://<私网IP>:<port>/?token=... 这条合法用法，拒绝会打断它。
 */
export function buildNonLoopbackListenWarning(params: {
  host: string;
  port: number;
  tokenAuth: boolean;
}): string | null {
  if (!isNonLoopbackAddress(params.host)) return null;
  return [
    "暴露面提醒：服务端绑定在非回环地址，任何能访问该网段的人都可以尝试连接。",
    "  · 这是 agent 级服务（可执行命令、读写工作区），token 是唯一屏障。",
    "  · 明文 http 下 token cookie 不带 Secure，可被同网段嗅探；token 也可能留在浏览器历史与代理日志里。",
    "  · 建议放到 TLS 终结的反向代理或隧道之后，并透传 X-Forwarded-Proto: https（cookie 才会带 Secure）。",
    "  · 能只绑私网网卡就别绑 0.0.0.0；明文 http 的合法用法限于可信局域网，不要暴露到公网。",
    "  · 当前：bind=" +
      params.host +
      ":" +
      params.port +
      " token-auth=" +
      (params.tokenAuth ? "enabled" : "disabled"),
  ].join("\n");
}

/**
 * 运行期「首次收到非回环对端 + 非 TLS 请求」的告警（同一服务实例只提示一次）。
 *
 * 只描述真实后果（本次会话下发的 token cookie 不带 Secure）；同样只告警、不拒绝。
 */
export function buildPlainHttpPeerWarning(params: {
  remoteAddress?: string;
  secure: boolean;
}): string | null {
  if (params.secure) return null;
  if (!isNonLoopbackAddress(params.remoteAddress)) return null;
  return [
    "暴露面提醒：本会话首次出现来自非回环对端（" + params.remoteAddress + "）的明文 http 请求。",
    "  · 本次会话下发的 token cookie 将不带 Secure，同网段可嗅探；请确认你处在可信局域网。",
    "  · 需要跨网络访问时，请走 TLS 终结的反向代理或隧道，并透传 X-Forwarded-Proto: https。",
  ].join("\n");
}

/**
 * 对端地址（**可信代理**口径，见 authThrottle.ts 的模块注释）。
 *
 * 修改前这里**无条件**采信 `X-Forwarded-For` 首跳，理由是「伪造只会多打一次告警」——
 * 那条理由在只有告警时成立，但一旦按地址做限流，XFF 就成了攻击者自选的键。
 * 现在只有 socket 对端落在 `trustedProxies` 里才采信 XFF，且从右往左取第一个不可信地址。
 */
function resolvePeerAddress(
  c: Context,
  trustedProxies: readonly TrustedProxyRange[],
): string | undefined {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return resolveClientAddress({
    socketAddress: env?.incoming?.socket?.remoteAddress ?? undefined,
    forwardedFor: c.req.header("x-forwarded-for"),
    trustedProxies,
  });
}

/**
 * 校验候选令牌并**在有令牌来源时**种 cookie。
 *
 * 与修改前的差别：不再拿一个字符串做字面比较，而是委托 `AuthTokenSource`（支持多条令牌 +
 * 热重载 + 常量时间比较）。`source.enabled === false`（显式 `--no-token`）时不种 cookie ——
 * 修改前若 `authToken` 为空则整段令牌中间件不挂载，因此「空令牌却种 cookie」不可能发生；
 * 这里保持同一语义，避免出现「看似有鉴权、实则任何令牌都能种上」的假象。
 */
function hasValidLiteToken(c: Context, source: AuthTokenSource): boolean {
  if (!source.enabled) {
    return false;
  }
  const url = new URL(c.req.url);
  const candidate = url.searchParams.get("token") ?? undefined;
  if (candidate !== undefined && source.verify(candidate)) {
    c.header("Set-Cookie", buildLiteTokenCookie(candidate, isSecureRequest(c)));
    return true;
  }
  return source.verify(parseCookieHeader(c.req.header("cookie")).get(zcodeLiteTokenCookieName));
}

/**
 * 识别的路由清单 + 公开/受保护标注（G11）。
 *
 * **为什么要有这张表**：鉴权是**白名单**语义 —— 不在 `isTokenProtectedPath` 里的路径一律公开。
 * 于是「新增一条路由、忘了归入 /`api` 或 /`ws` 前缀」会让鉴权**静默缺席**（而 SPA fallback 还会
 * 给这个路径返回 200 的壳，看不出异常）。这张表把「这条路由是公开还是受保护」写成显式契约：
 * - 它是**运行时兜底**：`assertRoutePolicyEnforced` 在启动时逐条断言「受保护的路由确实被
 *   `isTokenProtectedPath` 覆盖」，不满足就**拒绝启动**（fail-closed，而不是留个洞）；
 * - 它同时是**测试的可读契约**：测试逐条对照这张表与实现，防未来漂移。
 *
 * 加新路由时：在这里加一行、选 `public`/`protected`，测试会立刻告诉你口径是否自洽。
 */
export interface RoutePolicyEntry {
  /** 精确路径或前缀（`prefix: true` 时按前缀匹配）。 */
  path: string;
  prefix?: boolean;
  policy: "public" | "protected";
  /** 为什么是公开的（公开路由必须写理由，避免"顺手公开"）。 */
  note: string;
}

export const ROUTE_POLICY: readonly RoutePolicyEntry[] = [
  { path: "/api/server-info", policy: "protected", note: "泄露主机名/版本/工作区绝对路径" },
  {
    path: "/api/rpc-host-capability",
    policy: "protected",
    note: "签发 trusted-host ticket（提权面）",
  },
  { path: "/api/connect-remote", policy: "protected", note: "让服务端出网建连接（SSRF 面）" },
  { path: "/api", prefix: true, policy: "protected", note: "API 命名空间整体受保护" },
  { path: "/ws", policy: "protected", note: "agent 级 RPC 通道（terminal-client 角色）" },
  { path: "/ws/host", policy: "protected", note: "需一次性 ticket，拿 desktop-continuous 角色" },
  { path: "/ws/remote/:id", prefix: true, policy: "protected", note: "远程连接桥接（一次性 id）" },
  { path: "/", policy: "public", note: "SPA 壳：浏览器必须先拿到它才能进入鉴权流程" },
  { path: "/index.html", policy: "public", note: "同上" },
  { path: "/share/**", prefix: true, policy: "public", note: "会话分享落地页（分享码本身即凭据）" },
  {
    path: "/bot/**",
    prefix: true,
    policy: "public",
    note:
      "IM 机器人入站回调（它有自己的凭据：x-zcode-bot-secret，逐 bot 存储于 credentialService）。" +
      "本登记不授予任何访问权 —— ROUTE_POLICY 不驱动运行期路由（matchesRoutePolicy 无调用点），" +
      "访问权在 botIngress.ts 的 gate 内（默认不注册 = 未启用时 404）",
  },
  {
    path: "/assets/**",
    prefix: true,
    policy: "public",
    note: "静态资源（JS/CSS/字体），无业务数据",
  },
];

function matchesRoutePolicy(entry: RoutePolicyEntry, pathname: string): boolean {
  if (entry.prefix) {
    // `/api` 前缀同时要覆盖精确的 `/api` 本身（历史上这条曾落到 SPA fallback）。
    const base = entry.path.endsWith("/") ? entry.path.slice(0, -1) : entry.path;
    if (base.endsWith("/**")) {
      return pathname.startsWith(base.slice(0, -3) + "/");
    }
    return pathname === base || pathname.startsWith(base + "/");
  }
  if (entry.path.startsWith("/ws/remote/")) {
    return pathname.startsWith("/ws/remote/");
  }
  return pathname === entry.path;
}

/**
 * 需要令牌的路径前缀。
 *
 * 注意 /api 与 /ws 的**精确路径**也必须算在内：此前只认 /api/ 前缀与 /ws 精确值，
 * 于是 GET /api（无尾斜杠）落到静态 SPA fallback 返回了 index.html（200）—— 不泄漏业务数据，
 * 但鉴权口径应当 fail-closed（/api 是 API 命名空间本身，不该被静态兜底接走）。
 *
 * **导出理由**（task-97）：`test/botIngress.test.ts` 的 A2④ 判据要**逐字节**比对
 * 「新增 /bot/** 前后本函数的输入输出表」，这是「没有削弱令牌面」最直接的证据。
 * 与 `ROUTE_POLICY` / `assertRoutePolicyEnforced`（同样为测试而导出）**同构**；
 * `src/index.ts` 只导出 `createHttpServer`，故不影响包的公开面。
 */
export function isTokenProtectedPath(pathname: string): boolean {
  return (
    pathname === "/ws" ||
    pathname === "/api" ||
    pathname.startsWith("/ws/") ||
    pathname.startsWith("/api/")
  );
}

/**
 * 启动期断言：`ROUTE_POLICY` 里标为 `protected` 的每条路由，都必须真的被
 * `isTokenProtectedPath` 覆盖；否则说明"标注是受保护的、实现是公开的"——这种不一致必须
 * **拒绝启动**（新的攻击面往往就是这么来的：加注解容易，改判断遗漏）。
 */
export function assertRoutePolicyEnforced(
  isProtected: (pathname: string) => boolean = isTokenProtectedPath,
): void {
  for (const entry of ROUTE_POLICY) {
    if (entry.policy !== "protected") {
      continue;
    }
    // 前缀条目用一个具体样例路径探针（`/api` 前缀要连同精确形式一起验）。
    const probes = entry.prefix
      ? [entry.path.endsWith("/**") ? entry.path.slice(0, -2) + "sample" : entry.path]
      : [entry.path.replace(":id", "sample-id")];
    for (const probe of probes) {
      if (!isProtected(probe)) {
        throw new Error(
          "路由口径不一致：ROUTE_POLICY 标明 '" +
            entry.path +
            "' 是受保护路由，但 isTokenProtectedPath 不覆盖它（探针：" +
            probe +
            "）。" +
            "这会让该路由静默变成公开面 —— 请把它的前缀加入 isTokenProtectedPath，或把它标为 public 并写明理由。",
        );
      }
    }
  }
}

function isStaticFallbackAllowed(pathname: string): boolean {
  return !isTokenProtectedPath(pathname);
}

function isInsideDirectory(root: string, candidate: string): boolean {
  const diff = relative(root, candidate);
  return diff === "" || (!diff.startsWith("..") && !diff.includes(`..${sep}`));
}

async function resolveStaticFile(
  staticRoot: string,
  pathname: string,
  spaFallback: boolean,
): Promise<string | null> {
  const root = resolve(staticRoot);
  const normalizedPathname = pathname === "/" ? "/index.html" : pathname;
  const relativePath = decodeURIComponent(normalizedPathname).replace(/^\/+/, "");
  let candidate = resolve(root, relativePath);
  if (!isInsideDirectory(root, candidate)) {
    return null;
  }

  try {
    const candidateStat = await stat(candidate);
    if (candidateStat.isDirectory()) {
      candidate = resolve(candidate, "index.html");
      if (!isInsideDirectory(root, candidate)) {
        return null;
      }
      const indexStat = await stat(candidate);
      return indexStat.isFile() ? candidate : null;
    }
    if (candidateStat.isFile()) {
      return candidate;
    }
  } catch {
    // 静态资源未命中时再进入 SPA fallback，保留真实文件错误的 404 语义。
  }

  if (!spaFallback || !isStaticFallbackAllowed(pathname)) {
    return null;
  }
  const indexFile = resolve(root, "index.html");
  try {
    const indexStat = await stat(indexFile);
    return indexStat.isFile() ? indexFile : null;
  } catch {
    return null;
  }
}

function staticContentType(filePath: string): string {
  return staticMimeTypes[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/**
 * 默认监听地址：**回环**。
 *
 * 历史缺陷（安全，已修）：不传 host 时 `serve()` 把 undefined 交给
 * `server.listen(port, undefined)`，Node 会绑定所有网卡（`*`）；同时
 * `ZCODE_SERVER_AUTH_TOKEN` 未设置时中间件根本不挂载，于是 /api/*、/ws、
 * /ws/host 对同网段任何人可达 —— `/ws/host` 只校验一次性 ticket，而该 ticket
 * 由同样无鉴权的 `POST /api/rpc-host-capability` 签发（30 秒 TTL），
 * 拿到即得 `desktop-continuous`（trusted host）角色；`/api/server-info`
 * 还会泄露主机名、版本与工作区绝对路径。原日志把这档默认打印成 `localhost`，
 * 进一步误导用户。修复前后实测对照见
 * `.reverse/40-remote-control/SECURITY-SERVER-DEFAULTS.md`。
 */
export const DEFAULT_HTTP_LISTEN_HOST = "127.0.0.1";

/**
 * 并发 WebSocket 连接上限的默认值（B3）。
 *
 * 与限流（A2）**职责不同**：限流按地址计数、时间窗封禁，防的是**凭据爆破**；
 * 这个上限防的是**资源耗尽**（一次得手的凭据或本机上的其它进程开几千条连接把服务拖垮）。
 * 32 的依据：单机自托管场景是「本人几台设备 + 几个浏览器标签」，正常使用远低于此值，
 * 而它足以拦住"连接洪水"。超限语义见 upgrade gate：**拒绝新连接（403 + 明确原因），
 * 已建立的连接不受影响** —— 不做排队（排队会让攻击者用队首阻塞合法用户）。
 */
export const DEFAULT_MAX_CONCURRENT_CONNECTIONS = 32;

function normalizeListenHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  return trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
}

/** 与 packages/zcode-server-cli/src/server-core/http.ts 的 isLoopbackHost 保持同一判定口径。 */
export function isLoopbackHost(host: string): boolean {
  const normalized = normalizeListenHost(host);
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

/**
 * 监听地址的 fail-closed 前置检查：**非回环 + 无 token ⇒ 拒绝启动**。
 *
 * 不做「只警告然后继续跑」：无鉴权的非回环绑定等于把 Agent 级 RPC 与
 * trusted-host ticket 发放接口交给整个网段，静默降级在这里是不可接受的。
 * 立场与 server-core 一致（那边对非回环直接抛错）。
 */
export function assertListenSecurity(options: {
  host: string;
  authToken?: string;
  /** 环境里是否配了令牌来源（显式令牌或令牌文件）。区分「没配」与「配了但没解析出令牌」。 */
  authSourceConfigured?: boolean;
  /** 令牌集合是否真的可用（`AuthTokenSource.enabled`）。 */
  authSourceEnabled?: boolean;
  /**
   * 生效的可信代理（`ZCODE_SERVER_TRUSTED_PROXIES` 解析后）。**非空 = 运维声明"我在反代/隧道之后"**
   * ⇒ 回环绑定也要求令牌（见 exposureGate.ts 的模块注释：这是"一个 curl 即完全控制权"那条绕过路径的堵法）。
   */
  trustedProxies?: readonly TrustedProxyRange[];
  /**
   * 运维**显式登记**的 Host 白名单条目（默认集合之外的主机名）。**非空 = 运维声明"有外部域名指向本服务"**
   * ⇒ 同上，回环绑定也要求令牌。
   */
  configuredTrustedHosts?: readonly TrustedHostEntry[];
  /**
   * 生效的跨源白名单（`ZCODE_SERVER_TRUSTED_ORIGINS` 解析后）。**它不参与拒绝判定** ——
   * 只登记它是此前能起来的一种部署形态，把"配错"升级成"起不来"会打死合法路径；
   * 它只在"回环 + 无令牌"时走**告警**（见 buildProxySignalWithoutTokenWarning）。
   */
  trustedOrigins?: readonly string[];
}): void {
  // fail-closed：非回环必须有**可用**的令牌来源。
  // 注意区分两种情况：没配（下面给三条做法）与配了但为空（文件损坏/空文件 ⇒ 必须显式拒绝，
  // 否则会静默退化成「无鉴权的对外监听」，那正是本函数要防的那一档）。
  const hasUsableSource = options.authSourceEnabled ?? Boolean(options.authToken?.trim());
  // 回环**不再**无条件放行：只要运维给出了「这东西会被本机之外访问」的信号（配了可信代理、
  // 或登记了默认集合之外的域名），"回环可达 = 只有本机能到"这个前提就不成立了 ⇒ 令牌必须开着。
  // 判据与文案的唯一所有者在 exposureGate.ts（本函数只负责在正确的时机拒绝）。
  if (isLoopbackHost(options.host)) {
    const signals = refusalSignals(
      collectExposureSignals({
        trustedProxies: options.trustedProxies ?? [],
        configuredTrustedHosts: options.configuredTrustedHosts ?? [],
        trustedOrigins: options.trustedOrigins ?? [],
      }),
    );
    if (signals.length > 0 && !hasUsableSource) {
      throw new Error(buildLoopbackExposureRefusal({ host: options.host, signals }));
    }
    return;
  }
  if (hasUsableSource) {
    return;
  }
  if (options.authSourceConfigured && !hasUsableSource) {
    throw new Error(
      [
        `拒绝启动：绑定非回环地址 "${options.host}"，且配置的令牌来源没有可用令牌。`,
        "",
        "原因：令牌文件为空、只有注释、或被解析出 0 条令牌时，若继续运行，服务会**看起来开启了鉴权、",
        "实际上没有任何凭据能通过**（对外监听 = 无鉴权）。这是安全相关的错误行为，不能静默降级。",
        "",
        "两种做法：",
        "  1. 往令牌文件里写入至少一条令牌（每行 `<token>` 或 `<token> <标签>`）；",
        "  2. 或删掉 ZCODE_SERVER_AUTH_TOKENS_FILE / ZCODE_SERVER_AUTH_TOKEN 这两个配置。",
      ].join("\n"),
    );
  }
  throw new Error(
    [
      `拒绝启动：绑定非回环地址 "${options.host}" 但未设置 ZCODE_SERVER_AUTH_TOKEN。`,
      "",
      "原因：不设 token 时 /api/*、/ws、/ws/host 对能访问该地址的人全部开放 ——",
      "  - GET /api/server-info 泄露主机名、版本、工作区绝对路径；",
      "  - POST /api/rpc-host-capability 未授权即可签发 trusted-host ticket；",
      "  - 带该 ticket 的 /ws/host 连接会拿到 desktop-continuous（trusted host）角色。",
      "",
      "三种做法：",
      "  1. 只在本机用（默认）：不设 HOST/ZCODE_SERVER_HOST，监听 127.0.0.1；",
      "  2. 对外且要令牌：ZCODE_SERVER_AUTH_TOKEN=$(openssl rand -hex 32)；",
      "  3. 对外且要 TLS：反代终止 TLS 并把 /api 与 /ws 一起转发给回环监听（见 docs/development/local-setup.md）。",
    ].join("\n"),
  );
}

export function createHttpServer(
  services: ServiceCollection,
  port = 3030,
  options: HttpServerOptions = {},
) {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  const hostCapabilities = createHostCapabilityStore();

  // 唯一所有者：默认值与 fail-closed 判定都在这里，入口只负责从环境读取「是否显式指定」。
  const host = options.host?.trim() || DEFAULT_HTTP_LISTEN_HOST;
  const explicitToken = options.authToken?.trim();
  // 令牌来源：显式令牌是「运维手上那把钥匙」，AuthTokenSource（令牌文件）是「可批量撤销的设备钥匙」。
  // 两者都支持；都为空 ⇒ 不启用鉴权（回环下的合法形态）。
  const explicitTokenSource: AuthTokenSource | undefined = explicitToken
    ? {
        enabled: true,
        verify: (candidate) => candidate === explicitToken,
        snapshot: () => ({ count: 1, labels: ["<env>"] }),
        labelFor: (candidate) => (candidate === explicitToken ? "<env>" : undefined),
      }
    : undefined;
  const tokenSource = options.tokenSource ?? explicitTokenSource;
  const trustedOrigins = parseTrustedOrigins(options.trustedOrigins?.join(","));
  const trustedProxies = options.trustedProxies ?? [];
  // Host 白名单（G6）：默认 = 回环各形态 + 本机网卡地址 + 实际监听地址；运维显式登记追加其后。
  // **必须在下面的 fail-closed 检查之前算好**：登记项本身就是一个"这东西会被外部访问"的信号
  // （见 exposureGate.ts），而判据的唯一来源是**最终生效的条目**（按 label 区分默认项与登记项），
  // 不是"环境变量有没有被设置" —— 一个被丢弃的非法值不该触发拒绝启动。
  const trustedHostEntries =
    options.trustedHostEntries ??
    buildTrustedHostEntries({
      configuredEntries: options.trustedHosts ?? [],
      listenHost: host,
    });
  const configuredTrustedHosts = trustedHostEntries.filter((entry) => entry.label === "configured");
  // 启动期断言：ROUTE_POLICY 的「受保护」标注必须与 isTokenProtectedPath 实现一致（G11）。
  // 保持它**先于**监听安全检查：这是与用户配置无关的**代码一致性**断言，口径不一致时必须先被报出来，
  // 而不是被一个配置问题（例如"回环 + 无令牌 + 有信号"）先挡掉、让人误以为代码本身没问题。
  assertRoutePolicyEnforced();
  // fail-closed 的唯一所有者：非回环 + 无令牌 ⇒ 拒绝；**回环 + 外部访问信号 + 无令牌 ⇒ 也拒绝**。
  assertListenSecurity({
    host,
    ...(explicitToken ? { authToken: explicitToken } : {}),
    authSourceConfigured: Boolean(options.tokenSource || explicitToken),
    authSourceEnabled: Boolean(tokenSource?.enabled),
    trustedProxies,
    configuredTrustedHosts,
    trustedOrigins,
  });
  const throttle =
    options.throttle ??
    createAuthThrottle({ warn: (address, message) => warn(message + "（" + address + "）") });
  // bot 入站面的**独立**限流桶（spec §4.2）。为什么不共用既有的 throttle：
  //   ① 共享会造出一条今天不存在的**跨面拒绝服务** —— 令牌面的封禁闸门是 app.use("*")
  //      且不看路径，实测「3 次 /api 失败后 GET /tasks 与 POST /bot/webhook 都变 403」；
  //      若共用，则「有人暴力猜 bot secret」会连带封掉该地址的 /api/** 与 SPA 壳。
  //   ② 两个凭据空间（lite token / bot secret）的失败**互不携带信息**，合并计数是把
  //      两个独立威胁模型混成一个计数器。
  //   ③ 反代/隧道后所有客户端共用一个对端地址 ⇒ 共享桶下「别人扫我」会让我的机器人掉线。
  // 阈值与口径**复用** createAuthThrottle 默认值（10 次 / 5 分钟 ⇒ 封 15 分钟），不新造。
  const botIngressThrottle =
    options.botIngressThrottle ??
    createAuthThrottle({
      warn: (address, message) => warn(message + "（bot 入站面，" + address + "）"),
    });
  // 审计日志（B1）：与 warn 分开的一条结构化流（一行一条 JSON，便于 grep/journald 采集）。
  const audit = options.audit ?? createAuditLog();
  if (!options.audit) {
    // 退出前把窗口内的计数写出来（否则最后 <60s 的合并计数会随进程消失）。
    // 只在本函数**自己创建** audit 时挂：注入方（如 entry-http）希望自己掌握生命周期。
    const flushAudit = () => audit.flush();
    process.once("SIGTERM", flushAudit);
    process.once("SIGINT", flushAudit);
  }
  const maxConcurrentConnections =
    options.maxConcurrentConnections ?? DEFAULT_MAX_CONCURRENT_CONNECTIONS;
  /** 当前活跃的 WebSocket 连接（含即将升级的），用于并发上限与 close 事件配对。 */
  const activeConnections = new Map<
    string,
    { role: string; peer: string; authenticated: boolean; startedAt: number }
  >();
  // 运行期暴露面告警：只在首次遇到「非回环对端 + 非 TLS」时提示一次（不拒绝请求）。
  let plainHttpPeerWarned = false;
  app.use("*", async (c, next) => {
    if (!plainHttpPeerWarned) {
      const warning = buildPlainHttpPeerWarning({
        remoteAddress: resolvePeerAddress(c, trustedProxies),
        secure: isSecureRequest(c),
      });
      if (warning) {
        plainHttpPeerWarned = true;
        warn(warning);
      }
    }
    await next();
  });
  // 安全响应头必须注册在**最外层**（先执行、最后写头）：它要覆盖包括「被来源校验拒绝的响应」
  // 在内的所有响应 —— 尤其是 WS 的 403，那条响应不经过任何后面的中间件。
  const securityHeadersOptions = {
    hsts: options.hsts ?? false,
    cspMode: options.cspMode ?? "report-only",
    secure: false,
  } as const;
  app.use("*", createSecurityHeaders(securityHeadersOptions));
  // Host 白名单（G6）：**排在最前面**，它是唯一能区分「浏览器以为在跟 evil.com 说话，其实在跟本机说话」
  // 的信号；来源校验做不到这一点（rebinding 时 Origin 与 Host 自洽）。顺序理由：Host 是请求的基本
  // 属性，连"这是发给谁的请求"都没确认之前，不该继续走后续任何判定。
  const hostGuardWarned = new Set<string>();
  app.use("*", async (c, next) => {
    const decision = evaluateHost(c.req.header("host"), trustedHostEntries);
    if (decision.allowed) {
      await next();
      return;
    }
    const hostHeader = c.req.header("host") ?? "<missing>";
    const pathname = new URL(c.req.url).pathname;
    // 每台主机名只告警一次：扫描器会持续打不同的 Host，不能让日志被淹没。
    if (!hostGuardWarned.has(hostHeader)) {
      hostGuardWarned.add(hostHeader);
      warn(
        "[host-allowlist] 已拒绝 Host=" +
          hostHeader +
          " 的请求（" +
          c.req.method +
          " " +
          pathname +
          "）。这是 DNS rebinding 防护；若这是你的反代域名，请登记进 ZCODE_SERVER_TRUSTED_HOSTS。",
      );
    }
    // 审计：Host 被拒（**记录解析后的对端地址**；Host 头本身是攻击者可控的，写进来便于排障但不作键）。
    audit.record({
      kind: "audit:host-rejected",
      peer: resolvePeerAddress(c, trustedProxies) ?? "unknown",
      method: c.req.method,
      path: pathname,
      reason: "Host 不在白名单（DNS rebinding 防护）",
    });
    return c.json({ error: decision.reason ?? "Host not allowed" }, 403, {
      "X-ZCode-Host-Rejected": "1",
      ...buildSecurityHeaders(securityHeadersOptions),
    });
  });
  // 来源校验排在令牌中间件**之前**：跨站 + 未授权的请求应得到明确的 403（跨站），
  // 而不是先被令牌层拦成 401 —— 否则运维无法区分「没带凭据」与「带了凭据但被跨站利用」。
  // denialHeaders 是必须的：这条 403 是**独立返回**的，后续中间件不会跑到它（见其注释）。
  app.use(
    "*",
    createCrossSiteGuard({
      trustedOrigins,
      warn,
      denialHeaders: () => buildSecurityHeaders(securityHeadersOptions),
      // 审计：跨站被拒（Origin 与 Host 是**不同防线**，所以要分开记事件类型，便于事后区分
      // "有人从别的站点发起请求" 与 "有人在用伪造 Host 做 rebinding"）。
      onReject: (params) => {
        audit.record({
          kind: "audit:origin-rejected",
          // 用与限流**同一口径**解析对端（可信代理规则），保证"谁被限流"与"谁在审计里"能对上。
          peer:
            resolveClientAddress({
              socketAddress: params.socketPeer,
              forwardedFor: params.forwardedFor,
              trustedProxies,
            }) ?? "unknown",
          method: params.method,
          path: params.path,
          reason: "Origin 与 Host 不同源（跨站请求防护）",
        });
      },
    }),
  );
  // IM 机器人**入站**面（/bot/**）：**注册在令牌中间件之前**，并自行终结请求（不 next）。
  //
  // 为什么在之前（不是「在令牌中间件里加一条让路判断」）：
  // 令牌面的封禁闸门是 app.use("*") 且在路径分派**之前**执行，它**不看路径** ⇒
  // 若本 gate 注册在其后，一个被令牌面封禁的地址打 /bot/** 会拿到 403 而不是 404
  // （「渠道未启用」的语义），且 bot 入站会被令牌面的封禁**误伤**。
  // 放在之前 ⇒ **既有令牌中间件零改动**，隔离是**结构性**的而非条件式的。
  // 详见 botIngress.ts 的文件头与 .reverse/93-bot-ingress/BOT-INGRESS-SPEC.md §4.3（方案 D1）。
  //
  // 无条件注册：未启用时 gate 在第一个判断就返回 c.notFound()，**零 I/O**，与
  // 「这条路由根本不存在」逐字节相同（spec §8.4 R3/R15）⇒ 默认攻击面为零。
  const botIngressGate = createBotIngressGate(services, {
    enabled: options.botIngress?.enabled ?? false,
    // **独立**限流桶：与令牌面共享会让「有人猜 bot secret」连带封掉 /api/** 与 SPA 壳
    // （实测：令牌面封禁后 GET /tasks 也变 403）。见 spec §4.2。
    throttle: botIngressThrottle,
    audit,
    warn,
    trustedProxies,
    ...(options.botIngress?.maxBodyBytes !== undefined
      ? { maxBodyBytes: options.botIngress.maxBodyBytes }
      : {}),
  });
  // Hono 里 app.use("/bot/*", ...) 的 * 同时覆盖 /bot、/bot/、/bot/x（实测：spec §8.4 R3）。
  // 只挂这一条，不再单独挂 /bot。
  app.use("/bot/*", botIngressGate);

  // 每个请求的鉴权上下文：对端地址 + 是否已记过一次失败。
  // 用 WeakMap 而不是可变闭包变量：闭包变量会在并发请求间串味（同一个中间件实例服务所有请求）。
  const perRequestAuth = new WeakMap<
    Context,
    { peer?: string; failureRecorded: boolean; authenticated?: boolean; tokenLabel?: string }
  >();
  if (tokenSource?.enabled) {
    app.use("*", async (c, next) => {
      const pathname = new URL(c.req.url).pathname;
      const peer = resolvePeerAddress(c, trustedProxies);
      // ⓪ 限流闸门：被封禁的地址在做任何校验之前就被拒（按地址计数 ⇒ 暴力破解被截断）。
      const gate = throttle.check(peer);
      if (!gate.allowed) {
        warn(
          "已拒绝来自被封禁地址的请求（剩余 " +
            String(Math.ceil((gate.retryAfterMs ?? 0) / 1000)) +
            " 秒）：" +
            pathname,
        );
        return c.json(
          {
            error:
              "Too many failed authentication attempts. This client address is temporarily blocked.",
          },
          403,
        );
      }
      const validToken = hasValidLiteToken(c, tokenSource);
      if (!isTokenProtectedPath(pathname) || validToken) {
        if (validToken) {
          // 成功即清零：正常用户的偶发输错不会累积到阈值（阈值只拦持续失败的暴力破解）。
          throttle.recordSuccess(peer);
        }
        // 令牌**标签**（不是令牌）随请求上下文带下去，供连接级审计（`audit:ws-open`）使用。
        const tokenLabel =
          validToken && tokenSource
            ? tokenSource.labelFor(
                new URL(c.req.url).searchParams.get("token") ??
                  parseCookieHeader(c.req.header("cookie")).get(zcodeLiteTokenCookieName),
              )
            : undefined;
        perRequestAuth.set(c, {
          ...(peer ? { peer } : {}),
          failureRecorded: false,
          authenticated: validToken,
          ...(tokenLabel ? { tokenLabel } : {}),
        });
        await next();
        return;
      }
      // ① 鉴权失败：计数 + 可观测（修改前这条链路上没有任何失败记录，入侵完全静默）。
      const banned = throttle.recordFailure(peer);
      perRequestAuth.set(c, { ...(peer ? { peer } : {}), failureRecorded: true });
      // 审计：鉴权失败（**不写令牌、不写查询串** —— 只写路径与解析后的对端地址）。
      audit.record({
        kind: "audit:auth-failure",
        peer: peer ?? "unknown",
        method: c.req.method,
        path: pathname,
        reason: isTokenProtectedPath(pathname) ? "令牌无效或缺失" : "未授权路径",
        ...(banned ? {} : {}),
      });
      if (banned) {
        // 审计：封禁（与失败分开记一条，便于只看封禁事件）。
        audit.record({
          kind: "audit:auth-ban",
          peer: peer ?? "unknown",
          path: pathname,
          reason: "同一地址连续失败达到阈值，已临时封禁",
        });
      }
      warn(
        "鉴权失败（" +
          (banned ? "已触发封禁" : "累计 " + String(throttle.failureCount(peer ?? "")) + " 次") +
          "）：" +
          c.req.method +
          " " +
          pathname +
          "，对端=" +
          (peer ?? "unknown"),
      );
      // ② 反代形态下的**误伤风险**必须说出来：未声明可信代理时，反代后的所有客户端都表现为
      //    回环地址 ⇒ 一个客户端的失败会把这唯一一个计数桶封掉，整台机器（含正常用户）
      //    在封禁期内全部 403。这不是「不可能发生」，而是「配了反代却没配
      //    ZCODE_SERVER_TRUSTED_PROXIES」时的默认现象，所以必须给出可操作的修法。
      if (banned && isLoopbackHost(peer ?? "") && trustedProxies.length === 0) {
        warn(
          "注意：被封禁的是回环地址，且未配置 ZCODE_SERVER_TRUSTED_PROXIES —— " +
            "若你在反向代理之后部署，所有客户端目前共用同一个计数桶，" +
            "任何人的连续失败都会让**所有人**在封禁期内被拒绝。" +
            "请把反代地址登记进 ZCODE_SERVER_TRUSTED_PROXIES（例如 127.0.0.1），" +
            "让限流按真实客户端地址计数。",
        );
      }
      return c.json({ error: "Unauthorized" }, 401);
    });
  }

  app.get("/api/server-info", async (c) => c.json(await createServerInfo(options, services)));
  app.post("/api/rpc-host-capability", (c) => c.json(hostCapabilities.issue()));

  /**
   * 组装连接级审计上下文。
   *
   * 在 `createEvents(c)` 里调用（那时还能拿到 Hono `Context`）：令牌标签 / 是否已鉴权来自
   * 令牌中间件写下的 `perRequestAuth`；对端地址用与限流**同一口径**重新解析（可信代理规则）。
   */
  const buildConnectionAuditContext = (c: Context): ConnectionAuditContext => {
    const requestUrl = new URL(c.req.url);
    const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
    const peer =
      resolveClientAddress({
        socketAddress: env?.incoming?.socket?.remoteAddress,
        forwardedFor: c.req.header("x-forwarded-for"),
        trustedProxies,
      }) ?? "unknown";
    const auth = perRequestAuth.get(c);
    return {
      audit,
      activeConnections,
      peer: auth?.peer ?? peer,
      path: requestUrl.pathname,
      authenticated: auth?.authenticated ?? !tokenSource?.enabled,
      ...(auth?.tokenLabel ? { tokenLabel: auth.tokenLabel } : {}),
    };
  };

  // 普通 `/ws` 永远是 terminal-client；浏览器/任意客户端设置旧 mode header
  // 都不能再把自己提升为 trusted host。
  app.get(
    "/ws",
    upgradeWebSocket((c) => {
      // `createEvents` 在升级时执行，是我们还能拿到 Context 的最后一站 ⇒ 审计上下文在这里算好。
      const auditContext = buildConnectionAuditContext(c);
      return {
        onOpen(_event, ws) {
          setupChannelServer(ws.raw as WebSocket, services, "web-remote-replayable", auditContext);
        },
      };
    }),
  );

  const upgradeTrustedHostWebSocket = upgradeWebSocket((c) => {
    const auditContext = buildConnectionAuditContext(c);
    return {
      onOpen(_event, ws) {
        setupChannelServer(ws.raw as WebSocket, services, "desktop-continuous", auditContext);
      },
    };
  });
  app.use("/ws/host", async (c, next) => {
    const capability = c.req.header(ZCODE_RPC_HOST_CAPABILITY_HEADER);
    if (!hostCapabilities.consume(capability)) {
      // 票据失败也要计数：有效令牌 + 反复猜票据同样是鉴权暴力破解的一种形态。
      // 只在令牌层没记过时补记，避免同一请求被计两次。
      const auth = perRequestAuth.get(c);
      if (tokenSource?.enabled && !auth?.failureRecorded) {
        throttle.recordFailure(auth?.peer ?? resolvePeerAddress(c, trustedProxies));
      }
      return c.json({ error: "Invalid or expired host capability" }, 401);
    }
    await next();
  });
  app.get("/ws/host", upgradeTrustedHostWebSocket);

  // Web 模式下发起远程连接
  app.post("/api/connect-remote", async (c) => {
    const rawBody = await c.req.json();
    const parsedBody = remoteTargetSchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return c.json({ error: `Invalid request body: ${formatZodError(parsedBody.error)}` }, 400);
    }
    const body = parsedBody.data;

    try {
      const backend = await createRemoteBackend(body);
      const connection = await connectRemote(backend);
      const id = generateId();
      remoteConnections.set(id, connection);

      return c.json({ id });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  // 远程连接的 WebSocket 端点，将远程 services 桥接给浏览器
  app.get(
    "/ws/remote/:id",
    upgradeWebSocket((c) => {
      const id = c.req.param("id");
      const auditContext = buildConnectionAuditContext(c);
      return {
        onOpen(_event, ws) {
          if (!id) {
            ws.close(4000, "Missing remote connection id");
            return;
          }
          const connection = remoteConnections.get(id);
          if (!connection) {
            ws.close(4004, "Remote connection not found");
            return;
          }
          // 一个连接只给一个 WS 客户端使用，取出后从 Map 移除
          remoteConnections.delete(id);

          // 将远程 services 包装为 ServiceCollection，复用 exposeOnChannelServer 统一注册
          const remoteServices = new ServiceCollection()
            .register(IFileService, connection.services.fileService)
            .register(IGitService, connection.services.gitService)
            .register(ISystemService, connection.services.systemService)
            .register(ITerminalService, connection.services.terminalService);

          setupChannelServer(
            ws.raw as WebSocket,
            remoteServices,
            "web-remote-replayable",
            auditContext,
          );
        },
      };
    }),
  );

  if (options.staticRoot?.trim()) {
    const staticRoot = options.staticRoot.trim();
    app.get("*", async (c) => {
      const pathname = new URL(c.req.url).pathname;
      const filePath = await resolveStaticFile(staticRoot, pathname, options.spaFallback ?? true);
      if (!filePath) {
        return c.notFound();
      }
      return c.body(await readFile(filePath), 200, {
        "Cache-Control": filePath.endsWith("index.html")
          ? "no-cache"
          : "public, max-age=31536000, immutable",
        "Content-Type": staticContentType(filePath),
      });
    });
  }

  const server = serve({ fetch: app.fetch, hostname: host, port }, () => {
    const address = server.address();
    const listenPort = typeof address === "object" && address ? address.port : port;
    // 打印真实 bind 地址：此前用 options.host 兜底成 "localhost"，
    // 与「未指定 = 绑所有网卡」的实际行为不符（误导用户以为只在本机可达）。
    const urlHost = host.includes(":") ? `[${normalizeListenHost(host)}]` : host;
    log(`http://${urlHost}:${listenPort}`);
    if (trustedOrigins.length > 0) {
      log(`cross-site allowlist: ${trustedOrigins.join(", ")}`);
    }
    const tokenCount = tokenSource?.snapshot().count ?? 0;
    log(
      isLoopbackHost(host)
        ? `bind=${host} scope=loopback-only token-auth=${tokenSource?.enabled ? "enabled" : "disabled"}`
        : `bind=${host} scope=non-loopback token-auth=enabled (非回环绑定的 fail-closed 前置检查已通过)
`,
    );
    if (tokenSource?.enabled && tokenCount > 1) {
      // 多令牌是「可批量撤销」的前提：打印条数与标签（**绝不打印令牌本身**）便于核对。
      log(`token source: ${String(tokenCount)} 条（${tokenSource.snapshot().labels.join(", ")}）`);
    }
    // 打印生效的 Host 白名单（**这是排障的关键信息**：反代域名没登记时，用户看到 403 却不知道
    // 该写进哪个变量；启动日志直接给出来）。
    const bySource = trustedHostEntries.reduce<Record<string, string[]>>((accumulator, entry) => {
      const list = accumulator[entry.label] ?? [];
      list.push(entry.port === undefined ? entry.host : entry.host + ":" + String(entry.port));
      accumulator[entry.label] = list;
      return accumulator;
    }, {});
    log(
      "trusted hosts: " +
        Object.entries(bySource)
          .map(([label, hosts]) => label + "=[" + hosts.join(",") + "]")
          .join(" "),
    );
    if (trustedProxies.length > 0) {
      log(`trusted proxies: ${String(trustedProxies.length)} 条（采信 X-Forwarded-For）`);
    } else {
      // 默认不采信 XFF：运维若把反代配上了却不知道这一点，会看到「限流按反代 IP 计数」的现象。
      log("trusted proxies: 未配置 ⇒ 不采信 X-Forwarded-For，对端地址一律取 socket");
    }
    const exposureWarning = buildNonLoopbackListenWarning({
      host,
      port: listenPort,
      tokenAuth: Boolean(tokenSource?.enabled),
    });
    if (exposureWarning) warn(exposureWarning);
    // 有"会被外部访问"的信号、却没有任何可用令牌时的告警（**不改行为**）。
    // 可达条件（唯一一份口径在 exposureGate.ts，由测试的矩阵用例逐格钉住）：A 类信号
    // （可信代理 / 登记域名）与"非回环 + 无令牌"这两档都已在 assertListenSecurity 里被**拒绝启动**，
    // 因此能走到这里的**唯一**形态是：**回环 + 只有 ZCODE_SERVER_TRUSTED_ORIGINS 这一条信号
    // + 没有任何可用令牌**。那时服务能起来，而被放行的那个来源拿到的是没有鉴权的完整控制权。
    const proxySignalWarning = buildProxySignalWithoutTokenWarning({
      host,
      signals: collectExposureSignals({
        trustedProxies,
        configuredTrustedHosts,
        trustedOrigins,
      }),
      tokenSourceEnabled: Boolean(tokenSource?.enabled),
      loopback: isLoopbackHost(host),
    });
    if (proxySignalWarning) warn(proxySignalWarning);
  });

  // WebSocket 的来源校验必须挂在 **HTTP 升级事件**上，而不是 Hono 中间件里：
  // @hono/node-ws 的升级适配器只取响应状态码、自己拼一条 Content-Length: 0 的响应，
  // 在 fetch 层返回的 403 会把响应体与安全响应头一起丢掉（实测见 webOriginGuard.test.ts）。
  // 因此这里先于 injectWebSocket 挂自己的 upgrade 监听：拒绝的直接写 socket 并结束，
  // 放行的**不处理**（不消费 socket），交给随后注册的 node-ws 监听器正常升级。
  const upgradeGuardWarned = new Set<string>();
  /** 连接上限告警只打一次（这是"持续被拒"的稳定状态，不该刷屏）。 */
  let connectionLimitWarned = false;
  // 被本 gate 拒绝的升级请求要在 socket 上留标记：@hono/node-ws 的监听器随后仍会被调用，
  // 它会往已 end 的 socket 再写一次响应（实测崩法：ERR_STREAM_WRITE_AFTER_END）。
  // 所以 gate **之后**注册的每个 upgrade 监听器都被包一层「已拒绝就跳过」。
  const rejectedUpgradeSockets = new WeakSet<Duplex>();
  type UpgradeListener = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
  const installGuardedUpgradeListener = (listener: UpgradeListener): void => {
    server.on("upgrade", (request, socket, head) => {
      if (rejectedUpgradeSockets.has(socket)) {
        return;
      }
      listener(request, socket, head);
    });
  };
  const wrapPendingUpgradeListeners = (): void => {
    for (const listener of server.listeners("upgrade")) {
      server.removeListener("upgrade", listener);
      installGuardedUpgradeListener(listener as UpgradeListener);
    }
  };
  // Host 白名单与来源校验一样必须在**这一层**做：`/ws` 的升级请求绕过 Hono 中间件链里的响应通道，
  // 中间件里返回的 403 会被 node-ws 的适配器丢掉响应体与响应头（A-1 的实测教训）。
  const upgradeHostRejected = new Set<string>();
  server.on("upgrade", (request, socket) => {
    const pathname = new URL(request.url ?? "/", "http://placeholder").pathname;
    // ① Host 白名单（G6）：先于来源判定 —— rebinding 的请求 Host 是攻击者的域名，
    //    而它的 Origin 与 Host 自洽，只有这一步能拦住。
    const socketPeer = request.socket.remoteAddress;
    const upgradePeer =
      resolveClientAddress({
        socketAddress: socketPeer,
        forwardedFor: request.headers["x-forwarded-for"],
        trustedProxies,
      }) ?? "unknown";
    const hostDecision = evaluateHost(request.headers.host, trustedHostEntries);
    if (!hostDecision.allowed) {
      const hostHeader = request.headers.host ?? "<missing>";
      if (!upgradeHostRejected.has(hostHeader)) {
        upgradeHostRejected.add(hostHeader);
        warn(
          "[host-allowlist] 已拒绝 Host=" +
            hostHeader +
            " 的 WebSocket 升级 " +
            pathname +
            "（DNS rebinding 防护；反代域名请登记进 ZCODE_SERVER_TRUSTED_HOSTS）",
        );
      }
      audit.record({
        kind: "audit:host-rejected",
        peer: upgradePeer,
        path: pathname,
        reason: "Host 不在白名单（DNS rebinding 防护，WebSocket 升级）",
      });
      rejectedUpgradeSockets.add(socket);
      rejectUpgrade({
        socket,
        reason: hostDecision.reason ?? "Host not allowed",
        extraHeaders: {
          "X-ZCode-Host-Rejected": "1",
          ...buildSecurityHeaders(securityHeadersOptions),
        },
      });
      return;
    }
    // ② 并发上限（B3）：**防资源耗尽**，与限流（按地址、防爆破）职责不同。
    //    语义：拒绝**新**连接（403 + 明确原因），已建立的连接不受影响；不做排队
    //    （排队等于让攻击者用队首阻塞合法用户）。检查放在来源判定**之前**：
    //    连接洪水的第一诉求是"立刻止血"，而不是先给每个请求算一遍来源。
    if (activeConnections.size >= maxConcurrentConnections) {
      if (!connectionLimitWarned) {
        connectionLimitWarned = true;
        warn(
          "已拒绝新的 WebSocket 连接：当前活跃连接数达到上限 " +
            String(maxConcurrentConnections) +
            "。这是资源保护（防连接洪水）；如确有需要请调大上限或先排查异常连接。",
        );
      }
      audit.record({
        kind: "audit:connection-limit-rejected",
        peer: upgradePeer,
        path: pathname,
        reason: "活跃连接数达到上限",
        connections: activeConnections.size,
        maxConnections: maxConcurrentConnections,
      });
      rejectedUpgradeSockets.add(socket);
      rejectUpgrade({
        socket,
        reason:
          "Too many active WebSocket connections (limit " +
          String(maxConcurrentConnections) +
          "). Retry later or raise the server's concurrent-connection limit.",
        extraHeaders: {
          "X-ZCode-Connection-Limit": "1",
          ...buildSecurityHeaders(securityHeadersOptions),
        },
      });
      return;
    }
    // ③ 来源校验（跨站请求）。
    const decision = evaluateUpgradeOrigin(
      {
        pathname,
        originHeader: request.headers.origin,
        hostHeader: request.headers.host,
        protocol: "http:",
        requestUrl: "http://" + (request.headers.host ?? "placeholder") + (request.url ?? "/"),
      },
      trustedOrigins,
    );
    if (decision.allowed) {
      return;
    }
    audit.record({
      kind: "audit:origin-rejected",
      peer: upgradePeer,
      path: pathname,
      reason: "Origin 与 Host 不同源（跨站请求防护，WebSocket 升级）",
    });
    if (!upgradeGuardWarned.has(pathname)) {
      upgradeGuardWarned.add(pathname);
      warn(
        "[cross-site] 已拒绝跨站 WebSocket 升级 " +
          pathname +
          "（Origin=" +
          (request.headers.origin ?? "") +
          "，对端=" +
          (request.headers["x-forwarded-for"] ?? "socket") +
          "）",
      );
    }
    rejectedUpgradeSockets.add(socket);
    rejectUpgrade({
      socket,
      reason: decision.reason ?? "Cross-site WebSocket upgrade rejected",
      extraHeaders: {
        "X-ZCode-Cross-Site-Rejected": "1",
        ...buildSecurityHeaders(securityHeadersOptions),
      },
    });
  });

  // injectWebSocket 注册的 node-ws 监听器同样要包一层，否则被拒的 socket 会被它二次写入。
  injectWebSocket(server);
  wrapPendingUpgradeListeners();

  return server;
}
