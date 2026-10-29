import { Emitter } from "@zcode/rpc";

/**
 * 无监听者期间最多保留的 PTY 输出字符数；超出后丢弃最旧的块，保留屏幕上最可能仍可见的尾部。
 * 1 MiB 足以覆盖一个提示符与首批日志，又不会让断连期间的疯跑输出无限占用内存。
 */
export const TERMINAL_UNSUBSCRIBED_OUTPUT_MAX_CHARS = 1_048_576;

/**
 * 缓冲"还没有订阅者"时的 PTY 输出，并在订阅者到来后按序回放。
 *
 * 为什么需要（R3 远端终端恒空，2026-09-14）：PTY 的首批输出（bash 提示符在 spawn 后约 10ms
 * 就到达）在 renderer 通过 create() 拿到 id 并订阅 onDynamicData 之前就已 fire，而普通
 * Emitter 在没有监听者时直接丢弃事件，ProxyChannel 对 onDynamicXxx 也不做缓冲。本地链路往返
 * 只有毫秒级，多数时候能抢在提示符之前订阅；远端目标经 SSH 往返 40~200ms，首个提示符必丢，
 * 之后 shell 空闲再无输出，用户看到空白终端。
 *
 * 修法：输出的唯一来源在这里，于是没有监听者时把输出有界缓存，监听者到来后按序回放再转直通；
 * 订阅断开（例如远端连接换代）期间同样缓存，避免重连后丢失中间输出。不依赖任何超时。
 */
export function createBufferedTerminalOutputEmitter(): {
  emitter: Emitter<string>;
  push: (data: string) => void;
} {
  const pending: string[] = [];
  let pendingChars = 0;
  let hasListener = false;

  const emitter: Emitter<string> = new Emitter<string>({
    // Emitter 先登记监听者再触发该钩子，因此这里的 fire 能直接送达刚订阅的监听者。
    onWillAddFirstListener: () => {
      hasListener = true;
      const buffered = pending.splice(0);
      pendingChars = 0;
      for (const chunk of buffered) {
        emitter.fire(chunk);
      }
    },
    onDidRemoveLastListener: () => {
      hasListener = false;
    },
  });

  return {
    emitter,
    push: (data) => {
      if (hasListener) {
        emitter.fire(data);
        return;
      }
      pending.push(data);
      pendingChars += data.length;
      while (pendingChars > TERMINAL_UNSUBSCRIBED_OUTPUT_MAX_CHARS && pending.length > 1) {
        pendingChars -= pending.shift()?.length ?? 0;
      }
    },
  };
}
