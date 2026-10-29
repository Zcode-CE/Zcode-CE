import {
  COMPACT_PROMPT_TOO_LONG_USER_MESSAGE,
  CoreErrorType,
  createCoreError,
  formatCompactSummary,
} from "../deps.js";
import type {
  CompactTimelinePayload,
  SessionEvent,
  SessionEventType,
  TraceContext,
} from "../deps.js";
import {
  buildProviderRequestMessages,
  createModelContextExceededFinishError,
  isContextExceededFinishReason,
  readRawFinishReason,
} from "../helpers/index.js";
import type { RuntimeModelTextResult, RunModelTextRequestOptions } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { Model } from "../deps.js";
import type { ToolRegistry } from "../../tool/registry.js";
import {
  DEFERRED_TOOL_CALL_NAME,
  TOOL_SEARCH_NAME,
  type ModelToolContract,
  type ToolSearchMode,
} from "@zcode/contracts";
import { buildToolExposure } from "../../tool/search/exposure.js";

const COMPACT_TOOL_USE_DENIAL_MESSAGE = "Tool use is not allowed during compaction";
const COMPACT_TOOL_USE_DENIAL_REASON = "compaction agent should only produce text summary";
// Compact summary 只需要 Read + 搜索控制入口 + MCP 目录；其他工具不参与摘要。
const COMPACT_RESIDENT_TOOL_NAMES: ReadonlySet<string> = new Set(["Read"]);
const COMPACT_TOOL_KEEP_MAX_COUNT = 100;

export function createCompactPromptTooLongError(options: {
  attempt: number;
  cause?: unknown;
  preCompactTokenCount: number;
}): Error {
  return createCoreError(CoreErrorType.ModelContextExceeded, COMPACT_PROMPT_TOO_LONG_USER_MESSAGE, {
    cause: options.cause instanceof Error ? options.cause : undefined,
    context: {
      compactPromptTooLongAttempts: options.attempt,
      preCompactTokenCount: options.preCompactTokenCount,
    },
    recoverable: true,
    // compact 内部已经完成最多 3 次旧轮次截断重试；
    // 最终仍超窗时不能再被 auto compact 外层重试放大成 3x3。
    retryable: false,
  });
}

export function createCompactContextExceededFinishError(
  result: RuntimeModelTextResult,
): Error | undefined {
  const rawFinishReason = readRawFinishReason(result.providerMetadata);
  if (
    !isContextExceededFinishReason(result.finishReason, rawFinishReason) &&
    !isCompactEmptyLengthFinish(result)
  ) {
    return undefined;
  }

  return createModelContextExceededFinishError({
    finishReason: result.finishReason,
    rawFinishReason,
  });
}

function isCompactEmptyLengthFinish(result: RuntimeModelTextResult): boolean {
  // GLM/Z.AI compact 可能以 length + 空文本完成，真实含义是没有可保存的 summary；
  // 仅在 compact 路径把它归类为超窗压力，复用已有 prompt-too-long 降输入重试。
  return result.finishReason.trim().toLowerCase() === "length" && result.text.trim().length === 0;
}

export async function persistCompactTimelineEvent(
  runtime: AgentRuntimeInternal,
  type: SessionEventType,
  payload: CompactTimelinePayload,
  traceContext: TraceContext,
  events: SessionEvent[],
): Promise<void> {
  await runtime.persistCompactTimeline(payload, traceContext);
  const event = runtime.createEvent(type, payload, traceContext);
  await runtime.appendEvent(event, traceContext);
  events.push(event);
}

export function buildCompactSummaryRequestMessages(
  entriesForSummary: readonly RuntimeMessageEntry[],
  compactPrompt: string,
  options: {
    useMidConversationSystem?: boolean;
    loadedToolCallIds?: ReadonlySet<string>;
  } = {},
): RunModelTextRequestOptions["messages"] {
  return buildProviderRequestMessages({
    entries: [...entriesForSummary, { message: { role: "user" as const, content: compactPrompt } }],
    applyCacheControl: true,
    skipCacheWrite: true,
    useMidConversationSystem: options.useMidConversationSystem,
    loadedToolCallIds: options.loadedToolCallIds,
  }).messages;
}

/**
 * Compact summary 发给模型的工具候选。
 *
 * Bug 根因：只看 provider 能力会在 ToolSearch 被禁用或全部常驻时绕过数量保护，
 * 让大量 MCP schema 再次撑大压缩请求；搜索真正不可启用时恢复原普通工具策略。
 * 工具数与搜索能力都只在这里判定一次，实际曝光裁剪由 prepareRuntimeProviderRequest 负责。
 */
export function selectCompactSummaryTools(input: {
  model: Model;
  mode?: ToolSearchMode;
  registry: Pick<ToolRegistry, "get">;
  tools: readonly ModelToolContract[];
}): ModelToolContract[] {
  const searchCandidates = input.tools.filter(
    (tool) =>
      COMPACT_RESIDENT_TOOL_NAMES.has(tool.name) ||
      tool.name === TOOL_SEARCH_NAME ||
      tool.name === DEFERRED_TOOL_CALL_NAME ||
      input.registry.get(tool.name)?.metadata.mcpPresentation,
  );
  if (
    buildToolExposure({
      model: input.model,
      mode: input.mode,
      tools: searchCandidates,
      registry: input.registry,
      entries: [],
    }).enabled
  ) {
    return searchCandidates;
  }

  const plainTools = input.tools.filter(
    (tool) => tool.name !== TOOL_SEARCH_NAME && tool.name !== DEFERRED_TOOL_CALL_NAME,
  );
  // 止血原因：massive MCP 工具会把 compact summary request 的 provider context 撑爆。
  return plainTools.length > COMPACT_TOOL_KEEP_MAX_COUNT ? [] : plainTools;
}

export function formatCompactSummaryOrThrow(
  runtime: AgentRuntimeInternal,
  result: RuntimeModelTextResult,
): string {
  const compactToolCalls = runtime.extractToolCallsFromResult(result);
  if (compactToolCalls.length > 0) {
    throw createCoreError(CoreErrorType.ModelError, COMPACT_TOOL_USE_DENIAL_MESSAGE, {
      context: {
        behavior: "deny",
        decisionReason: {
          reason: COMPACT_TOOL_USE_DENIAL_REASON,
          type: "other",
        },
        toolNames: compactToolCalls.map((toolCall) => toolCall.name),
      },
      recoverable: true,
      retryable: false,
    });
  }

  const summary = formatCompactSummary(result.text);
  if (!summary) {
    throw createCoreError(CoreErrorType.ModelError, "Failed to generate compact summary", {
      recoverable: true,
      retryable: true,
    });
  }
  return summary;
}
