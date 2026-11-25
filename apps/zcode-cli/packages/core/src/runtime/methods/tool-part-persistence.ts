import type {
  CompletedToolPartMetadata,
  MessageId,
  Model,
  PartId,
  ToolCall,
  TraceContext,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { requireRuntimeToolCallName } from "../helpers/index.js";

const EMPTY_TOOL_NAME_PLACEHOLDER = "empty_tool_name";
const PROVIDER_TOOL_NAME_METADATA_KEY = "providerToolName";

interface NonEmptyToolNameProjection {
  metadata?: Record<string, unknown>;
  toolName: string;
}

export function projectToolNameForNonEmptyBoundary(toolName: string): NonEmptyToolNameProjection {
  if (toolName.trim().length > 0) {
    return { toolName };
  }
  return {
    metadata: { [PROVIDER_TOOL_NAME_METADATA_KEY]: toolName },
    toolName: EMPTY_TOOL_NAME_PLACEHOLDER,
  };
}

export async function persistPendingToolPart(
  runtime: AgentRuntimeInternal,
  options: {
    assistantMessageId: MessageId;
    /** 块到达序号；旧路径（非流式未编号）没有，写入时省略。 */
    blockIndex?: number;
    declarationIndex: number;
    input: Record<string, unknown>;
    partID: PartId;
    toolCall: ToolCall;
    traceContext: TraceContext;
    /** part-level metadata：MCP 展示 + 包装标记等结构化附加项，原样落盘供冷恢复读取。 */
    metadata?: Record<string, unknown>;
    model: Model;
  },
): Promise<void> {
  const projected =
    typeof options.toolCall.name === "string" && options.toolCall.name.trim().length === 0
      ? projectToolNameForNonEmptyBoundary(options.toolCall.name)
      : {
          toolName: requireRuntimeToolCallName(options.toolCall, {
            logger: runtime.logger,
            model: options.model,
            source: "persistPendingToolPart",
            traceContext: options.traceContext,
          }),
        };
  await runtime.persistPart(
    {
      id: options.partID,
      sessionID: runtime.sessionId,
      messageID: options.assistantMessageId,
      type: "tool",
      callID: options.toolCall.id,
      ...(options.blockIndex !== undefined ? { blockIndex: options.blockIndex } : {}),
      declarationIndex: options.declarationIndex,
      tool: projected.toolName,
      metadata: {
        ...projected.metadata,
        ...options.metadata,
      },
      state: {
        status: "pending",
        input: options.input,
        raw: JSON.stringify({
          tool: projected.toolName,
          input: options.toolCall.input,
        }),
      },
    },
    options.traceContext,
  );
}
