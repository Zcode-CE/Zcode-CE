import type { ToolSearchExecutionContext } from "@zcode/contracts";
import { TurnMachineImpl, createPartId } from "../deps.js";
import type {
  MessageId,
  Model,
  ModelToolCall,
  ToolCall,
  ToolCallId,
  TraceContext,
} from "../deps.js";
import {
  emitStreamingToolLedgerUpdate,
  requireRuntimeToolCallName,
  toRecordInput,
  throwIfTurnAborted,
} from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { StreamedToolExecutionResult } from "../types.js";
import { createSyntheticStreamedToolResult } from "./streaming-tool-synthetic-result.js";
import {
  beginStreamRecoveryAttempt,
  emitStreamRecoveryRetryEvents,
  emitStreamRecoveryStarted,
  hasStreamRecoveryBudget,
  recoverPartialAssistantOutputFailure,
} from "./streaming-recovery.js";
import { executeToolCallsForModelStep } from "./turn-tools.js";
import { mcpToolPartMetadata } from "./tool-part-metadata.js";
import { persistPendingToolPart } from "./tool-part-persistence.js";
import {
  isAutomationMutationRestrictedTurn,
  isOffPeakCreateRestrictedTurn,
  recordModelHistoryRound,
  type RegularTurnLoopState,
} from "./turn-loop-state.js";
import { createRuntimeAssistantEntry } from "../../agent/message-history.js";
import { commitTurnRequestEntries } from "./turn-output-token-continuation.js";

const STREAMING_TOOL_CANCEL_DRAIN_TIMEOUT_MS = 250;
const STREAMING_TOOL_EXECUTION_MODE = "readOnly";

interface StreamingToolCoordinator {
  accept(toolCall: ModelToolCall): void;
  abandon(reason: "cancelled" | "model_failed"): Promise<void>;
  drain(toolCalls: readonly ModelToolCall[]): Promise<StreamedToolExecutionResult[]>;
  recordReasoningDelta(text: string): void;
  recordTextDelta(text: string): void;
  recoverFromModelFailure(
    error: unknown,
    assistantCreatedAt: number,
    options?: { failedRequestId?: string },
  ): Promise<boolean>;
}

export function createStreamingToolCoordinator(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    assistantMessageId: MessageId;
    model: Model;
    /** 传给 executor 的搜索上下文：DeferredToolCall 的准入在 executor 公共边界完成。 */
    toolSearch?: ToolSearchExecutionContext;
    traceContext: TraceContext;
  },
): StreamingToolCoordinator {
  const abortController = new AbortController();
  const handles = new Map<string, Promise<StreamedToolExecutionResult | undefined>>();
  const acceptedToolCalls = new Map<string, ModelToolCall>();
  let discardedReasoningBytes = 0;
  let discardedTextBytes = 0;

  const abortOnTurnCancel = () => abortController.abort();
  state.turnAbortSignal.addEventListener("abort", abortOnTurnCancel, { once: true });

  return {
    accept(toolCall) {
      // model.ts 已完成 runtime admission。这里必须保留空名原值，使正常 finish
      // 走 end-of-stream registry miss，同时让 finish 前断流保留 synthetic interrupted error。
      const normalizedToolCall = { ...toolCall };
      if (normalizedToolCall.providerExecuted) return;
      acceptedToolCalls.set(normalizedToolCall.id, normalizedToolCall);
      if (!shouldExecuteToolDuringStream(runtime, normalizedToolCall)) return;
      if (handles.has(normalizedToolCall.id)) return;
      const promise = executeDuringStream(runtime, state, {
        abortSignal: abortController.signal,
        assistantMessageId: options.assistantMessageId,
        // model admission 已去重；只读工具可能先落盘，序号必须来自全部本地声明。
        declarationIndex: acceptedToolCalls.size - 1,
        model: options.model,
        toolSearch: options.toolSearch,
        toolCall: normalizedToolCall,
        traceContext: options.traceContext,
      }).catch(async (error) => {
        runtime.logger?.warn("Streaming tool execution fell back to end-of-stream execution", {
          error: error instanceof Error ? error.message : String(error),
          event: "tool.streaming.execution_failed",
          module: "core.runtime",
          status: "failed",
          toolCallId: normalizedToolCall.id,
          toolName: normalizedToolCall.name,
        });
        return undefined;
      });
      handles.set(normalizedToolCall.id, promise);
    },

    async abandon(reason) {
      abortController.abort();
      const status = reason === "cancelled" ? "tool_cancelled" : "tool_abandoned";
      await Promise.all(
        Array.from(acceptedToolCalls.values()).map((toolCall) =>
          emitStreamingToolLedgerUpdate(runtime, state.events, options.traceContext, {
            assistantMessageId: options.assistantMessageId,
            toolCall: {
              id: toolCall.id as ToolCallId,
              input: toolCall.input,
              name: toolCall.name,
            },
            status,
            executionTiming: "during_stream",
            blockedReason: reason,
          }),
        ),
      );
      await raceWithTimeout(
        Promise.allSettled(handles.values()),
        STREAMING_TOOL_CANCEL_DRAIN_TIMEOUT_MS,
      );
      state.turnAbortSignal.removeEventListener("abort", abortOnTurnCancel);
    },

    async drain(toolCalls) {
      const results: StreamedToolExecutionResult[] = [];
      for (const toolCall of toolCalls) {
        const handle = handles.get(toolCall.id);
        if (!handle) continue;
        const result = await handle;
        if (result) results.push(result);
      }
      state.turnAbortSignal.removeEventListener("abort", abortOnTurnCancel);
      return results;
    },

    recordReasoningDelta(text) {
      discardedReasoningBytes += new TextEncoder().encode(text).byteLength;
    },

    recordTextDelta(text) {
      discardedTextBytes += new TextEncoder().encode(text).byteLength;
    },

    async recoverFromModelFailure(error, assistantCreatedAt, recoveryOptions = {}) {
      if (state.turnAbortSignal.aborted || !hasStreamRecoveryBudget(state)) return false;
      const recoveryEventOptions = {
        ...options,
        ...(recoveryOptions.failedRequestId
          ? { failedRequestId: recoveryOptions.failedRequestId }
          : {}),
      };
      if (acceptedToolCalls.size === 0) {
        return recoverPartialAssistantOutputFailure({
          abortController,
          assistantCreatedAt,
          discardedReasoningBytes,
          discardedTextBytes,
          error,
          options: recoveryEventOptions,
          runtime,
          state,
          turnAbortListener: abortOnTurnCancel,
        });
      }
      abortController.abort();
      const recoveryAttempt = beginStreamRecoveryAttempt(state);
      const toolCalls = Array.from(acceptedToolCalls.values());
      const settledResults = await collectCompletedResults(handles, toolCalls);
      const settledResultById = new Map(
        settledResults.map((result) => [result.toolCallId, result]),
      );
      const streamedToolResults = toolCalls.map(
        (toolCall) =>
          settledResultById.get(toolCall.id as ToolCallId) ??
          createSyntheticStreamedToolResult(
            toolCall,
            handles.has(toolCall.id) ? "unknown_execution_state" : "not_executed",
          ),
      );
      await emitStreamRecoveryStarted(runtime, state, recoveryEventOptions, error, recoveryAttempt);
      state.modelResponse = "";
      state.modelStepCount += 1;
      recordModelHistoryRound(state);
      state.toolCallCount += streamedToolResults.length;
      // 合并修复：恢复请求依赖 assistant tool-call 与随后 tool result 成对出现。
      // 因此必须同步推进本轮 request history，不能只更新 canonical history。
      commitTurnRequestEntries(runtime, state.turnRequestState, [
        createRuntimeAssistantEntry("", toolCalls, undefined, options.model),
      ]);
      state.turnMachine = new TurnMachineImpl(state.turnMachine.receiveModelResponse(""));
      await executeToolCallsForModelStep.call(runtime, state, {
        toolSearch: options.toolSearch,
        assistantCreatedAt,
        assistantMessageId: options.assistantMessageId,
        modelTraceContext: options.traceContext,
        result: {
          finishReason: "tool-calls",
          providerMetadata: { recoveredFromStreamFailure: true },
          text: "",
          toolCalls,
          usage: {},
        },
        streamedToolResults,
        toolCalls,
      });
      await emitStreamRecoveryRetryEvents(runtime, state, recoveryEventOptions, {
        ...recoveryAttempt,
        discardedReasoningBytes,
        discardedTextBytes,
        reason: "latest_committed_tool_result",
        toolCallIds: streamedToolResults.map((result) => result.toolCallId),
      });
      state.turnAbortSignal.removeEventListener("abort", abortOnTurnCancel);
      return true;
    },
  };
}

async function executeDuringStream(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    abortSignal: AbortSignal;
    assistantMessageId: MessageId;
    declarationIndex: number;
    model: Model;
    toolSearch?: ToolSearchExecutionContext;
    toolCall: ModelToolCall;
    traceContext: TraceContext;
  },
): Promise<StreamedToolExecutionResult | undefined> {
  throwIfTurnAborted(state.turnAbortSignal);
  const toolName = requireRuntimeToolCallName(options.toolCall, {
    logger: runtime.logger,
    model: options.model,
    source: "streamingToolCoordinator.executeDuringStream",
    traceContext: options.traceContext,
  });
  const toolCall: ToolCall = {
    id: options.toolCall.id as ToolCallId,
    input: options.toolCall.input,
    name: toolName,
  };
  const partID = createPartId();
  const input = toRecordInput(toolCall.input);
  const metadata = mcpToolPartMetadata(
    runtime.registry.getMetadata(toolCall.name)?.mcpPresentation,
  );
  // during_stream 是 pending/running part 的首个 durable writer；若绕过
  // turn-tools 的 metadata 写入，Stop 发生在 drain 前时冷恢复只能退化成通用工具卡。
  await persistPendingToolPart(runtime, {
    assistantMessageId: options.assistantMessageId,
    declarationIndex: options.declarationIndex,
    input,
    metadata,
    model: options.model,
    partID,
    toolCall,
    traceContext: options.traceContext,
  });
  await emitStreamingToolLedgerUpdate(runtime, state.events, options.traceContext, {
    assistantMessageId: options.assistantMessageId,
    toolCall,
    status: "tool_call_closed",
    executionTiming: "during_stream",
    input,
  });

  const schedule = await runtime.scheduleTools([toolCall]);
  const scheduledEvents = await runtime.emitToolScheduledEvents(
    [toolCall],
    schedule,
    options.assistantMessageId,
    options.traceContext,
  );
  state.events.push(...scheduledEvents);
  await emitStreamingToolLedgerUpdate(runtime, state.events, options.traceContext, {
    assistantMessageId: options.assistantMessageId,
    toolCall,
    status: "tool_queued",
    executionTiming: "during_stream",
    input,
  });

  const execution = await runtime.executeTools([toolCall], schedule, {
    subagentModelOverride: state.subagentModelOverride,
    model: state.model,
    toolSearch: options.toolSearch,
    automationTurn: isAutomationMutationRestrictedTurn(state),
    offPeakTurn: isOffPeakCreateRestrictedTurn(state),
    signal: options.abortSignal,
    traceContext: options.traceContext,
    onBatchStart: async () => {
      const startedAt = Date.now();
      await runtime.persistPart(
        {
          id: partID,
          sessionID: runtime.sessionId,
          messageID: options.assistantMessageId,
          type: "tool",
          callID: toolCall.id,
          declarationIndex: options.declarationIndex,
          tool: toolCall.name,
          state: {
            status: "running",
            input,
            title: toolCall.name,
            metadata: metadata ?? {},
            time: {
              start: startedAt,
            },
          },
        },
        options.traceContext,
      );
      await emitStreamingToolLedgerUpdate(runtime, state.events, options.traceContext, {
        assistantMessageId: options.assistantMessageId,
        toolCall,
        status: "tool_started",
        executionTiming: "during_stream",
        input,
        startedAt: new Date(startedAt),
      });
    },
  });
  state.events.push(...execution.events);
  const result = execution.results[0];
  if (!result) return undefined;
  return {
    input,
    ledgerRecorded: true,
    partID,
    result,
    toolCallId: toolCall.id as ToolCallId,
  };
}

function shouldExecuteToolDuringStream(
  runtime: AgentRuntimeInternal,
  toolCall: ModelToolCall,
): boolean {
  if (toolCall.providerExecuted) return false;
  if (toolCall.name.trim().length === 0) return false;
  if (runtime.config.modelStreaming !== "on") return false;
  if ((runtime.config.streamingToolExecution ?? STREAMING_TOOL_EXECUTION_MODE) === "off") {
    return false;
  }
  const entry = runtime.registry.get(toolCall.name);
  if (!entry) return false;
  const metadata = entry.metadata;
  const sideEffectScope = entry.permission?.sideEffectScope ?? metadata.sideEffectScope;
  const requiresUserInteraction = entry.requiresUserInteraction ?? metadata.requiresUserInteraction;
  return (
    metadata.readOnly &&
    metadata.concurrentSafe &&
    !metadata.destructive &&
    !metadata.needsApproval &&
    !requiresUserInteraction &&
    sideEffectScope === "none"
  );
}

async function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function collectCompletedResults(
  handles: Map<string, Promise<StreamedToolExecutionResult | undefined>>,
  toolCalls: readonly ModelToolCall[],
): Promise<StreamedToolExecutionResult[]> {
  const settled = await Promise.all(
    toolCalls.map((toolCall) => {
      const handle = handles.get(toolCall.id);
      if (!handle) return undefined;
      return raceWithTimeout(
        handle.catch(() => undefined),
        STREAMING_TOOL_CANCEL_DRAIN_TIMEOUT_MS,
      );
    }),
  );
  return settled.filter((result): result is StreamedToolExecutionResult => result !== undefined);
}
