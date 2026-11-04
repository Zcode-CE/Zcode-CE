import type { Duplex } from "node:stream";

/**
 * 把 ssh2 `forwardOut()` 的 Channel 补成 Node http/ws 期望的 Socket 形状。
 *
 * 根因（真机 E2E 实测）：ssh2 的 Channel 是 Duplex，不是 `net.Socket` —— 它没有
 * `setTimeout`/`setNoDelay`/`setKeepAlive`/`ref`/`unref`/`address`。Node 的 `http.request`
 * 拿到 socket 后会调 `socket.setTimeout(...)`（`_http_client.js` 的 setSocketTimeout），
 * ws 客户端同样会调 `setNoDelay`/`setTimeout`，于是第一条 HTTP 请求直接抛
 * `TypeError: sock.setTimeout is not a function`。单测用的是回环真 TCP socket（有这些方法），
 * 所以直到真机换成 ssh2 通道才暴露。
 *
 * 为什么是就地补齐而不是 Proxy 包装：Node 的 http 客户端在 socket 对象上挂
 * `_httpMessage`/`kSocket` 等内部状态，并要求「收到 data 的对象 === 自己登记的对象」。
 * Proxy 会让事件回调里的 `this` 与登记对象不是同一个，触发 `ERR_INTERNAL_ASSERTION`
 * （实测）。就地补方法保持对象身份，内部符号全部照旧。
 */

export interface DaemonChannelEndpoint {
  host: string;
  port: number;
}

type MutableChannel = Duplex & Record<string, unknown>;

export function wrapDaemonChannelAsSocket(
  channel: Duplex,
  endpoint: DaemonChannelEndpoint,
): Duplex {
  const target = channel as MutableChannel;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  const clearTimeoutTimer = (): void => {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
  };
  // 连接断开后不能留下活着的定时器（会让 host 进程迟迟不退出）。
  target.once("close", clearTimeoutTimer);

  // 只补缺失的方法：ssh2 的部分实现（如 setNoDelay）已有，覆盖它会丢语义。
  if (typeof target.setTimeout !== "function") {
    /**
     * http 用它设请求超时。必须真的实现（不能 no-op）：no-op 会让请求超时静默失效，
     * 通道半开时请求会永久挂住。这里把 Node 的「socket 超时」映射成 Channel 上的 timeout 事件。
     */
    // 注意不要把这个函数命名为 setTimeout：函数表达式名会遮蔽全局 setTimeout，
    // 导致内部的 `setTimeout(...)` 变成递归调用自己（TS 也会报类型不匹配）。
    target.setTimeout = function channelSetTimeout(ms: number, callback?: () => void) {
      clearTimeoutTimer();
      if (typeof callback === "function") target.once("timeout", callback);
      if (typeof ms === "number" && ms > 0) {
        timeoutTimer = setTimeout(() => {
          timeoutTimer = null;
          target.emit("timeout");
        }, ms);
        timeoutTimer.unref?.();
      }
      return target;
    };
  }
  for (const method of ["setNoDelay", "setKeepAlive", "ref", "unref"] as const) {
    if (typeof target[method] !== "function") {
      target[method] = () => target;
    }
  }
  if (typeof target.cork !== "function") target.cork = () => undefined;
  if (typeof target.uncork !== "function") target.uncork = () => undefined;
  if (typeof target.destroySoon !== "function") {
    target.destroySoon = () => {
      clearTimeoutTimer();
      target.end();
    };
  }
  if (typeof target.address !== "function") {
    target.address = () => ({ address: endpoint.host, family: "IPv4", port: endpoint.port });
  }

  // ws 客户端会读这些属性判断连接状态；Channel 上没有，按「已连接的 socket」回答。
  if (target.connecting === undefined) target.connecting = false;
  if (target.pending === undefined) target.pending = false;
  if (target.readyState === undefined) target.readyState = "open";
  if (target.remoteAddress === undefined) target.remoteAddress = endpoint.host;
  if (target.remoteFamily === undefined) target.remoteFamily = "IPv4";
  if (target.remotePort === undefined) target.remotePort = endpoint.port;

  return target;
}
