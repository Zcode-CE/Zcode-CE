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
    case "recovered":
      // 传输层重连成功 ≠ 本地已重新挂载：新连接没有回到 registry，界面上的服务引用
      // 仍指向旧连接。所以这里不能报「已恢复」，只报「远端会话还在、需要重新加载工作区」。
      return {
        tone: "warning",
        titleKey: "remote.daemon.recovered.title",
        descriptionKey: "remote.daemon.recovered.description",
        action: "reopen-session",
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
