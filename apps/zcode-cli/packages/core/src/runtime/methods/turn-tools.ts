import type { ModelCallWrapper, ToolSearchExecutionContext } from "@zcode/contracts";
import { resolveDeferredToolCall } from "../../tool/deferred-call.js";
import { createPartId, traceContextToLogContext, TurnMachineImpl } from "../deps.js";
import type {
  MessageId,
  ModelToolCall,
  ToolCallId,
  TraceContext,
  ToolCall,
  ToolExecutionResult,
} from "../deps.js";
import {
  createStreamRecoveryAnchorId,
  emitStreamRecoveryAnchor,
  emitStreamingToolLedgerUpdate,
  isErrorForToolResult,
  isTurnCancellationError,
  modelContentForToolResult,
  stringifyToolResultOutput,
  toRecordInput,
} from "../helpers/index.js";
import { persistToolResultMediaAttachments } from "../helpers/tool-result-media-persistence.js";
import type { RuntimeModelTextResult, StreamedToolExecutionResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { emitSyntheticStreamedToolError } from "./streaming-tool-synthetic-result.js";
import {
  persistPendingToolPart,
  projectToolNameForNonEmptyBoundary,
} from "./tool-part-persistence.js";
import { persistToolModelStepFinish } from "./turn-step-finish.js";
import { completedToolPartMetadata, mcpToolPartMetadata } from "./tool-part-metadata.js";
import { drainInlineGuideForNextRequest } from "./turn-guide-drain.js";
import { handleToolCallAnomalyWarnings } from "./turn-tool-warnings.js";
import { emitNestedModelUsageEvents } from "./turn-nested-model-usage.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import {
  isAutomationMutationRestrictedTurn,
  isOffPeakCreateRestrictedTurn,
  recordCompletedToolBatch,
} from "./turn-loop-state.js";
import { recordToolUsageFromResult } from "./turn-tool-usage.js";
import { recordBrowserTurnToolResult } from "../../repl/browser-turn-state.js";
import { createRuntimeToolResultEntry } from "../../agent/message-history.js";
import { commitTurnRequestEntries } from "./turn-output-token-continuation.js";
export async function executeToolCallsForModelStep(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    assistantCreatedAt: number;
    assistantMessageId: MessageId;
    modelTraceContext: TraceContext;
    result: RuntimeModelTextResult;
    streamedToolResults?: StreamedToolExecutionResult[];
    toolCalls: ModelToolCall[];
    toolSearch?: ToolSearchExecutionContext;
  },
): Promise<"continue" | "break"> {
  const model = state.model;
  if (!model) {
    throw new Error("Model-backed tool execution requires the loop Model");
  }
  const modelSelection = { providerId: model.providerId, modelId: model.modelId };
  // 包装调用的解包必须早于任何 part / 事件 / 调度：tool part、ToolCall* 事件与内部历史
  // 统一使用目标身份，包装标记只留在 part metadata 与 ToolCall 上供协议出口还原。
  // 准入失败的调用保持包装身份，由 executor 的公共准入给出配对的失败结果。
  const wrapperByCallId = new Map<string, ModelCallWrapper>();
  const coreToolCalls: ToolCall[] = options.toolCalls.map((tc) => {
    // Model step admission 已完成类型/ID 校验；空名按原值保留，让 executor 强制走 registry miss，
    // 而不是把 storage 占位值当成真实工具。
    const admission = resolveDeferredToolCall<ToolCall>(
      { ...tc, id: tc.id as ToolCallId },
      options.toolSearch,
      this.registry,
    );
    if (admission.call.modelCallWrapper)
      wrapperByCallId.set(admission.call.id, admission.call.modelCallWrapper);
    return admission.call;
  });
  const streamedResultsById = new Map(
    (options.streamedToolResults ?? []).map((entry) => [entry.toolCallId, entry]),
  );
  const toolCallById = new Map(coreToolCalls.map((toolCall) => [toolCall.id, toolCall]));
  const toolParts = new Map<
    string,
    {
      partID: ReturnType<typeof createPartId>;
      declarationIndex: number;
      input: Record<string, unknown>;
      startedAt: number;
    }
  >();
  for (const [declarationIndex, toolCall] of coreToolCalls.entries()) {
    const streamed = streamedResultsById.get(toolCall.id as ToolCallId);
    if (streamed) {
      toolParts.set(toolCall.id, {
        declarationIndex,
        partID: streamed.partID,
        input: streamed.input,
        startedAt: streamed.result.startedAt.getTime(),
      });
      if (streamed.ledgerRecorded === false) {
        await persistPendingToolPart(this, {
          assistantMessageId: options.assistantMessageId,
          declarationIndex,
          input: streamed.input,
          partID: streamed.partID,
          toolCall,
          traceContext: options.modelTraceContext,
          model,
          metadata: withModelCallWrapper(
            mcpToolPartMetadata(this.registry.getMetadata(toolCall.name)?.mcpPresentation),
            wrapperByCallId,
            toolCall.id,
          ),
        });
        await emitStreamingToolLedgerUpdate(this, state.events, options.modelTraceContext, {
          assistantMessageId: options.assistantMessageId,
          toolCall,
          status: "tool_call_closed",
          executionTiming: "during_stream",
          input: streamed.input,
        });
        await emitSyntheticStreamedToolError(
          this,
          state.events,
          options.modelTraceContext,
          streamed.result,
        );
      }
      continue;
    }
    const partID = createPartId();
    const normalizedInput = toRecordInput(toolCall.input);
    toolParts.set(toolCall.id, {
      declarationIndex,
      partID,
      input: normalizedInput,
      startedAt: Date.now(),
    });
    await persistPendingToolPart(this, {
      assistantMessageId: options.assistantMessageId,
      declarationIndex,
      input: normalizedInput,
      partID,
      toolCall,
      traceContext: options.modelTraceContext,
      model,
      metadata: withModelCallWrapper(
        mcpToolPartMetadata(this.registry.getMetadata(toolCall.name)?.mcpPresentation),
        wrapperByCallId,
        toolCall.id,
      ),
    });
    await emitStreamingToolLedgerUpdate(this, state.events, options.modelTraceContext, {
      assistantMessageId: options.assistantMessageId,
      toolCall,
      status: "tool_call_closed",
      input: normalizedInput,
    });
  }

  // assistant tool_use 已经进入 history 后，Stop 不能在 tool result
  // 创建前直接抛出。继续把 aborted signal 交给 executor，由现有取消路径为
  // 每个 tool call 生成 ToolCancelled result，再由 turn loop 感知 abort。
  const schedule = await this.scheduleTools(coreToolCalls);
  state.turnMachine = new TurnMachineImpl(
    state.turnMachine.scheduleTools(coreToolCalls, this.toScheduleState(schedule)),
  );
  const pendingToolCalls = coreToolCalls.filter(
    (toolCall) => !streamedResultsById.has(toolCall.id as ToolCallId),
  );
  let pendingExecutionResults: ToolExecutionResult[] = [];
  state.turnMachine = new TurnMachineImpl(state.turnMachine.startToolExecution());
  if (pendingToolCalls.length > 0) {
    const pendingSchedule =
      pendingToolCalls.length === coreToolCalls.length
        ? schedule
        : await this.scheduleTools(pendingToolCalls);
    const scheduledEvents = await this.emitToolScheduledEvents(
      pendingToolCalls,
      pendingSchedule,
      options.assistantMessageId,
      options.modelTraceContext,
    );
    state.events.push(...scheduledEvents);
    for (const toolCall of pendingToolCalls) {
      await emitStreamingToolLedgerUpdate(this, state.events, options.modelTraceContext, {
        assistantMessageId: options.assistantMessageId,
        toolCall,
        status: "tool_queued",
        input: toolParts.get(toolCall.id)?.input,
      });
    }

    this.logger?.debug("Executing tools", {
      streamedToolCallCount: streamedResultsById.size,
      toolCallCount: pendingToolCalls.length,
      tools: pendingToolCalls.map((tc) => tc.name),
    });
    const execution = await this.executeTools(pendingToolCalls, pendingSchedule, {
      toolSearch: options.toolSearch,
      automationTurn: isAutomationMutationRestrictedTurn(state),
      offPeakTurn: isOffPeakCreateRestrictedTurn(state),
      signal: state.turnAbortSignal,
      traceContext: options.modelTraceContext,
      subagentModelOverride: state.subagentModelOverride,
      model: state.model,
      onBatchStart: async (toolCallIds) => {
        // 已取消的 batch 仍由 executor 返回 cancelled results，但不能把从未进入
        // handler 的 tool parts 误标记为 running。
        if (state.turnAbortSignal?.aborted) return;
        for (const toolCallId of toolCallIds) {
          const toolCall = toolCallById.get(toolCallId as ToolCallId);
          if (!toolCall) continue;
          const persisted = toolParts.get(toolCall.id);
          if (!persisted) continue;
          persisted.startedAt = Date.now();
          const projectedToolName = projectToolNameForNonEmptyBoundary(toolCall.name);
          await this.persistPart(
            {
              id: persisted.partID,
              sessionID: this.sessionId,
              messageID: options.assistantMessageId,
              type: "tool",
              callID: toolCall.id,
              declarationIndex: persisted.declarationIndex,
              tool: projectedToolName.toolName,
              metadata: withModelCallWrapper(
                projectedToolName.metadata,
                wrapperByCallId,
                toolCall.id,
              ),
              state: {
                status: "running",
                input: persisted.input,
                title: projectedToolName.toolName,
                metadata:
                  mcpToolPartMetadata(this.registry.getMetadata(toolCall.name)?.mcpPresentation) ??
                  {},
                time: {
                  start: persisted.startedAt,
                },
              },
            },
            options.modelTraceContext,
          );
          await emitStreamingToolLedgerUpdate(this, state.events, options.modelTraceContext, {
            assistantMessageId: options.assistantMessageId,
            toolCall,
            status: "tool_started",
            input: persisted.input,
            startedAt: new Date(persisted.startedAt),
          });
        }
      },
    });
    pendingExecutionResults = execution.results;
    state.events.push(...execution.events);
  }
  const resultById = new Map<string, ToolExecutionResult>();
  for (const streamed of streamedResultsById.values()) {
    resultById.set(streamed.result.toolCallId, streamed.result);
  }
  for (const pending of pendingExecutionResults) {
    resultById.set(pending.toolCallId, pending);
  }
  const results = coreToolCalls
    .map((toolCall) => resultById.get(toolCall.id))
    .filter((result): result is ToolExecutionResult => result !== undefined);
  for (const result of results) {
    recordBrowserTurnToolResult({
      output: result.output,
      sessionId: this.sessionId,
      toolName: result.toolName,
      turnId: state.turnId,
    });
  }
  await emitNestedModelUsageEvents(this, {
    events: state.events,
    results,
    traceContext: options.modelTraceContext,
  });
  for (const toolResult of results) {
    const resultContent = toolResult.success
      ? modelContentForToolResult(toolResult)
      : (toolResult.error?.message ?? stringifyToolResultOutput(toolResult));
    state.turnMachine = new TurnMachineImpl(
      state.turnMachine.completeTool(toolResult.toolCallId as ToolCallId, {
        success: toolResult.success,
        content: resultContent,
      }),
    );
  }
  state.turnMachine = new TurnMachineImpl(state.turnMachine.aggregateResults());
  this.logger?.debug("Tools executed", {
    resultCount: results.length,
    results: results.map((r) => ({
      toolName: r.toolName,
      success: r.success,
      output: typeof r.output === "string" ? r.output.substring(0, 50) : "[object]",
    })),
  });

  this.logger?.debug("Injecting tool results", { resultCount: results.length });
  let deferredCheckpointCancellation: unknown;
  for (const result of results) {
    await recordToolUsageFromResult(this, result, options.modelTraceContext);
    const content = stringifyToolResultOutput(result);
    const isError = isErrorForToolResult(result);
    const projectedResultToolName = projectToolNameForNonEmptyBoundary(result.toolName);
    const persisted = toolParts.get(result.toolCallId);
    if (persisted) {
      const mediaPersistence = result.success
        ? await persistToolResultMediaAttachments({
            artifactStore: this.artifactStore,
            assistantMessageId: options.assistantMessageId,
            content: modelContentForToolResult(result),
            sessionId: this.sessionId,
            sessionStore: this.sessionStore,
            signal: state.turnAbortSignal,
            toolCallId: result.toolCallId,
            toolName: result.toolName,
            traceContext: options.modelTraceContext,
            turnId: state.turnId,
          })
        : undefined;
      await this.persistPart(
        {
          id: persisted.partID,
          sessionID: this.sessionId,
          messageID: options.assistantMessageId,
          type: "tool",
          callID: result.toolCallId,
          declarationIndex: persisted.declarationIndex,
          tool: projectedResultToolName.toolName,
          // 包装标记必须活到 completed/error：冷恢复按它还原模型协议里的外层调用。
          metadata: withModelCallWrapper(
            projectedResultToolName.metadata,
            wrapperByCallId,
            result.toolCallId,
          ),
          state: result.success
            ? {
                status: "completed",
                input: persisted.input,
                output: content,
                title: projectedResultToolName.toolName,
                metadata: {
                  ...completedToolPartMetadata(result),
                  ...(mediaPersistence
                    ? { modelContentLayout: mediaPersistence.modelContentLayout }
                    : {}),
                },
                time: {
                  start: result.startedAt.getTime(),
                  end: result.completedAt.getTime(),
                },
                ...(mediaPersistence ? { attachments: mediaPersistence.attachments } : {}),
              }
            : {
                status: "error",
                input: persisted.input,
                error: result.error?.message ?? content,
                // state.error 面向 UI / 日志，可能比模型实际收到的
                // modelContent 更笼统；仅附加保存 string 内容供冷恢复精确重放。
                metadata: {
                  ...mcpToolPartMetadata(
                    this.registry.getMetadata(result.toolName)?.mcpPresentation,
                  ),
                  ...(typeof result.modelContent === "string"
                    ? { modelContent: result.modelContent }
                    : {}),
                },
                time: {
                  start: result.startedAt.getTime(),
                  end: result.completedAt.getTime(),
                },
              },
        },
        options.modelTraceContext,
      );
    }
    this.logger?.debug("addToolResult", {
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      success: result.success,
      contentLength: content.length,
    });
    commitTurnRequestEntries(this, state.turnRequestState, [
      createRuntimeToolResultEntry(
        result.toolCallId,
        result.toolName,
        modelContentForToolResult(result),
        isError,
      ),
    ]);
    try {
      // checkpoint 是 tool result 闭合后的附加操作。Stop 若在这里
      // 触发，必须先继续提交所有 sibling tool results，不能提前进入 reminder flush。
      await this.emitFileMutationCheckpoint({
        abortSignal: state.turnAbortSignal,
        events: state.events,
        messageId: state.userMessageId,
        result,
        toolMessageId: options.assistantMessageId,
        traceContext: options.modelTraceContext,
      });
    } catch (error) {
      if (!isTurnCancellationError(error, state.turnAbortSignal)) throw error;
      deferredCheckpointCancellation ??= error;
      continue;
    }
    const toolCall = toolCallById.get(result.toolCallId as ToolCallId);
    if (toolCall) {
      const resultPartId = persisted?.partID;
      const recoveryAnchorId = createStreamRecoveryAnchorId(
        options.assistantMessageId,
        result.toolCallId as ToolCallId,
      );
      await emitStreamRecoveryAnchor(this, state.events, options.modelTraceContext, {
        assistantMessageId: options.assistantMessageId,
        toolCallId: result.toolCallId as ToolCallId,
        toolName: projectedResultToolName.toolName,
        success: result.success,
        resultPartId,
        committedAt: result.completedAt,
      });
      await emitStreamingToolLedgerUpdate(this, state.events, options.modelTraceContext, {
        assistantMessageId: options.assistantMessageId,
        toolCall,
        status: "tool_result_committed",
        executionTiming: streamedResultsById.has(result.toolCallId as ToolCallId)
          ? "during_stream"
          : "end_of_stream",
        input: persisted?.input,
        startedAt: result.startedAt,
        committedAt: result.completedAt,
        resultPartId,
        recoveryAnchorId,
      });
    }
    await enqueueFollowUpUserInputFromToolResult.call(
      this,
      state,
      result,
      options.modelTraceContext,
    );
  }

  if (deferredCheckpointCancellation) {
    throw deferredCheckpointCancellation;
  }

  const stopTurnResult = results.find((result) => result.turnControl?.stopTurnAfterResult === true);
  if (stopTurnResult) {
    await persistToolModelStepFinish(this, state, options);
    if (stopTurnResult.turnControl?.reason === "automation_create_limit") {
      // 上限错误只能由用户手动释放名额。把普通 error 继续交给模型，
      // 导致模型循环 List/Delete/Create，甚至尝试 Bash 绕过。当前 turn 只保留一次文本收口。
      state.automationCreateLimitReached = true;
      recordCompletedToolBatch(state);
      this.logger?.info("Automation create limit switched turn to text-only response", {
        event: "automation.create_limit.text_only_continuation",
        module: "core.runtime",
        reason: stopTurnResult.turnControl.reason,
        status: "completed",
        toolCallId: stopTurnResult.toolCallId,
        toolName: stopTurnResult.toolName,
      });
      return "continue";
    }
    if (state.activeTurn) {
      await this.fallbackPendingGuidesToQueue({
        activeTurn: state.activeTurn,
        events: state.events,
        reasonCode: "guide.noToolBoundary",
        traceContext: state.turnTraceContext,
      });
    }
    this.logger?.info("Tool result requested turn stop", {
      event: "tool.turn_control.stop",
      module: "core.runtime",
      reason: stopTurnResult.turnControl?.reason,
      status: "completed",
      toolCallId: stopTurnResult.toolCallId,
      toolName: stopTurnResult.toolName,
    });
    if (state.activeTurn) state.activeTurn.steerable = false;
    state.turnMachine = new TurnMachineImpl(
      state.turnMachine.complete(state.modelResponse, "success"),
    );
    return "break";
  }

  await handleToolCallAnomalyWarnings(this, state, {
    modelTraceContext: options.modelTraceContext,
    toolCalls: options.toolCalls,
  });
  await persistToolModelStepFinish(this, state, options);
  await drainInlineGuideForNextRequest(this, state);
  recordCompletedToolBatch(state);
  this.logger?.debug("After inject, message count", {
    compactToolTurnsSinceLastCompact: state.compactTracking?.toolTurnsSinceCompact,
    count: this.messageHistory.getMessageCount(),
    reactiveCompactAttemptedInCurrentModelStep: state.reactiveCompactAttemptedInCurrentModelStep,
  });
  return "continue";
}

async function enqueueFollowUpUserInputFromToolResult(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  result: ToolExecutionResult,
  traceContext: TraceContext,
): Promise<void> {
  const followUp = result.followUpUserInput;
  if (!followUp) return;

  const input = followUp.input.trim();
  if (!input) return;

  const steerResult = await this.steerTurn({
    delivery: "guide",
    expectedTurnId: state.activeTurn?.turnId,
    input,
    source: followUp.reasonSource,
    traceContext,
  });

  if (steerResult.kind === "queued") {
    this.logger?.debug("Queued follow-up user input from tool result", {
      ...traceContextToLogContext(traceContext),
      event: "tool.follow_up_user_input.queued",
      module: "core.runtime",
      pendingInputId: steerResult.pendingInputId,
      reasonSource: followUp.reasonSource,
      status: "waiting",
      toolCallId: result.toolCallId,
      toolName: result.toolName,
    });
    return;
  }

  // ExitPlanMode 审批反馈必须升级成真实 user message；
  // 如果这里被拒绝，说明 active turn 状态异常或输入超过 steer 限制，不能静默吞掉。
  this.logger?.warn("Failed to queue follow-up user input from tool result", {
    ...traceContextToLogContext(traceContext),
    activeTurnId: steerResult.activeTurnId,
    event: "tool.follow_up_user_input.rejected",
    module: "core.runtime",
    reason: steerResult.reason,
    reasonSource: followUp.reasonSource,
    status: "failed",
    toolCallId: result.toolCallId,
    toolName: result.toolName,
  });
}

/**
 * 在 part-level metadata 上附加包装标记（保留原有展示等字段）。
 * 目标 part 从 pending 起就保存 modelCallWrapper，重存、历史复制与分支恢复都保留它；
 * 冷恢复据此在 provider 请求里还原外层 DeferredToolCall 调用（见 session-history-hydrator）。
 */
function withModelCallWrapper(
  metadata: Record<string, unknown> | undefined,
  wrapperByCallId: ReadonlyMap<string, ModelCallWrapper>,
  toolCallId: string,
): Record<string, unknown> | undefined {
  const wrapper = wrapperByCallId.get(toolCallId);
  if (!wrapper) return metadata;
  return { ...metadata, modelCallWrapper: wrapper };
}

