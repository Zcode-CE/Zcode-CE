import type { RemoteDaemonReconnectState } from "@zcode/shared";

/**
 * 远程 daemon 连接横幅的呈现模型（纯函数，便于在无 DOM 环境断言四种状态）。
 *
 * 四种用户可见状态：
 *   reconnecting   重连中（第 n/m 次，下次 x 秒后）
 *   recovered      已恢复（同一 daemon，会话仍在）
 *   needs-rebuild  daemon 已重启，需要重开会话（不能显示成「已恢复」）
 *   disconnected   已断开（带「查看日志」入口，指向 coreLogPath）
 *
 * 状态结构本身定义在 @zcode/shared（host 产生、main 转发、renderer 展示共用一份），
 * 这里只负责「状态 → 用户看到什么」。
 */
export type RemoteDaemonBannerTone = "progress" | "success" | "warning" | "error";

export type RemoteDaemonBannerAction = "retry" | "reopen-session" | "open-log" | "none";

export interface RemoteDaemonBannerModel {
  tone: RemoteDaemonBannerTone;
  /** i18n 键（文案集中在 locales，不在组件里拼字符串）。 */
  titleKey: string;
  descriptionKey: string;
  /** 描述里需要格式化的参数（秒数、次数、原因等）。 */
  descriptionParams?: Record<string, string | number>;
  action: RemoteDaemonBannerAction;
  /** 「查看日志」的目标路径（仅需要且已知时存在）。 */
  coreLogPath?: string;
}

const MAX_ATTEMPTS_FALLBACK = 4;

export function describeRemoteDaemonBanner(
  state: RemoteDaemonReconnectState,
): RemoteDaemonBannerModel | null {
  switch (state.kind) {
    case "connected":
      // 正常连接不占屏幕：横幅只在需要用户知情/操作时出现。
      return null;
    case "reconnecting":
      return {
        tone: "progress",
        titleKey: "remote.daemon.reconnecting.title",
        descriptionKey: "remote.daemon.reconnecting.description",
        descriptionParams: {
          attempt: state.attempt,
          maxAttempts: state.maxAttempts || MAX_ATTEMPTS_FALLBACK,
          seconds: Math.max(1, Math.round(state.nextDelayMs / 1000)),
        },
        action: "none",
      };
    case "reattaching":
      // 传输已重连、正在把新连接挂回窗口：仍属进行中，不能说已恢复。
      return {
        tone: "progress",
        titleKey: "remote.daemon.reattaching.title",
        descriptionKey: "",
        action: "none",
      };
    case "recovered":
      // 到这里说明传输重连 + registry 换 handle + renderer 端口换代全部成功，
      // 用户确实可以继续操作，才允许报成功态。
      return {
        tone: "success",
        titleKey: "remote.daemon.recovered.title",
        descriptionKey: "",
        action: "none",
      };
    case "needs-rebuild":
      return {
        tone: "warning",
        titleKey: "remote.daemon.needsRebuild.title",
        descriptionKey: "remote.daemon.needsRebuild.description",
        action: "reopen-session",
        ...(state.coreLogPath ? { coreLogPath: state.coreLogPath } : {}),
      };
    case "disconnected":
      return {
        tone: "error",
        titleKey: "remote.daemon.disconnected.title",
        descriptionKey: "remote.daemon.disconnected.description",
        descriptionParams: { reason: state.reason },
        action: "retry",
        ...(state.coreLogPath ? { coreLogPath: state.coreLogPath } : {}),
      };
  }
}
