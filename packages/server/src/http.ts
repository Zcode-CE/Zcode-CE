/* eslint-disable max-lines -- HTTP、WebSocket 与静态资源路由集中注册，保持同一鉴权顺序。 */
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
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

function setupChannelServer(
  ws: WebSocket,
  services: ServiceCollection,
  clientMode: "desktop-continuous" | "web-remote-replayable",
) {
  const socket = wrapWebSocket(ws);
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
    void connectionScope?.dispose();
    rawServer.dispose();
  });
}

/** 存储 web 模式下的远程连接，key 为随机 ID */
const remoteConnections = new Map<string, RemoteConnection>();

function generateId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

interface HttpServerOptions {
  serverId?: string;
  name?: string;
  host?: string;
  authRequired?: boolean;
  authToken?: string;
  spaFallback?: boolean;
  staticRoot?: string;
  workspaces?: ServerRemoteWorkspaceInfo[];
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

function resolveServerWorkspaces(options: HttpServerOptions): ServerRemoteWorkspaceInfo[] {
  if (options.workspaces) {
    return options.workspaces;
  }
  const workspacePath = readTrimmedEnv("ZCODE_SERVER_WORKSPACE") || process.cwd();
  return [
    {
      path: workspacePath,
      label: basename(workspacePath) || workspacePath,
    },
  ];
}

function createServerInfo(options: HttpServerOptions): ServerRemoteInfo {
  return {
    serverId: resolveServerId(options),
    ...(options.name?.trim() || readTrimmedEnv("ZCODE_SERVER_NAME")
      ? { name: options.name?.trim() || readTrimmedEnv("ZCODE_SERVER_NAME") }
      : {}),
    version: ZCODE_VERSION,
    protocolVersion: SERVER_REMOTE_PROTOCOL_VERSION,
    authRequired: options.authRequired ?? Boolean(readTrimmedEnv("ZCODE_SERVER_TOKEN")),
    workspaces: resolveServerWorkspaces(options),
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

function hasValidLiteToken(c: Context, token: string): boolean {
  const url = new URL(c.req.url);
  if (url.searchParams.get("token") === token) {
    c.header("Set-Cookie", buildLiteTokenCookie(token, isSecureRequest(c)));
    return true;
  }
  return parseCookieHeader(c.req.header("cookie")).get(zcodeLiteTokenCookieName) === token;
}

/**
 * 需要令牌的路径前缀。
 *
 * 注意 /api 与 /ws 的**精确路径**也必须算在内：此前只认 /api/ 前缀与 /ws 精确值，
 * 于是 GET /api（无尾斜杠）落到静态 SPA fallback 返回了 index.html（200）—— 不泄漏业务数据，
 * 但鉴权口径应当 fail-closed（/api 是 API 命名空间本身，不该被静态兜底接走）。
 */
function isTokenProtectedPath(pathname: string): boolean {
  return (
    pathname === "/ws" ||
    pathname === "/api" ||
    pathname.startsWith("/ws/") ||
    pathname.startsWith("/api/")
  );
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
export function assertListenSecurity(options: { host: string; authToken?: string }): void {
  if (isLoopbackHost(options.host) || options.authToken?.trim()) {
    return;
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
  const authToken = options.authToken?.trim();
  assertListenSecurity({ host, authToken });
  if (authToken) {
    app.use("*", async (c, next) => {
      const pathname = new URL(c.req.url).pathname;
      const validToken = hasValidLiteToken(c, authToken);
      if (!isTokenProtectedPath(pathname) || validToken) {
        await next();
        return;
      }
      return c.json({ error: "Unauthorized" }, 401);
    });
  }

  app.get("/api/server-info", (c) => c.json(createServerInfo(options)));
  app.post("/api/rpc-host-capability", (c) => c.json(hostCapabilities.issue()));

  // 普通 `/ws` 永远是 terminal-client；浏览器/任意客户端设置旧 mode header
  // 都不能再把自己提升为 trusted host。
  app.get(
    "/ws",
    upgradeWebSocket(() => ({
      onOpen(_event, ws) {
        setupChannelServer(ws.raw as WebSocket, services, "web-remote-replayable");
      },
    })),
  );

  const upgradeTrustedHostWebSocket = upgradeWebSocket(() => ({
    onOpen(_event, ws) {
      setupChannelServer(ws.raw as WebSocket, services, "desktop-continuous");
    },
  }));
  app.use("/ws/host", async (c, next) => {
    const capability = c.req.header(ZCODE_RPC_HOST_CAPABILITY_HEADER);
    if (!hostCapabilities.consume(capability)) {
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

          setupChannelServer(ws.raw as WebSocket, remoteServices, "web-remote-replayable");
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
    log(
      isLoopbackHost(host)
        ? `bind=${host} scope=loopback-only token-auth=${authToken ? "enabled" : "disabled"}`
        : `bind=${host} scope=non-loopback token-auth=enabled (非回环绑定的 fail-closed 前置检查已通过)`,
    );
  });

  injectWebSocket(server);

  return server;
}
