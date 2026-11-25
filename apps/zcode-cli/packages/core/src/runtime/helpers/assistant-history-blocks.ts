import type {
  AssistantHistoryBlock,
  ToolCallInput,
} from "../../agent/message-history.js";
import { hasOrderedAssistantHistoryBlocks } from "../../agent/message-history.js";
import type { RuntimeModelTextResult } from "../types.js";

/**
 * 从一次模型结果构造有序块。上游 v3.18.2 的同一函数还包含服务端内置工具轮次；
 * CE 没有该机制，所以这里只有正文块与本地工具调用（等价实现，块集合相同）。
 *
 * 没有 textBlocks 时返回 undefined：非流式未编号、或旧适配层结果，调用方按旧条目提交，
 * 行为与改动前完全一致（旧数据硬护栏）。
 */
export function orderedAssistantHistoryBlocks(
  output: Pick<RuntimeModelTextResult, "reasoning" | "textBlocks">,
  localToolCalls?: readonly ToolCallInput[],
): AssistantHistoryBlock[] | undefined {
  if (!output.textBlocks) return undefined;
  const blocks: AssistantHistoryBlock[] = [
    ...(output.reasoning ?? []).map(
      (block): AssistantHistoryBlock => ({ kind: "content", block }),
    ),
    ...output.textBlocks.map(
      (block): AssistantHistoryBlock => ({ kind: "content", block }),
    ),
    ...(localToolCalls ?? []).map((call): AssistantHistoryBlock => ({ kind: "tool", call })),
  ];
  return hasOrderedAssistantHistoryBlocks(blocks) ? blocks : undefined;
}
