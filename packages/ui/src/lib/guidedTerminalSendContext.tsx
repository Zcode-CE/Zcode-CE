// 引导式授权（ENH-2）的 UI 注入面：「发送到集成终端」这个动作由壳层实现，命令块只发意图。
//
// 为什么用 context 而不是逐层 props：
//   命令块长在 assistant markdown 里，从 app shell 到它的路径是
//   WorkspaceShellLayout → V4WorkspaceChatArea → WorkbenchLeafPane → SessionPane
//   → ConversationRowView → MessageResponse → CodeBlock，共 6 层，其中若干层是 memo 组件。
//   为一条可选能力打穿 6 层 props 会同时改到这些 memo 的比较器（漏一个就是"点了没反应"）。
//   本仓库已有同型先例：v4/workflowRunOpenContext.tsx（"用 context 而不是逐层 props"）。
//
// 没有 provider 时（手机远控首页、公开分享页、单测）handler 为 null，
// 按钮不渲染 —— 与 workflowRunOpenContext 的"没有 provider 时只是文字，不是按钮"同一条纪律。

import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
import type { GuidedTerminalCommandPlan } from "@/lib/guidedTerminalCommand.js";

export interface GuidedTerminalSendRequest {
  plan: GuidedTerminalCommandPlan;
}

export type GuidedTerminalSendHandler = (request: GuidedTerminalSendRequest) => void;

const GuidedTerminalSendContext = createContext<GuidedTerminalSendHandler | null>(null);

export function GuidedTerminalSendProvider({
  onSend,
  children,
}: {
  /**
   * 传 null 表示「本模式下没有这个能力」，按钮不渲染。
   *
   * 这不只是优化，而是**不能给用户一个没有出路的入口**：办公模式下终端能力整体关闭
   * （`supportsTerminal: !isOfficeMode`，且 handleOpenTerminalTab 直接 return），
   * 若仍渲染按钮，用户点下去只会等到超时提示"终端打开失败" —— 而真实原因是这个模式不提供终端。
   * 这条纪律与设置页「电脑控制」开关的 shouldDisableComputerUseToggle 一致。
   */
  onSend: GuidedTerminalSendHandler | null;
  children: ReactNode;
}) {
  // 与 workflowRunOpenContext 同型：用 ref 保住 handler 的最新值，
  // context value 本身保持稳定引用，避免壳层每次 render 都让整棵 markdown 子树失效。
  const handlerRef = useRef(onSend);
  handlerRef.current = onSend;
  const stable = useMemo<GuidedTerminalSendHandler | null>(
    () =>
      onSend
        ? (request) => {
            handlerRef.current?.(request);
          }
        : null,
    [onSend],
  );
  return (
    <GuidedTerminalSendContext.Provider value={stable}>
      {children}
    </GuidedTerminalSendContext.Provider>
  );
}

/** 返回投递处理器；未注入时返回 null（调用方据此隐藏入口）。 */
export function useGuidedTerminalSend(): GuidedTerminalSendHandler | null {
  return useContext(GuidedTerminalSendContext);
}
