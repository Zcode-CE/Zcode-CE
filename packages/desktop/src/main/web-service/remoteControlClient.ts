import type {
  RemoteControlConnection,
  RemoteControlConnectionRole,
  RemoteControlConnectionsPayload,
  RemoteControlRevokeRequest,
  RemoteControlRevokeResult,
  RemoteControlRotateTokenResult,
} from "@zcode/shared";
import type { WebServiceStatus } from "./service.js";
import { readWebServiceToken } from "./token.js";

/**
 * 连接面（谁连着）的 main 侧客户端 —— 真的去调本机服务端的 HTTP 端点（spec §6.4）。
 *
 * ## 为什么要有这一层
 *
 * 渲染进程不能直接请求服务端：服务端凭据是令牌，而令牌只经
 * connectionInfo 的 linkWithToken 交给渲染进程（契约 §5 的令牌不变式）。
 * 让渲染进程拿令牌去发请求，等于把凭据从"一次性展示"变成"可编程使用"。
 * 所以由 main 进程内部带上令牌去请求，只把结果（不含令牌）转给渲染进程。
 *
 * ## 鉴权方式：为什么用 `?token=` 而不是 `Authorization: Bearer`
 *
 * 服务端的令牌中间件（`packages/server/src/http.ts:505-516` 的 `hasValidLiteToken`）
 * 只认两种来源：URL 的 `?token=` 查询参数，或 cookie `zcode_lite_token`。
 * 实测 `packages/server/src` 下 `authorization` / `Bearer` 0 命中 ⇒ 发 Bearer 头
 * 不会被识别，只会得到 401（然后被下面的 fail-closed 判成"读不到"）。
 *
 * 这里选 `?token=` 而不是 cookie，理由是不依赖服务端私有常量：
 * `?token=` 是已经在承重的公开机制（`connectionInfo` 自己就拼 `?token=` 链接，
 * 见 `service.ts` 的 `linkWithToken`），而 cookie 名 `zcode_lite_token` 是 http.ts 的
 * 模块内常量、未导出 —— 抄一份到 desktop 会构成跨包耦合到实现细节，且它改名时会静默失效。
 *
 * 残余风险（如实写清）：令牌因此出现在请求 URL 里。它不离开 main 进程 ——
 * 请求由 main 自己发起、不经过任何日志：本模块不打印 URL；
 * 服务端侧审计只写 `pathname`、不写 `search`（`auditLog.ts` 文件头明写），
 * 且 `http.ts` 没有任何一处记录 `c.req.url`（grep 实测）。
 *
 * ## 令牌不变式（本文件是守门人）
 *
 * 出站载荷逐字段重建、绝不展开服务端返回的 JSON 对象 ——
 * 于是"服务端将来多返回一个 token 字段"也不可能顺着这条链路漏到渲染进程。
 * 这比"记得删掉令牌字段"强：前者是结构性的，后者要靠每次改动都不忘。
 */

/** 连接面请求的超时。与探活的 1500ms 分开：探活要快（决定 UI 结论），这里可以稍宽。 */
export const REMOTE_CONTROL_REQUEST_TIMEOUT_MS = 5_000;

export interface WebServiceConnectionPlaneDeps {
  /**
   * 读当前服务状态。只有 `running` 才有可用端点 —— 复用 controller 的探活结论，
   * 不自己再探一次（两套判据迟早不一致）。
   */
  status: () => Promise<WebServiceStatus>;
  /** 令牌文件路径（`resolveWebServiceTokenPath()`）。 */
  tokenPath: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface WebServiceConnectionPlane {
  /** 读连接清单。`null` = 不知道（服务没在跑 / 鉴权失败 / 响应形状不对）。 */
  list: () => Promise<RemoteControlConnectionsPayload | null>;
  revoke: (input: RemoteControlRevokeRequest) => Promise<RemoteControlRevokeResult>;
  rotateToken: () => Promise<RemoteControlRotateTokenResult>;
}

const CONNECTION_ROLES: readonly RemoteControlConnectionRole[] = [
  "terminal-client",
  "trusted-host",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * 把服务端的一行重建成 `RemoteControlConnection`（白名单字段，逐个类型校验）。
 *
 * 为什么重建而不是直接透传：透传会让服务端（或中间任何一环）多出来的字段
 * 自动流到渲染进程 —— 包括将来的某个凭据字段。重建是结构性的保证。
 */
function parseConnection(value: unknown): RemoteControlConnection | null {
  if (!isRecord(value)) return null;
  const { id, address, role, userAgent, connectedAt, workspace } = value;
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof address !== "string") return null;
  if (typeof role !== "string" || !CONNECTION_ROLES.includes(role as RemoteControlConnectionRole)) {
    return null;
  }
  if (typeof userAgent !== "string") return null;
  if (typeof connectedAt !== "number" || !Number.isFinite(connectedAt)) return null;
  if (workspace !== undefined && typeof workspace !== "string") return null;
  return {
    id,
    address,
    role: role as RemoteControlConnectionRole,
    userAgent,
    connectedAt,
    ...(workspace === undefined ? {} : { workspace }),
  };
}

/**
 * 校验整个 200 响应。
 *
 * 任一行畸形 ⇒ 整份判成"不知道"（返回 null），而不是丢掉坏行给出半份清单：
 * 半份清单会让 UI 宣称"目前有 N 台连着"，而事实是"N 台里读不出来 M 台"——
 * 那正是本仓禁止的静默降级。空数组是合法结果（"确定 0 台"，spec §6.4 明写 200 + 空数组）。
 */
function parseConnectionsPayload(value: unknown): RemoteControlConnectionsPayload | null {
  if (!isRecord(value)) return null;
  const { connections, revision } = value;
  if (!Array.isArray(connections)) return null;
  if (typeof revision !== "number" || !Number.isFinite(revision)) return null;
  const parsed: RemoteControlConnection[] = [];
  for (const item of connections) {
    const connection = parseConnection(item);
    if (!connection) return null;
    parsed.push(connection);
  }
  return { connections: parsed, revision };
}

export function createWebServiceConnectionPlane(
  deps: WebServiceConnectionPlaneDeps,
): WebServiceConnectionPlane {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? REMOTE_CONTROL_REQUEST_TIMEOUT_MS;

  /**
   * 解析出"当前可用的端点 + 令牌"。任一项缺失 ⇒ `null`（调用方按"不知道"处理）。
   *
   * 注意 `running-untrusted` 也返回 null：那是"端口上有别人的服务"，
   * 拿我们的令牌打它只会 401，不该当成我们的连接面。
   */
  const resolveEndpoint = async (): Promise<{ base: string; token: string } | null> => {
    const status = await deps.status();
    if (status.state !== "running" || !status.host || !status.port) return null;
    const token = await readWebServiceToken(deps.tokenPath);
    if (!token) return null;
    const host =
      status.host.includes(":") && !status.host.startsWith("[") ? `[${status.host}]` : status.host;
    return { base: `http://${host}:${String(status.port)}`, token };
  };

  /**
   * 发一次连接面请求。返回值可能是任意形状的 JSON（未校验）——
   * 校验由各调用点按自己的契约做。
   *
   * `ok: false` 覆盖三种"拿不到"：端点不可用、网络/超时、非 2xx。
   * 三种都不抛异常给 IPC 层：读动作的语义就是"不知道 ⇒ null"。
   */
  const request = async (
    path: string,
    init: { method: "GET" | "POST"; body?: unknown },
  ): Promise<{ ok: true; json: unknown } | { ok: false; status?: number }> => {
    const endpoint = await resolveEndpoint();
    if (!endpoint) return { ok: false };
    // 令牌只进 URL，不进 header、不进日志（见文件头"鉴权方式"）。
    const url = `${endpoint.base}${path}?token=${encodeURIComponent(endpoint.token)}`;
    try {
      const response = await fetchImpl(url, {
        method: init.method,
        ...(init.body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return { ok: false, status: response.status };
      return { ok: true, json: (await response.json()) as unknown };
    } catch {
      // 刻意不把异常原样上抛：undici 的错误对象可能带上完整请求 URL（含令牌）。
      // 返回结构化结论，让调用方按"拿不到"处理。
      return { ok: false };
    }
  };

  return {
    list: async () => {
      const result = await request("/api/remote-control/connections", { method: "GET" });
      if (!result.ok) return null;
      return parseConnectionsPayload(result.json);
    },
    revoke: async (input) => {
      const result = await request("/api/remote-control/connections/revoke", {
        method: "POST",
        body: input,
      });
      if (!result.ok) {
        const suffix = result.status === undefined ? "" : ` (HTTP ${String(result.status)})`;
        throw new Error(`revoke connection failed${suffix}`);
      }
      const revoked = isRecord(result.json) ? result.json.revoked : undefined;
      if (typeof revoked !== "number" || !Number.isInteger(revoked) || revoked < 0) {
        throw new Error("revoke connection failed: malformed response");
      }
      return { revoked };
    },
    rotateToken: async () => {
      const result = await request("/api/remote-control/rotate-token", {
        method: "POST",
        body: {},
      });
      if (!result.ok) {
        const suffix = result.status === undefined ? "" : ` (HTTP ${String(result.status)})`;
        throw new Error(`rotate token failed${suffix}`);
      }
      const rotatedAt = isRecord(result.json) ? result.json.rotatedAt : undefined;
      if (typeof rotatedAt !== "number" || !Number.isFinite(rotatedAt)) {
        throw new Error("rotate token failed: malformed response");
      }
      return { rotatedAt };
    },
  };
}
