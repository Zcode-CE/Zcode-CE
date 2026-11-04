import http from "node:http";
import type { Duplex } from "node:stream";

export interface ChannelHttpResponse {
  statusCode: number;
  body: string;
}

/**
 * 在一条字节通道上发一个 HTTP/1.1 请求。
 *
 * 为什么自己接 http.request 而不是复用 SocketProtocol：daemon 的准入（/api/server-info）
 * 与票据（POST /api/rpc-host-capability）都是普通 HTTP 端点，走 HTTP 层能直接复用 Node 的
 * 状态行/分块解析，避免手写响应解析器。
 *
 * agent.createConnection 把连接换成调用方给的通道（SSH direct-tcpip），keepAlive: false
 * 保证请求结束后 Node 会销毁这条通道 —— 因此每次请求必须新开一条通道，不能复用。
 */
export function requestOverChannel(
  channel: Duplex,
  options: { method?: string; path: string; headers?: Record<string, string>; timeoutMs?: number },
): Promise<ChannelHttpResponse> {
  return new Promise((resolve, reject) => {
    const agent = new http.Agent({ keepAlive: false });
    agent.createConnection = (_agentOptions, callback) => {
      callback?.(null, channel as never);
      return channel as never;
    };
    const request = http.request(
      {
        // host/port 只参与 Host 头与 URL 格式化；真正的连接由 createConnection 提供。
        host: "127.0.0.1",
        port: 0,
        path: options.path,
        method: options.method ?? "GET",
        headers: options.headers ?? {},
        agent,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf-8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          agent.destroy();
          resolve({ statusCode: response.statusCode ?? 0, body });
        });
      },
    );
    const timeout = options.timeoutMs ?? 10_000;
    request.setTimeout(timeout, () => {
      request.destroy(
        new Error("HTTP " + options.path + " over channel timed out after " + timeout + "ms"),
      );
    });
    request.on("error", (error) => {
      agent.destroy();
      reject(error);
    });
    request.end();
  });
}

/** 读取 JSON 响应体；非 2xx 或非 JSON 都给出可读原因（不要静默当成空对象）。 */
export function parseJsonResponse<T>(
  response: ChannelHttpResponse,
  what: string,
): { ok: true; value: T } | { ok: false; reason: string } {
  if (response.statusCode < 200 || response.statusCode >= 300) {
    return {
      ok: false,
      reason: what + " returned HTTP " + response.statusCode + ": " + response.body.slice(0, 200),
    };
  }
  try {
    return { ok: true, value: JSON.parse(response.body) as T };
  } catch (error) {
    return {
      ok: false,
      reason:
        what +
        " returned non-JSON body: " +
        (error instanceof Error ? error.message : String(error)),
    };
  }
}
