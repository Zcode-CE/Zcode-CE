import { createContext, useContext } from "react";
import type { useBotGroupTask } from "@/hooks/useBotGroupTask.js";

/**
 * 群同步状态的任务级上下文。
 *
 * 状态所有者是 `useBotGroupTask`（订阅 `bots:group-state` 广播 + 首个 provider 回退），
 * 由 SessionPane 的 BotGroupDeliveryProvider 装一次；轮次动作栏与话题准备态只读，
 * 不各自请求全量 Bot 状态（N 条历史回复会变成 N 次 getBotStates）。
 */
export const DeliveryContext = createContext<
  (ReturnType<typeof useBotGroupTask> & { taskId: string | null }) | null
>(null);

/**
 * 该轮是否被群里的新消息打断。
 *
 * 判据来自群状态里对应输入的 `progress.interruptionReason === "newMessage"`，不是猜文案；
 * 命中的轮次显示「已被新消息中断」，否则退回通用的「已停止」。
 */
export function useBotTopicInterruption(sourceCommandIds: readonly string[]): boolean {
  const value = useContext(DeliveryContext);
  const group = value?.context?.group;
  return (
    !!group?.threadId &&
    sourceCommandIds.some((id) => {
      const input = group.inputs?.[id];
      return (
        input?.taskId === value?.taskId && input?.progress?.interruptionReason === "newMessage"
      );
    })
  );
}
