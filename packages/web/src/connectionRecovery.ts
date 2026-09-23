/**
 * 连接监督器：把「断线」变成「可恢复」。
 *
 * 背景：`packages/client/src/websocket.ts` 只负责建立连接，不重连；Web 入口在 task-16
 * 之前把 `onClose` 直接丢弃，于是手机锁屏/切后台/服务重启后页面**假死**（看着正常、
 * 完全不动），只能手动刷新。这里把重连策略收敛成一个可注入、可测的纯逻辑单元：
 * 定时器与连接函数都由调用方注入，便于在 node:test 里用假时钟断言退避序列。
 *
 * 本模块**不依赖任何浏览器/Vite 专有全局**（只用传入的 setTimeout 实现），因此可以在
 * Node 测试里直接跑。
 */

export type ConnectionPhase = "connecting" | "connected" | "reconnecting" | "failed";

export interface ReconnectPolicy {
  /** 首次重试等待（毫秒）。 */
  baseDelayMs: number;
  /** 退避上限（毫秒）。 */
  maxDelayMs: number;
  /** 连续失败多少次后进入 failed（用户需手动重试）。 */
  maxAttempts: number;
  /** 抖动比例（0-1）：避免多设备同时重连打在一个刚起来的服务上。 */
  jitterRatio: number;
}

export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = {
  baseDelayMs: 500,
  maxDelayMs: 10_000,
  maxAttempts: 8,
  jitterRatio: 0.2,
};

/**
 * 第 attempt 次重试的等待时长：指数退避 + 抖动，上限 maxDelayMs。
 * attempt 从 1 开始；random 注入以便测试（默认 Math.random）。
 */
export function reconnectDelayMs(
  attempt: number,
  policy: ReconnectPolicy = DEFAULT_RECONNECT_POLICY,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attempt - 1);
  const capped = Math.min(policy.baseDelayMs * 2 ** exponent, policy.maxDelayMs);
  const jitter = capped * policy.jitterRatio * (random() * 2 - 1);
  return Math.max(0, Math.round(capped + jitter));
}

export interface ConnectionPhaseInfo {
  /** 已连续失败的次数（成功一次后清零）。 */
  attempt: number;
  /** 下一次重试的等待时长；仅在 reconnecting 时有值。 */
  nextDelayMs?: number;
  /** 触发失败的原始错误（诊断用）。 */
  error?: unknown;
}

export interface ConnectionSupervisorOptions<TSession> {
  /** 建立一次连接；失败请 reject。 */
  connect: () => Promise<TSession>;
  /** 连接成功（含重连成功）时回调；调用方据此挂载/重新挂载应用。 */
  onSession: (session: TSession) => void;
  onPhase?: (phase: ConnectionPhase, info: ConnectionPhaseInfo) => void;
  policy?: Partial<ReconnectPolicy>;
  random?: () => number;
  setTimeoutImpl?: (handler: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
}

export interface ConnectionSupervisor {
  start(): void;
  stop(): void;
  /** 已建立的连接被对端/网络关闭时由调用方上报（幂等：仅 connected 状态下生效）。 */
  notifyClosed(): void;
  /** 用户点「重试」：清空失败计数并立即再连一次。 */
  retryNow(): void;
  phase(): ConnectionPhase;
  attempt(): number;
}

export function createConnectionSupervisor<TSession>(
  options: ConnectionSupervisorOptions<TSession>,
): ConnectionSupervisor {
  const policy: ReconnectPolicy = { ...DEFAULT_RECONNECT_POLICY, ...options.policy };
  const random = options.random ?? Math.random;
  const setTimeoutImpl =
    options.setTimeoutImpl ?? ((handler, ms) => globalThis.setTimeout(handler, ms));
  const clearTimeoutImpl =
    options.clearTimeoutImpl ??
    ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>));

  let currentPhase: ConnectionPhase = "connecting";
  let failureCount = 0;
  let stopped = true;
  let pendingTimer: unknown = null;
  let connecting = false;

  function emit(info: ConnectionPhaseInfo): void {
    options.onPhase?.(currentPhase, info);
  }

  function setPhase(next: ConnectionPhase, info: ConnectionPhaseInfo): void {
    currentPhase = next;
    emit(info);
  }

  function clearPendingTimer(): void {
    if (pendingTimer !== null) {
      clearTimeoutImpl(pendingTimer);
      pendingTimer = null;
    }
  }

  function scheduleReconnect(error?: unknown): void {
    if (stopped) {
      return;
    }
    if (failureCount >= policy.maxAttempts) {
      setPhase("failed", { attempt: failureCount, ...(error === undefined ? {} : { error }) });
      return;
    }
    // 退避档位 = 到目前为止的失败次数（至少 1 档）：刚断线/首次失败 → baseDelayMs，
    // 之后按 2 倍递增并截断到 maxDelayMs。emit 的 attempt 是「已失败几次」，
    // 覆盖层据此显示「正在尝试第 attempt+1 次」。
    const retryStep = Math.max(1, failureCount);
    const nextDelayMs = reconnectDelayMs(retryStep, policy, random);
    setPhase("reconnecting", {
      attempt: failureCount,
      nextDelayMs,
      ...(error === undefined ? {} : { error }),
    });
    clearPendingTimer();
    pendingTimer = setTimeoutImpl(() => {
      pendingTimer = null;
      void attemptConnect();
    }, nextDelayMs);
  }

  async function attemptConnect(): Promise<void> {
    if (stopped || connecting) {
      return;
    }
    connecting = true;
    if (failureCount === 0) {
      setPhase("connecting", { attempt: 0 });
    }
    try {
      const session = await options.connect();
      connecting = false;
      if (stopped) {
        return;
      }
      failureCount = 0;
      setPhase("connected", { attempt: 0 });
      options.onSession(session);
    } catch (error) {
      connecting = false;
      if (stopped) {
        return;
      }
      // 先计数再排程：failureCount 表示「到目前为止已连续失败几次」，
      // 排程时用它判断是否已达上限、并据此选退避档位。
      failureCount += 1;
      scheduleReconnect(error);
    }
  }

  return {
    start(): void {
      if (!stopped) {
        return;
      }
      stopped = false;
      failureCount = 0;
      void attemptConnect();
    },
    stop(): void {
      stopped = true;
      clearPendingTimer();
    },
    notifyClosed(): void {
      if (stopped || currentPhase !== "connected") {
        return;
      }
      // 刚建立起来的连接断了：从第一次退避（baseDelayMs）开始重连，而不是直接跳到第二轮。
      failureCount = 0;
      scheduleReconnect();
    },
    retryNow(): void {
      clearPendingTimer();
      if (stopped) {
        stopped = false;
      }
      failureCount = 0;
      void attemptConnect();
    },
    phase(): ConnectionPhase {
      return currentPhase;
    },
    attempt(): number {
      return failureCount;
    },
  };
}
