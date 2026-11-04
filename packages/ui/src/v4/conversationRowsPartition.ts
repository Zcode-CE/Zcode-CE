import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

/**
 * rows.window 的「冻结历史 + 尾轮」分区（spec：docs/ui/chat-virtual-scroll.md「每帧派生成本」）。
 *
 * 只是行数组的视图类型，不上 wire，没有 schema；构造与缓存在 conversationProjectionStore。
 * 上游把它放在 shared/zcode-protocol-v4/rows.ts，让插件 UI 等 domain 层只依赖协议类型；
 * 本仓库的 shared 协议面由协议组维护，ui 侧先在此持有等价类型，shared 补齐后改为从协议包 re-export。
 */
export interface ConversationRowsPartition {
  /** tail 之前的行；只在历史段变化时更换引用。 */
  readonly history: readonly ConversationRow[];
  /**
   * window 的后缀：包含最后一行所在轮的全部行，可能包含多轮（旧轮追加了行、或尾轮内部截断后），
   * 与 history 的轮次不相交。消费方不能假设 tail 只有一轮。
   */
  readonly tail: readonly ConversationRow[];
}
