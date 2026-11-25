import { createPartId } from "../deps.js";
import type { MessageId, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RuntimeModelStreamSnapshot } from "../types.js";
import { hasAssistantReasoningContent } from "./turn-output-token-continuation.js";
import { persistTextBlockParts } from "./message-persistence.js";

export async function persistCancelledStreamSnapshot(
  runtime: AgentRuntimeInternal,
  options: {
    assistantCreatedAt: number;
    assistantMessageId: MessageId;
    snapshot: RuntimeModelStreamSnapshot;
    traceContext: TraceContext;
  },
): Promise<void> {
  // 用户 stop 时模型请求会以异常退出，成功路径里的最终 text/reasoning
  // 持久化不会执行；这里只 flush 已经到达本进程的 text/reasoning，工具仍等终态路径处理。
  const completedAt = Date.now();
  for (const reasoning of options.snapshot.reasoning) {
    if (!hasAssistantReasoningContent(reasoning)) continue;
    await runtime.persistPart(
      {
        id: createPartId(),
        sessionID: runtime.sessionId,
        messageID: options.assistantMessageId,
        type: "reasoning",
        text: reasoning.text,
        ...(reasoning.blockIndex !== undefined ? { blockIndex: reasoning.blockIndex } : {}),
        metadata: reasoning.providerOptions,
        time: {
          start: options.assistantCreatedAt,
          end: completedAt,
        },
      },
      options.traceContext,
    );
  }
  if (!options.snapshot.text) {
    return;
  }
  // 与成功路径同一写入口：取消时按快照里的文字块各写一个 part，冷恢复与 live 才能一样一块一行。
  await persistTextBlockParts(
    runtime,
    {
      messageId: options.assistantMessageId,
      textBlocks: options.snapshot.textBlocks,
      text: options.snapshot.text,
      time: { start: options.assistantCreatedAt, end: completedAt },
    },
    options.traceContext,
  );
}
