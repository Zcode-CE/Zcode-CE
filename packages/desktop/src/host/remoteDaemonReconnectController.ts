/**
 * 远端常驻 daemon 的重连状态机（第二阶段）。
 *
 * 语义边界（Lead 决策 #4）：
 * - 只有 daemon 存活期内 的重连才算「恢复」：daemon 重启后 pty/agent scope 全丢
 *   （SPIKE §4.5 实测 `Terminal not found: 0`），所以 `generation`/`pid` 变化必须标成
 *   `needs-rebuild`，不能假装恢复成功；
 * - 重连只重跑 probe → admission → ticket → ws（端口每次启动都变），绝不静默切回 stdio：
 *   那会另起一个 server 进程，语义混乱；
 * - 重试耗尽或遇到不可重试的失败（未安装/不兼容/起不来）⇒ `disconnected` 并给出可操作原因
 *   （含 `coreLogPath`，指向 `<serverRoot>/run/core.log`）。
 *
 * 本模块是纯逻辑：所有 IO 由 `deps.reconnect` 注入，延迟/随机数/时钟也可注入 ⇒ 测试不碰真 sshd。
 */

// 权威定义在 @zcode/shared：host 产生、main 转发、renderer 展示共用同一结构。
import type { RemoteDaemonIdentity, RemoteDaemonReconnectState } from "@zcode/shared";
export type { RemoteDaemonIdentity, RemoteDaemonReconnectState };

/** 一次重连尝试的结果。success 时带回新的 daemon 身份，用于判断「同一 daemon」还是「重启过」。 */
export type DaemonReconnectAttempt =
  | { ok: true; identity: RemoteDaemonIdentity }
  | {
      ok: false;
      /** 与 daemon 传输的不可用分类对齐；not-installed/unsupported/incompatible 不重试。 */
      kind: "not-installed" | "unsupported" | "incompatible" | "start-failed" | "unusable";
      reason: string;
      coreLogPath?: string;
    };

export interface RemoteDaemonReconnectDeps {
  /** 执行一次完整重连（probe → admission → ticket → ws）。失败要返回分类而不是抛错。 */
  reconnect: () => Promise<DaemonReconnectAttempt>;
  /**
   * 把重连后的新连接挂回窗口（registry 换 handle + renderer 端口换代）。
   * 成功才算 recovered；失败必须降级为 needs-rebuild（不谎报）。未提供视为不支持 re-attach。
   */
  reattach?: (
    identity: RemoteDaemonIdentity,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
  onStateChange?: (state: RemoteDaemonReconnectState) => void;
  /** 重试上限（Lead 定的 3–5 区间，默认 4）。 */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** 注入以便测试不真等。 */
  sleep?: (ms: number) => Promise<void>;
}

export interface RemoteDaemonReconnectController {
  /** 触发一轮重连；previous 是断线前那条连接的身份。 */
  start(previous: RemoteDaemonIdentity, triggerReason: string): Promise<RemoteDaemonReconnectState>;
  /** 取消进行中的重连（窗口关闭/用户切换工作区时调用）。 */
  cancel(): void;
  /** 当前状态（测试与 UI 快照用）。 */
  current(): RemoteDaemonReconnectState | null;
}

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 8_000;

/** 这些失败重试也没有意义：不是瞬断，而是 daemon 不在/不兼容/起不来。 */
const NON_RETRYABLE: ReadonlySet<DaemonReconnectAttempt extends never ? never : string> = new Set([
  "not-installed",
  "unsupported",
  "incompatible",
  "start-failed",
]);

function sameIdentity(
  previous: { generation?: number; pid?: number },
  next: { generation?: number; pid?: number },
): boolean {
  // 两个字段都缺失时无法判断是否重启：按「同一 daemon」处理（保守：不谎报重建）。
  if (previous.generation === undefined && previous.pid === undefined) return true;
  if (previous.generation !== undefined && next.generation !== undefined) {
    return previous.generation === next.generation;
  }
  if (previous.pid !== undefined && next.pid !== undefined) {
    return previous.pid === next.pid;
  }
  return true;
}

/** 指数退避：base, base*2, base*4 … 截断到 maxDelayMs。 */
export function reconnectDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const raw = baseDelayMs * 2 ** Math.max(attempt - 1, 0);
  return Math.min(raw, maxDelayMs);
}

export function createRemoteDaemonReconnectController(
  deps: RemoteDaemonReconnectDeps,
): RemoteDaemonReconnectController {
  const maxAttempts = Math.max(1, deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const baseDelayMs = Math.max(1, deps.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
  const maxDelayMs = Math.max(baseDelayMs, deps.maxDelayMs ?? DEFAULT_MAX_DELAY_MS);
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let cancelled = false;
  let state: RemoteDaemonReconnectState | null = null;

  const emit = (next: RemoteDaemonReconnectState): RemoteDaemonReconnectState => {
    state = next;
    deps.onStateChange?.(next);
    return next;
  };

  return {
    async start(previous, triggerReason) {
      cancelled = false;
      let lastReason = triggerReason;
      let lastCoreLogPath: string | undefined = previous.coreLogPath;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (cancelled) return emit({ kind: "disconnected", reason: "重连已取消" });
        // 第一次立即尝试（断线瞬间隧道抖动通常直接成功），之后按指数退避。
        // nextDelayMs 报的是「本次尝试之前等了多久」，UI 直接展示即可。
        const nextDelayMs =
          attempt === 1 ? 0 : reconnectDelayMs(attempt - 1, baseDelayMs, maxDelayMs);
        emit({
          kind: "reconnecting",
          attempt,
          maxAttempts,
          nextDelayMs,
          reason: lastReason,
        });
        if (nextDelayMs > 0) {
          await sleep(nextDelayMs);
          if (cancelled) return emit({ kind: "disconnected", reason: "重连已取消" });
        }
        const result = await deps.reconnect();
        if (result.ok) {
          if (sameIdentity(previous, result.identity)) {
            // 同一 daemon：还要把新连接挂回窗口，渲染进程的 services 引用才会指向新连接。
            if (deps.reattach) {
              emit({ kind: "reattaching", reason: "re-attaching new connection to window" });
              const reattached = await deps.reattach(result.identity);
              if (!reattached.ok) {
                // re-attach 失败：连接没回来，绝不能报 recovered。
                return emit({
                  kind: "needs-rebuild",
                  reason: "重连成功但无法接回窗口：" + reattached.reason,
                  previous: {
                    ...(previous.generation !== undefined
                      ? { generation: previous.generation }
                      : {}),
                    ...(previous.pid !== undefined ? { pid: previous.pid } : {}),
                  },
                  current: {
                    ...(result.identity.generation !== undefined
                      ? { generation: result.identity.generation }
                      : {}),
                    ...(result.identity.pid !== undefined ? { pid: result.identity.pid } : {}),
                  },
                  identity: result.identity,
                  ...((result.identity.coreLogPath ?? previous.coreLogPath)
                    ? { coreLogPath: result.identity.coreLogPath ?? previous.coreLogPath }
                    : {}),
                });
              }
            }
            return emit({
              kind: "recovered",
              identity: {
                ...result.identity,
                ...(previous.coreLogPath ? { coreLogPath: previous.coreLogPath } : {}),
              },
            });
          }
          // daemon 重启过：pty/agent scope 都没了，标成「需重建」。
          return emit({
            kind: "needs-rebuild",
            reason: "daemon 已重启，之前的会话不再存在",
            previous: {
              ...(previous.generation !== undefined ? { generation: previous.generation } : {}),
              ...(previous.pid !== undefined ? { pid: previous.pid } : {}),
            },
            current: {
              ...(result.identity.generation !== undefined
                ? { generation: result.identity.generation }
                : {}),
              ...(result.identity.pid !== undefined ? { pid: result.identity.pid } : {}),
            },
            identity: result.identity,
            ...((result.identity.coreLogPath ?? previous.coreLogPath)
              ? { coreLogPath: result.identity.coreLogPath ?? previous.coreLogPath }
              : {}),
          });
        }
        lastReason = result.reason;
        lastCoreLogPath = result.coreLogPath ?? lastCoreLogPath;
        if (NON_RETRYABLE.has(result.kind)) {
          return emit({
            kind: "disconnected",
            reason: result.reason,
            ...(lastCoreLogPath ? { coreLogPath: lastCoreLogPath } : {}),
          });
        }
      }
      return emit({
        kind: "disconnected",
        reason: lastReason,
        ...(lastCoreLogPath ? { coreLogPath: lastCoreLogPath } : {}),
      });
    },
    cancel() {
      cancelled = true;
    },
    current() {
      return state;
    },
  };
}
