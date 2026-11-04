import { create } from "zustand";
import type { RemoteDaemonReconnectState } from "@zcode/shared";

/**
 * 远程 daemon 连接状态（渲染进程侧）。
 *
 * 只保留「当前这一条远程连接」的状态快照：横幅是工作区级单例（同一窗口同一时刻只有一个
 * 远程 workspace 在前台），因此不做 per-workspace 分桶 —— 真要多窗口并存时再按
 * workspaceKey 索引。
 *
 * 数据来源只有一条：IPlatformService.onRemoteDaemonStatusChanged（host → main → renderer 的
 * 结构化通道）。没有日志解析兜底，避免两套真相。
 */
interface RemoteDaemonStatusStore {
  state: RemoteDaemonReconnectState | null;
  /** 横幅是否被用户临时关闭（避免反复遮挡内容）。 */
  dismissed: boolean;
  setState(state: RemoteDaemonReconnectState | null): void;
  dismiss(): void;
  reset(): void;
}

export const useRemoteDaemonStatusStore = create<RemoteDaemonStatusStore>((set) => ({
  state: null,
  dismissed: false,
  setState(state) {
    set({ state, dismissed: false });
  },
  dismiss() {
    set({ dismissed: true });
  },
  reset() {
    set({ state: null, dismissed: false });
  },
}));
