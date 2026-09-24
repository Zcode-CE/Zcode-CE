import type { WebServiceStateRecord } from "./state.js";

/**
 * 接管探活（契约 §4）：单一真相源，UI 与后端共用同一组判据。
 *
 * 设计要点（都是刻意的）：
 * - **IO 全部注入**：状态读取、pid 存活判定、`/api/server-info` 探测都可注入 ⇒
 *   五个分支（stopped / pid-dead / port-closed / probe-timeout / 401-403 / running）
 *   能在毫秒级、可复现地测到，不必真的起服务。
 * - **不在这里启动任何东西**：探活只读。`state === "running"` 时由编排层拒绝启动第二个进程。
 * - **pid 存活 = `process.kill(pid, 0)` 不抛 ESRCH**：`EPERM` 也算存活（进程在，只是不属于我们）。
 * - **探测超时默认 1500ms**（契约 §4）：超时与"拒绝连接"是**不同的判据**，
 *   前者说明端口上有东西但不响应（可能被防火墙吞了），后者说明端口没人监听。
 */

export const WEB_SERVICE_PROBE_TIMEOUT_MS = 1500;

export type WebServiceProbeResult =
  | { state: "stopped" }
  | { state: "stale"; reason: "pid-dead" | "port-closed" | "probe-timeout" }
  | {
      state: "running";
      adopted: true;
      host: string;
      port: number;
      url: string;
      pid: number;
      startedAt: number;
      workspacePath?: string;
    }
  | { state: "running-untrusted"; host: string; port: number };

export interface WebServiceProbeDeps {
  statePath: string;
  readState: (path: string) => Promise<WebServiceStateRecord | undefined>;
  /**
   * 从状态文件里记的 `tokenFile` 读令牌。
   * 契约 §4 明确「凭证**取自 tokenFile**」—— 不带令牌探测会被服务端判 401，
   * 于是**我们自己的服务**会被误判成 `running-untrusted`，接管这条路直接失效。
   */
  readToken: (path: string) => Promise<string | undefined>;
  isPidAlive: (pid: number) => boolean;
  /**
   * 用令牌 GET `/api/server-info`。
   * 返回 HTTP 状态码；超时返回 `"timeout"`；其它网络错误返回 `"network"`。
   */
  probeServerInfo: (input: {
    url: string;
    token: string | undefined;
    timeoutMs: number;
  }) => Promise<number | "timeout" | "network">;
  timeoutMs?: number;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH = 进程不存在；EPERM = 存在但不是我们能发的信号 ⇒ 仍算存活。
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function buildWebServiceUrl(host: string, port: number): string {
  // IPv6 字面量要加方括号，否则拼出来的 URL 不可解析（探活会永远 port-closed）。
  const normalizedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${normalizedHost}:${port}`;
}

export async function probeWebService(deps: WebServiceProbeDeps): Promise<WebServiceProbeResult> {
  const record = await deps.readState(deps.statePath);
  if (!record) return { state: "stopped" };

  if (!deps.isPidAlive(record.pid)) return { state: "stale", reason: "pid-dead" };

  const url = buildWebServiceUrl(record.host, record.port);
  // 凭证取自状态文件记的 tokenFile（契约 §4）。读不到就**不带**令牌探测 ——
  // 那会（正确地）得到 401 ⇒ running-untrusted：我们无法证明那是我们的服务。
  const token = await deps.readToken(record.tokenFile);
  const status = await deps.probeServerInfo({
    url,
    token,
    timeoutMs: deps.timeoutMs ?? WEB_SERVICE_PROBE_TIMEOUT_MS,
  });

  if (status === "timeout") return { state: "stale", reason: "probe-timeout" };
  if (status === "network") return { state: "stale", reason: "port-closed" };
  if (status === 401 || status === 403) {
    // 端口上有东西但用我们的令牌打不动 ⇒ 不是我们的服务（或令牌已轮换）。
    // 契约 §4 明确：**不自动换端口启动**，交给用户判断。
    return { state: "running-untrusted", host: record.host, port: record.port };
  }
  if (status >= 200 && status < 300) {
    return {
      state: "running",
      adopted: true,
      host: record.host,
      port: record.port,
      url,
      pid: record.pid,
      startedAt: record.startedAt,
      ...(record.workspacePath ? { workspacePath: record.workspacePath } : {}),
    };
  }
  // 其它状态码（如 500）：端口上有我们的服务但状态不健康 ⇒ 不接管，也不删文件（让用户排查）。
  return { state: "running-untrusted", host: record.host, port: record.port };
}
