// Modified by ZCode: 自上游 zai-org/ZCode v3.18.2 (fec97590, Apache-2.0) 并入本波数据完整性与
// 内容块顺序修复（会话行逐行降级 / blockIndex / 迁移 0023–0026 / schema_too_new 守卫）。
import type { LanguageModelUsage, TextStreamPart, ToolSet } from "ai";
import type {
  Logger,
  ModelReasoningContentBlock,
  ModelSource,
  ModelTextContentBlock,
  ModelStreamEvent,
  ModelTextResult,
  ModelToolResult,
  ModelUsage,
} from "@zcode/contracts";
import { normalizeModelToolInput } from "./tool-input-normalization.js";
import type { AiSdkGenerateTextResult } from "./runner-runtime.js";
import { asRecord, isRecord, numberProperty, stringProperty } from "./runner-record.js";
import { normalizeModelToolName } from "./tool-call-validation.js";

export function normalizeUsage(usage?: Partial<LanguageModelUsage>): ModelUsage {
  const rawUsage = isRecord(usage?.raw) ? usage.raw : undefined;
  const rawServerToolUse = isRecord(rawUsage?.server_tool_use)
    ? rawUsage.server_tool_use
    : undefined;
  const webSearchRequests = numberProperty(rawServerToolUse, "web_search_requests");
  const webFetchRequests = numberProperty(rawServerToolUse, "web_fetch_requests");

  return {
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    totalTokens: usage?.totalTokens,
    cacheReadTokens: usage?.inputTokenDetails?.cacheReadTokens,
    cacheWriteTokens: usage?.inputTokenDetails?.cacheWriteTokens,
    reasoningTokens: usage?.outputTokenDetails?.reasoningTokens,
    ...(webSearchRequests !== undefined || webFetchRequests !== undefined
      ? {
          serverToolUse: {
            webFetchRequests,
            webSearchRequests,
          },
        }
      : {}),
  };
}

export function normalizeReasoning(
  reasoning?: readonly {
    providerMetadata?: unknown;
    text?: string;
    type?: string;
  }[],
): ModelReasoningContentBlock[] | undefined {
  if (!reasoning || reasoning.length === 0) {
    return undefined;
  }

  return reasoning
    .filter((part) => part.type === "reasoning" && typeof part.text === "string")
    .map((part) => ({
      type: "reasoning",
      text: part.text!,
      providerOptions: isRecord(part.providerMetadata) ? part.providerMetadata : undefined,
    }));
}

/**
 * 非流式结果按 AI SDK result.content 的顺序给 reasoning、text、tool-call 编号
 * （上游 v3.18.2 docs/design/v2/model/assistant-block-order.md），跳过 tool-result、source、file 等其他类型。
 * 与已规范化的 text / reasoning / toolCalls 对不上时不编号，返回 undefined，调用方按旧数据处理。
 */
export function orderGeneratedContent(
  result: AiSdkGenerateTextResult,
  normalized: {
    text: string;
    reasoning?: ModelReasoningContentBlock[];
    toolCalls?: ModelTextResult["toolCalls"];
  },
): ModelTextContentBlock[] | undefined {
  const content = (result as unknown as { content?: unknown[] }).content;
  if (!Array.isArray(content)) return undefined;
  const reasoning = normalized.reasoning ?? [];
  const toolCallById = new Map((normalized.toolCalls ?? []).map((call) => [call.id, call]));
  const textBlocks: ModelTextContentBlock[] = [];
  const reasoningIndices: number[] = [];
  const toolIndices = new Map<string, number>();
  let nextBlockIndex = 0;
  for (const part of content) {
    const record = asRecord(part);
    const type = stringProperty(record, "type");
    if (type === "reasoning" && typeof record?.text === "string") {
      reasoningIndices.push(nextBlockIndex++);
    } else if (type === "text" && typeof record?.text === "string") {
      textBlocks.push({ type: "text", text: record.text, blockIndex: nextBlockIndex++ });
    } else if (type === "tool-call") {
      const toolCallId = stringProperty(record, "toolCallId");
      if (toolCallId) toolIndices.set(toolCallId, nextBlockIndex);
      nextBlockIndex++;
    }
  }
  if (
    reasoningIndices.length !== reasoning.length ||
    textBlocks.map((block) => block.text).join("") !== normalized.text ||
    toolIndices.size !== toolCallById.size ||
    [...toolCallById.keys()].some((id) => !toolIndices.has(id))
  ) {
    return undefined;
  }
  reasoning.forEach((block, index) => {
    block.blockIndex = reasoningIndices[index];
  });
  for (const [id, blockIndex] of toolIndices) toolCallById.get(id)!.blockIndex = blockIndex;
  return textBlocks;
}

export function toModelStreamEvent(chunk: TextStreamPart<ToolSet>): ModelStreamEvent | undefined {
  switch (chunk.type) {
    case "start":
      return {
        type: "start",
      };

    case "text-start":
      return {
        type: "text_start",
        id: chunk.id,
      };

    case "text-delta":
      return {
        type: "text_delta",
        id: chunk.id,
        text: chunk.text,
      };

    case "text-end":
      return {
        type: "text_end",
        id: chunk.id,
      };

    case "reasoning-start":
      return {
        type: "reasoning_start",
        id: chunk.id,
        providerMetadata: isRecord(chunk.providerMetadata) ? chunk.providerMetadata : undefined,
      };

    case "reasoning-delta":
      return {
        type: "reasoning_delta",
        id: chunk.id,
        text:
          stringProperty(asRecord(chunk), "delta") ?? stringProperty(asRecord(chunk), "text") ?? "",
        providerMetadata: isRecord(chunk.providerMetadata) ? chunk.providerMetadata : undefined,
      };

    case "reasoning-end":
      return {
        type: "reasoning_end",
        id: chunk.id,
        providerMetadata: isRecord(chunk.providerMetadata) ? chunk.providerMetadata : undefined,
      };

    case "tool-input-start": {
      const inputStartToolName = normalizeModelToolName(chunk.toolName, {
        providerExecuted: chunk.providerExecuted,
        source: "streamText",
        streamChunkType: chunk.type,
        toolCallId: chunk.id,
      });
      return {
        type: "tool_input_start",
        id: chunk.id,
        providerExecuted: chunk.providerExecuted,
        toolName: inputStartToolName,
      };
    }

    case "tool-input-delta":
      return {
        type: "tool_input_delta",
        id: chunk.id,
        delta: chunk.delta,
      };

    case "tool-input-end":
      return {
        type: "tool_input_end",
        id: chunk.id,
      };

    case "tool-call": {
      return {
        type: "tool_call",
        toolCall: {
          id: chunk.toolCallId,
          // Final tool-call 的 name/input 由 assembler 统一校验和归一化。
          name: chunk.toolName,
          providerExecuted: chunk.providerExecuted,
          // 执行参数只取 AI SDK final tool-call，避免从展示用 delta 猜测输入，
          // 也避免 stream/model-io 多次解析并重复告警。
          input: chunk.input,
        },
      };
    }

    case "finish":
      return {
        type: "finish",
        finishReason: chunk.finishReason,
        providerMetadata: buildFinishProviderMetadata(chunk),
        usage: normalizeUsage(chunk.totalUsage),
      };

    case "error":
      return {
        type: "error",
        error: chunk.error,
      };

    default:
      return undefined;
  }
}

export function normalizeToolCalls(
  result: AiSdkGenerateTextResult,
  logger?: Logger,
): ModelTextResult["toolCalls"] {
  const toolCalls = (result as unknown as { toolCalls?: unknown[] }).toolCalls;
  if (!Array.isArray(toolCalls)) return undefined;

  return toolCalls.map((toolCall, index) => {
    const value = toolCall as {
      toolCallId?: string;
      id?: string;
      toolName?: string;
      name?: string;
      input?: unknown;
      args?: unknown;
      providerExecuted?: boolean;
    };
    const id = value.toolCallId ?? value.id ?? crypto.randomUUID();
    const name = normalizeModelToolName(value.toolName ?? value.name, {
      providerExecuted: value.providerExecuted,
      source: "generateText",
      toolCallId: id,
      toolCallIndex: index,
    });

    return {
      id,
      name,
      providerExecuted: value.providerExecuted,
      // 上游会把 JSON "null" 转成原生 null；显式 null 不能被
      // nullish fallback 擦成旧版 args，否则 runtime 与 provider-visible input 漂移。
      input: normalizeModelToolInput(value.input !== undefined ? value.input : value.args, {
        logger,
        source: "generateText",
        toolName: name,
      }),
    };
  });
}

export function normalizeToolResults(
  result: AiSdkGenerateTextResult,
  normalizedToolCalls?: ModelTextResult["toolCalls"],
): ModelToolResult[] | undefined {
  const toolResults = (result as unknown as { toolResults?: unknown[] }).toolResults;
  if (!Array.isArray(toolResults)) return undefined;
  const normalizedInputByToolCallId = new Map(
    (normalizedToolCalls ?? []).map((toolCall) => [toolCall.id, toolCall.input]),
  );

  const normalized = toolResults.map((toolResult) => {
    const value = toolResult as {
      toolCallId?: string;
      id?: string;
      toolName?: string;
      name?: string;
      input?: unknown;
      output?: unknown;
      result?: unknown;
      providerExecuted?: boolean;
      providerMetadata?: unknown;
    };

    const id = value.toolCallId ?? value.id ?? crypto.randomUUID();
    return {
      id,
      name: value.toolName ?? value.name ?? "unknown",
      // AI SDK 会为 invalid tool-call 生成携带原始 input 的 tool-error。
      // 复用同 id final call 的归一化结果，避免 malformed string/null 从 toolResults 泄漏。
      input: normalizedInputByToolCallId.has(id)
        ? normalizedInputByToolCallId.get(id)
        : value.input,
      output: value.output ?? value.result,
      providerExecuted: value.providerExecuted,
      providerMetadata: isRecord(value.providerMetadata)
        ? (value.providerMetadata as Record<string, unknown>)
        : undefined,
    };
  });

  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeSources(result: AiSdkGenerateTextResult): ModelSource[] | undefined {
  const sources = (result as unknown as { sources?: unknown[] }).sources;
  if (!Array.isArray(sources)) return undefined;

  const normalized = sources
    .map((source): ModelSource | undefined => {
      if (!isRecord(source)) return undefined;
      const sourceType = stringProperty(source, "sourceType");
      if (sourceType !== "url" && sourceType !== "document") return undefined;

      return {
        type: "source",
        sourceType,
        id: stringProperty(source, "id"),
        url: stringProperty(source, "url"),
        title: stringProperty(source, "title"),
        mediaType: stringProperty(source, "mediaType"),
        filename: stringProperty(source, "filename"),
        providerMetadata: isRecord(source.providerMetadata)
          ? (source.providerMetadata as Record<string, unknown>)
          : undefined,
      };
    })
    .filter((source): source is ModelSource => source !== undefined);

  return normalized.length > 0 ? normalized : undefined;
}

function buildFinishProviderMetadata(
  chunk: TextStreamPart<ToolSet>,
): Record<string, unknown> | undefined {
  if (chunk.type !== "finish") return undefined;

  const record = asRecord(chunk);
  const providerMetadata = isRecord(record.providerMetadata) ? { ...record.providerMetadata } : {};
  const response = isRecord(record.response) ? record.response : undefined;
  const responseBody = response && isRecord(response.body) ? response.body : undefined;

  const merged = {
    ...providerMetadata,
    ...(response ? { response } : {}),
    ...(responseBody ?? {}),
    ...(record.rawFinishReason === undefined ? {} : { rawFinishReason: record.rawFinishReason }),
  };

  return Object.keys(merged).length > 0 ? merged : undefined;
}
