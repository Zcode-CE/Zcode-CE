import { updateUiLocaleInFileConfig, type ConfigResult } from "@zcode/adapters/config";
import type { AgentRuntime } from "@zcode/core";
import { resolveLocale } from "@zcode/i18n";
import { normalizeModelSelection, type ModelSelection } from "@zcode/provider";
import {
  SESSION_ENTRY_MODEL_SELECTION,
  traceContextToLogContext,
  type CollaborationMode,
  type ExecutionPort,
  type GoalStatus,
  type Logger,
  type LoggerFactory,
  type LocalSettingStorePort,
  type McpPort,
  type McpServerConfig,
  type MessageId,
  type ProjectId,
  type SessionId,
  type SessionStorePort,
  type SupportedLocale,
  type TraceContext,
  type TurnInputIntentMetadata,
  type UiLocale,
  type UiThemePreference,
} from "@zcode/contracts";
import { listMcpServerStatuses } from "../mcp-config.js";
import { loadSessionTranscriptFromStore } from "../session-transcript.js";
import { createSubagentObservation } from "./subagent-observation.js";
import { getLocaleConfigPath } from "./locale-selection.js";
import { isClosableSessionStore } from "./session-store.js";
import type { ProviderRegistryModelSource } from "./provider-registry-model-runtime.js";
import {
  completeAuxiliaryRegistryModelSelection,
  getRegistryBackedModel,
  listRegistryBackedModels,
  requireRegistryThoughtLevel,
  resolveRegistryModelSelection,
  resolveRegistryOwnedModelSelection,
  resolveRegistryOwnedSelection,
  resolveRegistryThoughtLevel,
  type ResolvedRegistrySelection,
} from "./provider-registry-selection.js";
import type { PrepareUserExecutionBoundary, ZCodeApp } from "./types.js";

type SessionFacade = Pick<
  ZCodeApp,
  | "readBackgroundBashOutput"
  | "cancelBackgroundTask"
  | "clearTarget"
  | "close"
  | "connectMcpServer"
  | "disconnectMcpServer"
  | "generateWorkspaceText"
  | "testModelConnectivity"
  | "forkFromCheckpoint"
  | "getMode"
  | "getModel"
  | "getCurrentModelOption"
  | "getModelOption"
  | "getLocale"
  | "getDefaultThoughtLevel"
  | "getThoughtLevel"
  | "getTheme"
  | "listCheckpoints"
  | "listMcpServers"
  | "listModels"
  | "listThoughtLevels"
  | "loadSessionTranscript"
  | "readSubagents"
  | "readSubagentTranscript"
  | "readTodos"
  | "readTarget"
  | "setCustomSessionTitle"
  | "setMode"
  | "setModel"
  | "setThoughtLevel"
  | "setLocale"
  | "setTarget"
  | "updateTargetStatus"
>;

const DEFAULT_SESSION_RESOURCE_CLOSE_TIMEOUT_MS = 6_000;

interface SessionResourceCloseInput {
  beginShutdown: () => void;
  closeBrowserSession: () => Promise<void>;
  closeExecution?: () => Promise<void> | void;
  closeMcp?: () => Promise<void> | void;
  closeNodeReplBrowserBroker?: () => Promise<void> | void;
  closeSessionStore?: () => void;
  logger: Logger;
  timeoutMs?: number;
}

interface CreateSessionFacadeDeps {
  /**
   * 停下本会话拥有的 dwf run：
   * run service 的 `close()`。缺席即本装配没有 dwf 端口（journal 窄化失败、测试装配）。
   */
  closeDynamicWorkflowRuns?: () => Promise<void>;
  closeNodeReplBrowserBroker?: () => Promise<void> | undefined;
  configResult: ConfigResult;
  configuredMcpServers: Record<string, McpServerConfig>;
  configuredDefaultModelSelection?: ModelSelection;
  executionPort: ExecutionPort;
  localSettingStore?: LocalSettingStorePort;
  logger: Logger;
  loggerFactory: LoggerFactory;
  mcpPort?: McpPort;
  ownsExecutionPort: boolean;
  ownsMcpPort: boolean;
  ownsSessionStore: boolean;
  prepareUserExecutionBoundary: PrepareUserExecutionBoundary;
  prepareResume(traceContext?: TraceContext): Promise<void>;
  projectID: ProjectId;
  providerRegistry: ProviderRegistryModelSource;
  resolveUiLocale(locale: UiLocale): SupportedLocale;
  runtime: AgentRuntime;
  sessionId: SessionId;
  sessionStore: SessionStorePort;
  traceContext: TraceContext;
  untrustedProjectMcpServers: Set<string>;
  workingDirectory: string;
}

export function createSessionFacade(deps: CreateSessionFacadeDeps): SessionFacade {
  let closePromise: Promise<void> | undefined;
  let currentLocale = resolveLocale(deps.configResult.config.ui.locale);
  const currentRegistrySelection = ():
    | { owned: false }
    | {
        owned: true;
        registry: ProviderRegistryModelSource;
        selection?: ResolvedRegistrySelection;
      } => {
    const registry = deps.providerRegistry;
    const selection = deps.runtime.getSessionModelSelection();
    if (!selection) return { owned: false };
    const { providerId } = selection;
    if (!registry.getProvider(providerId)) return { owned: false };
    const resolved = resolveRegistryModelSelection(registry, selection);
    return resolved ? { owned: true, registry, selection: resolved } : { owned: true, registry };
  };

  const readTargetWithInterruptedRunRecovery = async () => {
    const target = await deps.sessionStore.readTarget({
      sessionID: deps.sessionId,
    });
    if (
      !deps.runtime.getActiveTurnInfo() &&
      target?.activeInputId &&
      target.activeRunStartedAtMs != null &&
      deps.sessionStore.recoverInterruptedTargetRun
    ) {
      // 上次 app/agent 退出可能留下未清空的 active_run_started_at。
      // 这里不能用当前时间结算，否则离线时间会被算进 goal 运行时长；store 会用 last_seen 收口。
      return await deps.sessionStore.recoverInterruptedTargetRun({
        sessionID: deps.sessionId,
      });
    }
    return target;
  };

  const setTargetStatus = async (
    action: "cleared" | "set" | "status_updated",
    input: {
      objective?: string;
      displayText?: string;
      status?: GoalStatus;
      tokenBudget?: number | null;
      intent?: TurnInputIntentMetadata;
    },
  ) => {
    const visibleObjective = action === "set" ? (input.objective ?? "").trim() : undefined;
    const visibleGoalQuery =
      action === "set" ? input.displayText?.trim() || visibleObjective : undefined;
    // /goal 不走普通 prompt 提交流程，但它会先把 session 持久化。
    // 必须在首次持久化前走统一用户执行边界，否则 runtime/bash_shell_selection
    // 会因为当时 selection 为空而缺失，冷恢复时退回 legacy shell fallback。
    await deps.prepareUserExecutionBoundary({
      traceContext: deps.traceContext,
    });
    await deps.runtime.ensureSessionPersistedForExternalActivity(
      visibleObjective ?? `/goal ${input.status ?? "clear"}`,
      { traceContext: deps.traceContext },
    );
    const previousTarget = await deps.sessionStore.readTarget({
      sessionID: deps.sessionId,
    });
    const target =
      action === "set"
        ? await deps.sessionStore.setTarget({
            objective: visibleObjective ?? "",
            sessionID: deps.sessionId,
            status: input.status,
            tokenBudget: input.tokenBudget,
          })
        : action === "status_updated"
          ? await deps.sessionStore.updateTargetStatus({
              sessionID: deps.sessionId,
              status: input.status ?? "active",
            })
          : null;

    if (action === "cleared") {
      const cleared = await deps.sessionStore.clearTarget({
        sessionID: deps.sessionId,
      });
      if (cleared) {
        await deps.runtime.recordGoalStateChangeReminder({
          text: goalStateChangeReminderText("cleared"),
          traceContext: deps.traceContext,
        });
      }
      // TUI 和协议客户端可能在重连或恢复后仍缓存旧 goal。
      // 即使 session store 已经是空，也要把显式 clear 投影成 target:null，
      // 让客户端不能只因为“No goal to clear.”这条文本而继续保留旧面板。
      await deps.runtime.recordTargetChanged({
        action,
        previousTarget,
        source: "command",
        target,
        traceContext: deps.traceContext,
      });
      return cleared;
    }
    if (target) {
      if (visibleObjective !== undefined) {
        // /goal 同时是控制命令和用户 query。旧路径只把解析后的 objective
        // 落库，且 live 事件里没有这条输入；因此首轮实时列表为空，冷恢复后也丢失
        // `/goal` / `/target` / `replace` 原文。target 继续存 canonical objective，
        // 可见消息单独保留协议层传入的原始 display text。
        await deps.runtime.recordExternalUserPrompt(visibleGoalQuery ?? visibleObjective, {
          goalSummaryTargetID: target.targetID,
          intent: input.intent,
          traceContext: deps.traceContext,
        });
      }
      const reminderAction =
        input.status === "paused" && previousTarget?.status !== "paused"
          ? "paused"
          : input.status === "active" && previousTarget?.status === "paused"
            ? "resumed"
            : undefined;
      const reminderText = goalStateChangeReminderText(reminderAction);
      if (reminderText) {
        await deps.runtime.recordGoalStateChangeReminder({
          text: reminderText,
          traceContext: deps.traceContext,
        });
      }
      await deps.runtime.recordTargetChanged({
        action,
        previousTarget,
        source: "command",
        target,
        traceContext: deps.traceContext,
      });
    }
    return target;
  };

  return {
    close: async () => {
      closePromise ??= (async () => {
        // 关闭入口先阻止新调度并取消在飞 Memory Extraction，再等待取消链路收口。
        deps.runtime.beginShutdown();
        await deps.runtime.drainMemoryExtractions(60_000);
        // 引擎归本 App 所有，所以关闭要主动停下它。
        // 位置是两个约束夹出来的：在 beginShutdown **之后**，结算带出的终态通知才会被丢掉
        // （background-notifications.ts 在 shuttingDown 时不入队），不会把正在关闭的会话的模型
        // 叫醒；在 closeSessionResources **之前**，子代理还有 execution / MCP / session store
        // 可以干净地中止，引擎也还有 journal 可以写自己那一笔 stopped(interrupted)。
        if (deps.closeDynamicWorkflowRuns !== undefined) {
          try {
            await deps.closeDynamicWorkflowRuns();
          } catch (error: unknown) {
            // 卡住或抛错的 dwf 关闭绝不能吃掉资源关闭（同下面并行关闭那条注释的论证）：
            // 记一条 warn 继续走，最坏情况是那个 run 留成孤儿行，下一次构造时被收敛。
            deps.logger.warn?.(
              "Closing dynamic workflow runs failed; continuing to close resources",
              {
                errorMessage: error instanceof Error ? error.message : String(error),
                event: "dynamic_workflow.service.close_failed",
                module: "bootstrap.app",
              },
            );
          }
        }
        const closableSessionStore =
          deps.ownsSessionStore && isClosableSessionStore(deps.sessionStore)
            ? deps.sessionStore
            : undefined;
        await closeSessionResources({
          beginShutdown: () => deps.runtime.beginShutdown(),
          closeBrowserSession: () => deps.runtime.closeBrowserSession(),
          closeExecution:
            deps.ownsExecutionPort && deps.executionPort.close
              ? () => deps.executionPort.close?.()
              : undefined,
          closeMcp: deps.ownsMcpPort && deps.mcpPort ? () => deps.mcpPort?.close() : undefined,
          closeNodeReplBrowserBroker: deps.closeNodeReplBrowserBroker,
          closeSessionStore: closableSessionStore ? () => closableSessionStore.close() : undefined,
          logger: deps.logger,
        });
      })();
      return await closePromise;
    },
    getMode: () => deps.runtime.getMode(),
    getModel: () => formatLegacyRuntimeModelValue(deps.runtime.getSessionModelSelection()),
    getLocale: () => currentLocale,
    getTheme: () => deps.configResult.config.ui.theme as UiThemePreference,
    getDefaultThoughtLevel: () => {
      const registryState = currentRegistrySelection();
      return registryState.owned
        ? resolveRegistryThoughtLevel(registryState.selection)
        : deps.runtime.getSessionModelSelection()?.options?.reasoningLevel;
    },
    // 当前档位只读会话事实；缺失时不能借默认档位伪装成已完成选择。
    getThoughtLevel: () => deps.runtime.getSessionModelSelection()?.options?.reasoningLevel,
    loadSessionTranscript: async () =>
      await loadSessionTranscriptFromStore({
        sessionId: deps.sessionId,
        sessionStore: deps.sessionStore,
      }),
    ...createSubagentObservation(deps),
    readTodos: async () => deps.sessionStore.readTodos({ sessionID: deps.sessionId }),
    readTarget: readTargetWithInterruptedRunRecovery,
    setCustomSessionTitle: async (input) =>
      deps.runtime.setCustomSessionTitle({
        title: input.title,
        // 透传乐观锁：调用方（automation-port 的标题冻结）只覆盖自动标题，
        // 用户手动命名（titleSource=custom）必须跳过（zcode-plugins issue #60）。
        ...(input.expectedTitleSources ? { expectedTitleSources: input.expectedTitleSources } : {}),
        traceContext: input.traceContext ?? deps.traceContext,
      }),
    setTarget: async (input) =>
      (await setTargetStatus("set", input)) as Awaited<ReturnType<ZCodeApp["setTarget"]>>,
    updateTargetStatus: async (status) =>
      (await setTargetStatus("status_updated", { status })) as Awaited<
        ReturnType<ZCodeApp["updateTargetStatus"]>
      >,
    clearTarget: async () => (await setTargetStatus("cleared", {})) as boolean,
    listModels: () => {
      return listRegistryBackedModels(deps.providerRegistry);
    },
    getCurrentModelOption: () => {
      const selection = deps.runtime.getSessionModelSelection();
      return selection && getRegistryBackedModel(deps.providerRegistry, selection);
    },
    getModelOption: (selection) => getRegistryBackedModel(deps.providerRegistry, selection),
    listThoughtLevels: () => {
      const registryState = currentRegistrySelection();
      return registryState.owned
        ? [...(registryState.selection?.model.config.optionSpecs.reasoningLevel.values ?? [])]
        : [];
    },
    listMcpServers: async () =>
      listMcpServerStatuses(
        deps.mcpPort,
        deps.configuredMcpServers,
        deps.untrustedProjectMcpServers,
      ),
    connectMcpServer: async (name) => {
      const config = deps.configuredMcpServers[name];
      if (!config) {
        throw new Error(`MCP server is not configured: ${name}`);
      }
      if (!deps.mcpPort) {
        throw new Error("MCP is disabled");
      }
      return deps.mcpPort.connectServer(name, config, {
        trace: deps.traceContext,
        workingDirectory: deps.workingDirectory,
      });
    },
    readBackgroundBashOutput: (workId, sessionId) =>
      deps.runtime.readBackgroundBashOutput(workId, sessionId),
    cancelBackgroundTask: async (taskId, options) =>
      deps.runtime.cancelBackgroundTask(taskId, {
        traceContext: options?.traceContext ?? deps.traceContext,
      }),
    disconnectMcpServer: async (name) => {
      if (!deps.mcpPort) return undefined;
      return deps.mcpPort.disconnectServer(name);
    },
    listCheckpoints: async (options) => {
      await deps.prepareResume();
      return deps.runtime.listWorkspaceCheckpoints(options);
    },
    forkFromCheckpoint: async (options) => {
      await deps.prepareResume(options?.traceContext);
      return deps.runtime.forkWorkspaceFromCheckpoint({
        targetCheckpointId: options?.targetCheckpointId,
        targetMessageId: options?.targetMessageId as MessageId | undefined,
        traceContext: options?.traceContext ?? deps.traceContext,
      });
    },
    generateWorkspaceText: async (input, options) => {
      // 辅助文本入口只规范化模型身份；具体的最低档位由 Core 的辅助请求调用点显式决定。
      const selection =
        normalizeModelSelection(deps.providerRegistry.getView(), input.selection) ??
        input.selection;
      return await deps.runtime.generateWorkspaceText(
        { ...input, selection },
        {
          abortSignal: options?.abortSignal,
          traceContext: options?.traceContext ?? deps.traceContext,
        },
      );
    },
    testModelConnectivity: async (input, options) => {
      // 连接测试用的 Model 也要先绑定最低档位，否则严格 Factory 会先因缺档位失败。
      const selection = completeAuxiliaryRegistryModelSelection(
        deps.providerRegistry,
        input.selection,
      );
      await deps.runtime.testModelConnectivity(
        { ...input, selection },
        {
          abortSignal: options?.abortSignal,
          traceContext: options?.traceContext ?? deps.traceContext,
        },
      );
    },
    setMode: async (mode: CollaborationMode) => {
      const previousMode = deps.runtime.getMode();
      await deps.runtime.setExecutionState({ mode }, deps.traceContext);
      if (deps.localSettingStore) {
        try {
          await deps.localSettingStore.saveProjectPermissionMode({
            mode: deps.runtime.getMode(),
            projectID: deps.projectID,
          });
        } catch (error) {
          deps.logger.warn("Project mode preference write failed", {
            ...traceContextToLogContext(deps.traceContext),
            error: error instanceof Error ? error.message : String(error),
            event: "local_setting.permission_mode.write_failed",
            mode,
            module: "bootstrap",
            projectId: deps.projectID,
            status: "failed",
          });
        }
      }
      deps.logger.info("Session mode updated", {
        ...traceContextToLogContext(deps.traceContext),
        event: "session.mode.updated",
        mode,
        module: "bootstrap",
        previousMode,
        status: "completed",
      });
      return {
        mode: deps.runtime.getMode(),
        previousMode,
        traceId: deps.traceContext.traceId,
      };
    },
    setModel: async (modelId, options) => {
      // 配置命令已提交完整 Selection；转成字符串会丢档位。先整体校验再一次
      // 更新/保存，非法档位不能留下已换模型的半次修改。旧字符串入口保留只改身份语义。
      const registrySelection =
        typeof modelId === "string"
          ? resolveRegistryOwnedSelection(
              deps.providerRegistry,
              modelId,
              deps.configuredDefaultModelSelection,
              { allowMissingReasoning: true },
            )
          : resolveRegistryOwnedModelSelection(deps.providerRegistry, modelId);
      if (!registrySelection) {
        throw new Error(`Provider Registry 中不存在 Model: ${modelId}`);
      }
      const previousSelection = deps.runtime.getSessionModelSelection();
      const previousModel = formatLegacyRuntimeModelValue(previousSelection);
      const model = formatLegacyRuntimeModelValue(registrySelection.selection);
      const sessionSelection: ModelSelection = {
        providerId: registrySelection.selection.providerId,
        modelId: registrySelection.selection.modelId,
        ...(typeof modelId !== "string" && registrySelection.selection.options
          ? { options: { ...registrySelection.selection.options } }
          : {}),
      };
      deps.runtime.setSessionModelSelection(sessionSelection);
      if (!options?.transient) {
        deps.runtime.recordPendingModelChange({
          fromModel: previousSelection,
          fromModelLabel: previousModel,
          toModel: sessionSelection,
          toModelLabel: model,
        });
        await persistSessionModelSelection(deps);
      }
      deps.logger.info("Session model updated", {
        ...traceContextToLogContext(deps.traceContext),
        event: "session.model.updated",
        model,
        module: "bootstrap",
        previousModel,
        status: "completed",
      });
      return {
        model,
        previousModel,
        traceId: deps.traceContext.traceId,
      };
    },
    setThoughtLevel: async (level) => {
      const registryState = currentRegistrySelection();
      if (registryState.owned) {
        const currentSelection = deps.runtime.getSessionModelSelection();
        if (!currentSelection) throw new Error("Select a model before choosing reasoning effort");
        const registrySelection =
          registryState.selection ??
          resolveRegistryOwnedModelSelection(registryState.registry, {
            providerId: currentSelection.providerId,
            modelId: currentSelection.modelId,
          })!;
        const previousThoughtLevel = resolveRegistryThoughtLevel(
          registrySelection,
          currentSelection.options?.reasoningLevel,
        );
        const thoughtLevel = requireRegistryThoughtLevel(registrySelection, level);
        deps.runtime.setSessionModelSelection({
          ...currentSelection,
          options: {
            ...currentSelection.options,
            reasoningLevel: thoughtLevel,
          },
        });
        await persistSessionModelSelection(deps);
        deps.logger.info("Session reasoning effort updated", {
          ...traceContextToLogContext(deps.traceContext),
          event: "session.reasoning_effort.updated",
          module: "bootstrap",
          previousThoughtLevel,
          status: "completed",
          thoughtLevel,
        });
        return {
          previousThoughtLevel,
          thoughtLevel,
          traceId: deps.traceContext.traceId,
        };
      }
      throw new Error("当前 Session Model 不属于 Provider Registry");
    },
    setLocale: async (locale) => {
      const previousLocale = currentLocale;
      const configPath = getLocaleConfigPath(deps.configResult);
      const persisted = await updateUiLocaleInFileConfig(configPath, locale);
      currentLocale = deps.resolveUiLocale(locale);
      deps.configResult.config.ui.locale = currentLocale;
      deps.logger.info("Session locale updated", {
        ...traceContextToLogContext(deps.traceContext),
        event: "session.locale.updated",
        locale: currentLocale,
        module: "bootstrap",
        previousLocale,
        requestedLocale: locale,
        status: "completed",
      });
      return {
        configPath: persisted.path,
        locale: currentLocale,
        previousLocale,
        requestedLocale: locale,
        traceId: deps.traceContext.traceId,
      };
    },
  };
}

async function closeSessionResources(input: SessionResourceCloseInput): Promise<void> {
  try {
    // 第一拍先关闭 runtime admission；后续 execution cancel 只能收口状态，不能再唤醒模型。
    input.beginShutdown();
  } catch (error) {
    input.logger.warn("Failed to begin runtime shutdown", {
      error: error instanceof Error ? error.message : String(error),
      event: "session.shutdown_admission.failed",
    });
  }

  const timeoutMs = Math.max(
    1,
    Math.trunc(input.timeoutMs ?? DEFAULT_SESSION_RESOURCE_CLOSE_TIMEOUT_MS),
  );
  const resources: Array<[name: string, close: (() => Promise<void> | void) | undefined]> = [
    ["browser_session", input.closeBrowserSession],
    ["execution", input.closeExecution],
    ["mcp", input.closeMcp],
    ["node_repl_browser_broker", input.closeNodeReplBrowserBroker],
  ];

  // 旧关闭链串行 await；Browser close 永不 settle 时，Execution/MCP 永远不会执行。
  // 各 owner 并行、独立带 deadline，任何一个失败都不能跳过其它资源。
  await Promise.all(
    resources.flatMap(([name, close]) =>
      close ? [closeSessionResourceWithinDeadline(name, close, timeoutMs, input.logger)] : [],
    ),
  );

  try {
    input.closeSessionStore?.();
  } catch (error) {
    input.logger.warn("Failed to close session store", {
      error: error instanceof Error ? error.message : String(error),
      event: "session.resource_close.failed",
      resource: "session_store",
    });
  }
}

async function closeSessionResourceWithinDeadline(
  name: string,
  close: () => Promise<void> | void,
  timeoutMs: number,
  logger: Logger,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const closePromise = Promise.resolve().then(close);
  const outcome = await Promise.race([
    closePromise.then(
      () => ({ type: "completed" as const }),
      (error: unknown) => ({ type: "failed" as const, error }),
    ),
    new Promise<{ type: "timed_out" }>((resolve) => {
      timer = setTimeout(() => resolve({ type: "timed_out" }), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);

  if (outcome.type === "completed") return;
  if (outcome.type === "timed_out") {
    logger.warn("Session resource close timed out", {
      event: "session.resource_close.timed_out",
      resource: name,
      timeoutMs,
    });
    return;
  }
  logger.warn("Session resource close failed", {
    error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
    event: "session.resource_close.failed",
    resource: name,
  });
}

async function persistSessionModelSelection(deps: CreateSessionFacadeDeps): Promise<void> {
  if (!deps.sessionStore.saveSessionEntry) return;
  const selection = deps.runtime.getSessionModelSelection();
  if (!selection) return;
  const timestamp = Date.now();
  try {
    await deps.sessionStore.saveSessionEntry({
      id: `${deps.sessionId}:runtime-model-selection`,
      sessionID: deps.sessionId,
      type: SESSION_ENTRY_MODEL_SELECTION,
      touchSession: false,
      time: { created: timestamp, updated: timestamp },
      // 模型与思考档位是 session-local 原子选型；切换后立即落同一稳定 entry，
      // 不必等下一条消息，也不会在冷恢复时读取 workspace/draft 的全局最新选择。
      // 同时配置补写不代表用户新活动，不能触发 session.time_updated 变成“刚刚”。
      data: {
        modelId: selection.modelId,
        providerId: selection.providerId,
        ...(selection.options ? { options: selection.options } : {}),
      },
    });
  } catch (error) {
    // 选型已经在当前 runtime 生效；持久化失败不能反向伪装成切换失败，但必须留生产日志。
    deps.logger.warn("Session model selection persistence failed", {
      ...traceContextToLogContext(deps.traceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "session.model_selection.persist_failed",
      modelId: selection.modelId,
      module: "bootstrap",
      providerId: selection.providerId,
      status: "failed",
      thoughtLevel: selection.options?.reasoningLevel,
    });
  }
}

/** 仅供仍以 provider/model 字符串工作的内部 App facade；不是 ModelSelection 序列化。 */
function formatLegacyRuntimeModelValue(selection: ModelSelection | undefined): string {
  return selection ? `${selection.providerId}/${selection.modelId}` : "";
}

type GoalStateChangeReminderAction = "paused" | "resumed" | "cleared";

function goalStateChangeReminderText(action: GoalStateChangeReminderAction): string;
function goalStateChangeReminderText(action: undefined): undefined;
function goalStateChangeReminderText(
  action: GoalStateChangeReminderAction | undefined,
): string | undefined;
function goalStateChangeReminderText(
  action: GoalStateChangeReminderAction | undefined,
): string | undefined {
  switch (action) {
    case "paused":
      return "The active session goal is paused. Do not continue pursuing it unless the user resumes or replaces the goal.";
    case "resumed":
      return "The session goal is active again and will be pursued.";
    case "cleared":
      return "The session goal has been cleared. Do not continue pursuing any previous goal unless the user sets a new goal.";
    default:
      return undefined;
  }
}
