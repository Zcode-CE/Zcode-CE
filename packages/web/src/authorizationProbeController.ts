import type { ConnectionPhase } from "./connectionRecovery.js";

/** 一次授权探测的三种结果（与 authProbe.classifyServerInfoProbe 同语义）。 */
export type AuthorizationProbeOutcome = "authorized" | "unauthorized" | "unreachable";

export interface AuthorizationProbeController {
  /**
   * 连接状态（相位 + 尝试次数）变化时调用。
   *
   * 语义：每个新的 attempt 都要重新探测一次。
   *
   * 为什么不能「一个相位只探一次」（task-22 阶段 2 修掉的缺陷）：
   * 断线往往就是服务在重启 —— 那一刻 /api/server-info 也连不上，探测只能得到
   * `unreachable`。若此后不再探测，即使服务已经起来并在用 401 拒绝这个浏览器
   * （cookie 因换令牌/过期而失效），页面也会永远停在「正在重连（第 N 次）…恢复后本页
   * 会自动继续，无需刷新」—— 而这句话在这条路径上是不成立的承诺，用户拿不到那条
   * 「怎么拿到带令牌链接」的可照做文案。
   *
   * 同一个 attempt 内重复调用不会重复探测（React effect 会因任何依赖变化重跑）。
   */
  notifyConnectionState(phase: ConnectionPhase, attempt: number): void;
  /** 已探测过的最大 attempt（测试与日志用）。 */
  peekLastProbedAttempt(): number | null;
  /**
   * 用户点「重试」后重新开始判定：清掉「已定案（unauthorized）」标记，
   * 否则后续断线会全部跳过探测（授权可能在这期间被修好/又失效）。
   */
  reset(): void;
}

export function createAuthorizationProbeController({
  probe,
  onUnauthorized,
}: {
  probe: () => Promise<AuthorizationProbeOutcome>;
  /**
   * 探到「授权问题」时调用一次。实现方负责停止自动重连并切到未授权态
   * （401 不会自愈，继续退避重试只会把授权问题说成网络问题）。
   */
  onUnauthorized: () => void;
}): AuthorizationProbeController {
  let lastProbedAttempt: number | null = null;
  let settled = false;

  return {
    notifyConnectionState(phase, attempt) {
      if (settled) {
        return;
      }
      if (phase !== "reconnecting" && phase !== "failed") {
        return;
      }
      if (lastProbedAttempt !== null && attempt <= lastProbedAttempt) {
        return;
      }
      lastProbedAttempt = attempt;

      void (async () => {
        const outcome = await probe();
        if (settled || outcome !== "unauthorized") {
          return;
        }
        settled = true;
        onUnauthorized();
      })();
    },
    peekLastProbedAttempt() {
      return lastProbedAttempt;
    },
    reset() {
      settled = false;
      lastProbedAttempt = null;
    },
  };
}
