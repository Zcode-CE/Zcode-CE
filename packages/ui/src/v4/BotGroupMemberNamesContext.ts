import { createContext } from "react";

/**
 * 群成员姓名缓存（context 键 = bot + chat）。
 *
 * 为什么用 context：同一任务里每条投递/准备态都要把 senderId 翻成姓名，逐行请求会
 * 打出 N 份 `getGroupMemberNames`；由 BotGroupDeliveryProvider 订阅一次、逐行只读。
 */
export interface BotGroupMemberNames {
  botId: string;
  chatId: string;
  names: Record<string, string>;
}

export const BotGroupMemberNamesContext = createContext<BotGroupMemberNames | null>(null);
