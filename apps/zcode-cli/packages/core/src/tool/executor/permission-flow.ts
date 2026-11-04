import {
  CoreErrorType,
  createCoreError,
  isCoreError,
  traceContextToLogContext,
  type CollaborationMode,
  type PermissionBrokerRequest,
  type PermissionBrokerResult,
  type PermissionRuleset,
  type TraceContext,
  type ToolExecutionSpanWriter,
} from "@zcode/contracts";
import type { HookRunResult } from "../../hooks/index.js";
import type { PermissionContext } from "../../permission/service.js";
import type { ExecutableToolCall, ToolEntry, ToolExecutionResult } from "../types.js";
import { normalizeToolExecutionInput } from "../input-normalization.js";
import { resolveToolApproval } from "./approval-gate.js";
import { createErrorResult, createPermissionErrorResult } from "./errors.js";
import { emitPermissionDenied, emitPermissionRequested, emitPermissionResolved } from "./events.js";
import { applyPreToolPermissionDecision, runPermissionRequestHooks } from "./hook-flow.js";
import { racePermissionResponders } from "./permission-responder-race.js";
import {
  loadProjectPermissionRuleset,
  persistProjectPermissionUpdates,
} from "./permission-rules-persistence.js";
import {
  resolveRuntimePermissionCapability,
  resolveRuntimePermissionContext,
} from "./permission-capability.js";
import { buildDefaultPermissionUpdates } from "./permission-suggestions.js";
import { recheckPermissionHookModifiedInput } from "./permission-input-recheck.js";
// Modified by ZCode:F6：确认窗里批准前的调整落进入参（授权之后、handler 之前）。
import { applyPermissionInputAdjustments } from "./permission-input-adjustments.js";
import type { ToolExecutorDeps } from "./types.js";
import { summarizeInput } from "./utils.js";
import { validateInput } from "./validation.js";
import { applyMemoryFilePermission } from "./memory-file-permission.js";

// Modified by ZCode:F3（自上游 permission-response.ts 合并）：guarded 的 user-once 应答形状校验。
// 单次确认不能被任何规则持久化（permissionUpdates / sessionPermissionUpdates 必须为空），
// modify 必须带 modifiedInput；越界形状直接抛 InvalidInput，而不是替用户做决定。
function validatePermissionResponse(response: PermissionBrokerResult, once: boolean): void {
  if (
    !response ||
    !["allow", "deny", "modify", ...(once ? [] : ["escalate"])].includes(response.decision) ||
    (response.reason !== undefined && typeof response.reason !== "string") ||
    (response.permissionUpdates !== undefined &&
      (!Array.isArray(response.permissionUpdates) ||
        (once && response.permissionUpdates.length > 0))) ||
    (response.decision === "modify" && response.modifiedInput === undefined) ||
    (response.sessionPermissionUpdates !== undefined &&
      (!Array.isArray(response.sessionPermissionUpdates) ||
        (once && response.sessionPermissionUpdates.length > 0)))
  ) {
    throw createCoreError(
      CoreErrorType.InvalidInput,
      "Invalid permission response; single-use requests cannot persist project rules",
      { recoverable: true },
    );
  }
}

type ToolPermissionFlowResult =
  | {
      allowed: true;
      executionInput: unknown;
      permissionWaitMs?: number;
      // Modified by ZCode:F6：确认窗调整中实际生效的那部分（applyInputAdjustments 的 applied）。
      inputAdjustments?: Readonly<Record<string, unknown>>;
    }
  | { allowed: false; result: ToolExecutionResult };

export async function resolveToolPermission(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  entry: ToolEntry,
  executionInput: unknown,
  preToolHookResult: HookRunResult,
  mode: CollaborationMode,
  traceContext: TraceContext,
  signal?: AbortSignal,
  telemetry?: ToolExecutionSpanWriter,
): Promise<ToolPermissionFlowResult> {
  const permissionContext: PermissionContext = {
    toolName: toolCall.name,
    input: executionInput,
    riskLevel: entry.metadata.riskLevel,
    mode,
    prePlanMode: deps.sessionModePort?.getPrePlanMode(),
    planEnabled: deps.sessionModePort?.isPlanEnabled?.(),
    // workflow 草稿免确认要按工作目录解析相对路径，见 PermissionService 的
    // isPreapprovedWorkflowDraftWrite。
    workingDirectory: deps.getWorkingDirectory(),
  };
  const runtimePermissionContext = resolveRuntimePermissionContext(deps);
  const rulePolicy = entry.resolvePermissionRulePolicy?.(executionInput, runtimePermissionContext);
  const suggestedPermissionUpdates =
    rulePolicy?.suggestedPermissionUpdates ??
    buildDefaultPermissionUpdates(toolCall.name, executionInput, entry.permissionCapabilityGroup);

  let projectRules: PermissionRuleset | null;
  try {
    projectRules = await loadProjectPermissionRuleset(deps);
  } catch (error) {
    return {
      allowed: false,
      result: createErrorResult(
        toolCall,
        createCoreError(CoreErrorType.StorageError, "Failed to load project permission rules", {
          cause: error instanceof Error ? error : undefined,
          context: { sessionId: deps.sessionId, toolCallId: toolCall.id, toolName: toolCall.name },
          recoverable: true,
        }),
      ),
    };
  }

  let permissionDecision = deps.permissionService.checkPermission(
    permissionContext,
    resolveRuntimePermissionCapability(entry, executionInput, runtimePermissionContext),
    projectRules,
    rulePolicy,
  );
  permissionDecision = applyPreToolPermissionDecision(permissionDecision, preToolHookResult, mode);
  permissionDecision = applyMemoryFilePermission({
    decision: permissionDecision,
    executionInput,
    memoryRoot: deps.getMemoryRoot?.(),
    toolName: toolCall.name,
    workingDirectory: deps.getWorkingDirectory(),
    workspaceRoot: deps.getWorkspaceRoot(),
  });

  deps.logger?.debug("Tool permission evaluated", {
    ...traceContextToLogContext(traceContext),
    decision: permissionDecision.decision,
    event: "tool.permission.evaluated",
    inputSummary: summarizeInput(toolCall.input),
    mode,
    module: "core.tool.executor",
    reason: permissionDecision.reason,
    riskLevel: permissionDecision.riskLevel,
    ruleId: permissionDecision.ruleId,
    sideEffectScope: permissionDecision.sideEffectScope,
    status:
      permissionDecision.decision === "allow"
        ? "completed"
        : permissionDecision.decision === "ask"
          ? "waiting"
          : "failed",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
  });

  if (permissionDecision.allowed) {
    telemetry?.setPermissionDecision("not_required");
    return { allowed: true, executionInput };
  }

  if (permissionDecision.decision === "deny") {
    telemetry?.setPermissionDecision("denied");
    await emitPermissionDenied(deps, toolCall, permissionDecision.reason, traceContext);

    deps.logger?.warn("Tool permission denied", {
      ...traceContextToLogContext(traceContext),
      decision: permissionDecision.decision,
      event: "tool.permission.denied",
      mode,
      module: "core.tool.executor",
      reason: permissionDecision.reason,
      ruleId: permissionDecision.ruleId,
      status: "failed",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    });
    return {
      allowed: false,
      result: createPermissionErrorResult(toolCall, permissionDecision.reason, {
        decision: permissionDecision.decision,
        mode,
        ruleId: permissionDecision.ruleId,
      }),
    };
  }

  // 传 rulePolicy：Bash 用它在运行时收窄选项集（危险命令不得持久授权），
  // 静态的 entry.permission.askOptions 表达不了「取决于这次命令内容」的策略。
  const toolApproval = resolveToolApproval(
    deps,
    toolCall,
    entry,
    executionInput,
    traceContext,
    rulePolicy,
  );
  // 判定自带的选项策略（Plan 下的 MCP 询问）覆盖工具声明的策略。
  const approval =
    permissionDecision.optionsPolicy && toolApproval.gate === "ask"
      ? { ...toolApproval, optionsPolicy: permissionDecision.optionsPolicy }
      : toolApproval;
  if (approval.gate === "proceed") {
    telemetry?.setPermissionDecision("not_required");
    return { allowed: true, executionInput };
  }

  const requestId = `perm_${crypto.randomUUID()}`;
  telemetry?.markPermissionRequested();
  await emitPermissionRequested(
    deps,
    toolCall,
    executionInput,
    requestId,
    permissionDecision.riskLevel,
    permissionDecision.reason,
    suggestedPermissionUpdates,
    traceContext,
    approval,
  );

  let brokerResult: PermissionBrokerResult;
  let normalizedHookModifiedInput: unknown;
  let useNormalizedHookModifiedInput = false;
  const permissionWaitStartedAt = Date.now();
  try {
    // 这里曾经串行 `await runPermissionRequestHooks(...)`，
    // broker 要等 hook 链返回才启动。同步 PermissionRequest hook（外部审批桥接）阻塞期间，
    // 确认窗已经渲染（上面的 emitPermissionRequested），但应答 deferred 尚未注册，用户的
    // 每一次点击都被 resolveInteraction 按幂等语义静默丢弃——确认窗永久死亡。
    // 修法：hook 链与 broker 并发竞速，先到的决定生效，败者被 abort 且不被等待。
    const raceOutcome = await racePermissionResponders({
      onHookFailure: (error) => {
        // hook 链故障只令其退赛：辅助应答方的基础设施故障不应替用户做拒绝决定，
        // 确认窗继续等待 broker 应答。
        deps.logger?.warn("PermissionRequest hook chain failed; waiting for client decision", {
          ...traceContextToLogContext(traceContext),
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "tool.permission.hook_race_forfeited",
          module: "core.tool.executor",
          requestId,
          status: "waiting",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
        });
      },
      requestBroker: (brokerSignal, claimResponse) =>
        deps.permissionBroker.requestPermission(
          {
            input: executionInput,
            mode,
            reason: permissionDecision.reason ?? `Tool ${toolCall.name} requires approval`,
            requestId,
            requestedAt: new Date(),
            riskLevel: permissionDecision.riskLevel,
            ruleId: permissionDecision.ruleId,
            sessionId: deps.sessionId,
            sideEffectScope: permissionDecision.sideEffectScope,
            suggestedPermissionUpdates,
            ...(approval.optionsPolicy ? { optionsPolicy: approval.optionsPolicy } : {}),
            // Modified by ZCode:F3：user-once 单次确认随请求下发，broker 不得改成持久规则。
            ...(permissionDecision.approvalMode
              ? { approvalMode: permissionDecision.approvalMode }
              : {}),
            toolCallId: toolCall.id as PermissionBrokerRequest["toolCallId"],
            toolName: toolCall.name,
            traceId: traceContext.traceId,
            turnId: traceContext.turnId ?? deps.turnId,
          },
          {
            signal: brokerSignal,
            claimResponse,
            timeoutMs: deps.permissionTimeoutMs,
          },
        ),
      runHooks: (hookSignal) =>
        runPermissionRequestHooks(
          deps,
          toolCall,
          executionInput,
          requestId,
          permissionDecision,
          mode,
          traceContext,
          hookSignal,
        ),
      ...(signal === undefined ? {} : { signal }),
    });
    brokerResult = raceOutcome.result;
    const permissionHookResult = raceOutcome.source === "hook" ? raceOutcome.result : undefined;

    if (permissionHookResult?.decision === "modify") {
      normalizedHookModifiedInput = normalizeToolExecutionInput({
        entry,
        input: permissionHookResult.modifiedInput ?? executionInput,
        logger: deps.logger,
        source: "permission",
      });
      useNormalizedHookModifiedInput = true;
      if (!validateInput(normalizedHookModifiedInput, entry)) {
        // PermissionRequest hook 可以改写目标路径，修改后的输入不能沿用修改前的权限结果。
        const recheck = await recheckPermissionHookModifiedInput({
          deps,
          entry,
          mode,
          modifiedInput: normalizedHookModifiedInput,
          projectRules,
          requestId,
          signal,
          toolCall,
          traceContext,
        });
        if (recheck.permissionDecision) permissionDecision = recheck.permissionDecision;
        if (recheck.brokerResult) {
          brokerResult = recheck.brokerResult;
          useNormalizedHookModifiedInput = brokerResult.decision === "allow";
        }
      }
    }
  } catch (error) {
    telemetry?.setPermissionDecision("denied");
    const coreError = isCoreError(error)
      ? error
      : createCoreError(CoreErrorType.PermissionDenied, "Permission request failed", {
          cause: error instanceof Error ? error : undefined,
          context: { requestId, toolCallId: toolCall.id, toolName: toolCall.name },
          recoverable: true,
        });
    await emitPermissionResolved(
      deps,
      toolCall,
      requestId,
      {
        decision: "deny",
        reason: coreError.message,
        resolvedAt: new Date(),
      },
      traceContext,
    );
    return { allowed: false, result: createErrorResult(toolCall, coreError) };
  }

  // Modified by ZCode:F3：guarded 的单次确认（user-once）要求 broker 应答形状合法：
  // 不得携带任何持久/会话规则更新（不可绕过的确认不能被规则化），modify 必须带 modifiedInput。
  if (mode === "guarded") {
    validatePermissionResponse(brokerResult, permissionDecision.approvalMode === "user-once");
  }

  const resolvedPermission = {
    ...brokerResult,
    resolvedAt: brokerResult.resolvedAt ?? new Date(),
  };
  const permissionWaitMs = Math.max(0, Math.round(Date.now() - permissionWaitStartedAt));
  await emitPermissionResolved(deps, toolCall, requestId, resolvedPermission, traceContext);

  deps.logger?.info("Tool permission resolved", {
    ...traceContextToLogContext(traceContext),
    decision: resolvedPermission.decision,
    event: "tool.permission.resolved",
    mode,
    module: "core.tool.executor",
    reason: resolvedPermission.reason,
    requestId,
    status:
      resolvedPermission.decision === "allow" || resolvedPermission.decision === "modify"
        ? "completed"
        : "failed",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
  });

  if (resolvedPermission.decision === "deny") {
    telemetry?.setPermissionDecision("denied");
    return {
      allowed: false,
      result: createPermissionErrorResult(
        toolCall,
        resolvedPermission.reason,
        {
          decision: resolvedPermission.decision,
          mode,
          reasonSource: resolvedPermission.reasonSource,
          requestId,
          ruleId: permissionDecision.ruleId,
        },
        resolvedPermission.preserveReasonFormatting
          ? { preserveReasonFormatting: true }
          : undefined,
      ),
    };
  }

  if (resolvedPermission.decision === "escalate") {
    telemetry?.setPermissionDecision("denied");
    return {
      allowed: false,
      result: createErrorResult(
        toolCall,
        createCoreError(
          CoreErrorType.PermissionEscalation,
          resolvedPermission.reason ?? `Permission escalation requested for ${toolCall.name}`,
          {
            context: {
              decision: resolvedPermission.decision,
              mode,
              requestId,
              ruleId: permissionDecision.ruleId,
              toolName: toolCall.name,
            },
            recoverable: true,
          },
        ),
      ),
    };
  }

  if (resolvedPermission.permissionUpdates?.length) {
    try {
      await persistProjectPermissionUpdates(
        deps,
        resolvedPermission.permissionUpdates,
        traceContext,
      );
    } catch (error) {
      return {
        allowed: false,
        result: createErrorResult(
          toolCall,
          createCoreError(
            CoreErrorType.StorageError,
            "Failed to persist project permission update",
            {
              cause: error instanceof Error ? error : undefined,
              context: {
                requestId,
                sessionId: deps.sessionId,
                toolCallId: toolCall.id,
                toolName: toolCall.name,
              },
              recoverable: true,
            },
          ),
        ),
      };
    }
  }

  if (resolvedPermission.sessionPermissionUpdates?.length) {
    // 会话免确认：只进内存里的会话 ruleset，
    // 与上面的项目级持久化互不可见。
    deps.permissionService.grantSessionPermission(resolvedPermission.sessionPermissionUpdates);
    deps.logger?.info("Session permission granted", {
      ...traceContextToLogContext(traceContext),
      event: "tool.permission.session_grant.applied",
      module: "core.tool.executor",
      requestId,
      status: "completed",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      updateCount: resolvedPermission.sessionPermissionUpdates.length,
    });
  }

  telemetry?.setPermissionDecision("granted");
  if (resolvedPermission.decision !== "modify") {
    // Modified by ZCode:F6：确认窗的调整落进入参（声明了 applyInputAdjustments 的工具才应用）。
    const adjusted = applyPermissionInputAdjustments({
      deps,
      entry,
      toolCall,
      executionInput: useNormalizedHookModifiedInput
        ? normalizedHookModifiedInput
        : executionInput,
      adjustments: resolvedPermission.inputAdjustments,
      traceContext,
    });
    if (!adjusted.ok) return { allowed: false, result: adjusted.result };
    return {
      allowed: true,
      executionInput: adjusted.executionInput,
      permissionWaitMs,
      ...(adjusted.applied === undefined ? {} : { inputAdjustments: adjusted.applied }),
    };
  }

  const modifiedInput = useNormalizedHookModifiedInput
    ? normalizedHookModifiedInput
    : normalizeToolExecutionInput({
        entry,
        input: resolvedPermission.modifiedInput ?? executionInput,
        logger: deps.logger,
        source: "permission",
      });
  const modifiedInputValidation = validateInput(modifiedInput, entry);
  if (modifiedInputValidation) {
    return {
      allowed: false,
      result: createErrorResult(toolCall, modifiedInputValidation),
    };
  }
  // Modified by ZCode:F6：modify 与调整叠加时先走 schema 校验，再把调整落在最终入参上。
  const adjustedModify = applyPermissionInputAdjustments({
    deps,
    entry,
    toolCall,
    executionInput: modifiedInput,
    adjustments: resolvedPermission.inputAdjustments,
    traceContext,
  });
  if (!adjustedModify.ok) return { allowed: false, result: adjustedModify.result };
  return {
    allowed: true,
    executionInput: adjustedModify.executionInput,
    permissionWaitMs,
    ...(adjustedModify.applied === undefined ? {} : { inputAdjustments: adjustedModify.applied }),
  };
}
