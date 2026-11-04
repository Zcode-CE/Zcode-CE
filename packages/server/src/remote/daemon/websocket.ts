import { Emitter, VSBuffer, type ISocket } from "@zcode/rpc";
import WebSocket from "ws";
import { ZCODE_RPC_HOST_CAPABILITY_HEADER } from "@zcode/shared";
import type { DaemonChannelFactory } from "./types.js";

/** /ws/host 升级的超时预算：通道已建好，只差一次握手。 */
const DAEMON_WS_HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * 经通道连 daemon 的 /ws/host（trusted-host-relay / desktop-continuous）。
 *
 * 为什么用 ws 而不是 Node 内置 WebSocket：内置实现只能自己建 TCP，没法把连接换成 SSH
 * direct-tcpip 通道；ws 支持 createConnection，能把任意 Duplex 当作底层连接。
 * ticket 通过 headers 传递（daemon 侧在 upgrade 前校验并消费）。
 */
export async function openDaemonHostWebSocket(params: {
  openChannel: DaemonChannelFactory;
  capability: string;
  path?: string;
}): Promise<WebSocket> {
  // ⚠️ ws 的 createConnection 必须同步返回流：直接塞 `() => openChannel()`（async）
  // 会把 Promise 当 socket，升级永远等不到结果。所以先自己 await 拿到通道，再交给 ws。
  const channel = await params.openChannel();
  return await new Promise((resolve, reject) => {
    // URL 只用于补全 Host/path；真正的连接由 createConnection 提供。
    const socket = new WebSocket("ws://127.0.0.1" + (params.path ?? "/ws/host"), {
      headers: { [ZCODE_RPC_HOST_CAPABILITY_HEADER]: params.capability },
      handshakeTimeout: DAEMON_WS_HANDSHAKE_TIMEOUT_MS,
      createConnection: () => channel as never,
    });
    const cleanup = () => {
      socket.off("open", onOpen);
      socket.off("error", onError);
      socket.off("unexpected-response", onUnexpectedResponse);
    };
    const onOpen = () => {
      cleanup();
      resolve(socket);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onUnexpectedResponse = (_request: unknown, response: { statusCode?: number }) => {
      cleanup();
      const message =
        response.statusCode === 401
          ? "daemon 拒绝了 /ws/host 升级（401）：host capability 无效或已被使用"
          : "daemon /ws/host 升级失败：HTTP " + String(response.statusCode);
      // 先给出可读错误再丢弃连接：升级被拒绝时 ws 还没进入 OPEN，直接 terminate() 会同步抛
      // "WebSocket was closed before the connection was established"，把 401 的原因吞掉。
      reject(new Error(message));
      // 丢弃底层连接时的迟到 error 不能再上抛（调用方已经拿到错误，ws 内部状态也已被清理）。
      socket.on("error", () => undefined);
      setImmediate(() => {
        try {
          socket.terminate();
        } catch {
          // 已经被对端关闭：没有需要清理的状态。
        }
      });
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
    socket.once("unexpected-response", onUnexpectedResponse as never);
  });
}

/** 把 ws 连接包成 rpc 的 ISocket（与 packages/client/src/websocket.ts 同形）。 */
export function wrapDaemonWebSocket(socket: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();
  socket.binaryType = "nodebuffer";
  socket.on("message", (data: WebSocket.RawData) => {
    const buffer = Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.isBuffer(data)
        ? data
        : Buffer.from(data as ArrayBuffer);
    onData.fire(VSBuffer.wrap(new Uint8Array(buffer)));
  });
  let closed = false;
  const fireClose = () => {
    if (closed) return;
    closed = true;
    onClose.fire();
    onEnd.fire();
  };
  socket.on("close", fireClose);
  socket.on("error", fireClose);
  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(buffer.buffer as Uint8Array);
      }
    },
    end() {
      socket.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      socket.close();
    },
  };
}
