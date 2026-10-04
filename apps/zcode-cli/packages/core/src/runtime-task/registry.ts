import type {
  ModelUsage,
  SessionId,
  SubagentTaskSnapshot,
  TraceContext,
  TurnId,
} from "@zcode/contracts";
import type { AgentOutput } from "@zcode/contracts";

// local_dynamic_workflow 与 local_workflow 刻意分开：后者是 legacy `Workflow` 工具（不可取消），
// 前者是 workflow run（经 DynamicWorkflowRunPort.cancel 可取消）。合成一个类型，取消分派就无法区分。
export type RuntimeTaskType =
  | "local_agent"
  | "local_bash"
  | "local_workflow"
  | "local_dynamic_workflow"
  | "monitor_mcp";

export interface RuntimeTaskUsageSnapshot {
  durationMs?: number;
  modelUsage?: ModelUsage;
  toolUseCount?: number;
  totalTokens?: number;
}

export interface RuntimeTaskPendingMessage {
  id: string;
  isMeta?: boolean;
  message: string;
  origin?: {
    kind: "coordinator";
    toolCallId?: string;
  };
  queuedAt: Date;
  summary?: string;
  traceContext?: TraceContext;
}

export interface RuntimeTaskMessageSink {
  send(message: RuntimeTaskPendingMessage): Promise<"queued" | "steered">;
}

export interface RuntimeTaskSnapshot extends SubagentTaskSnapshot {
  /** task 注册时所属 active conversation branch；用于迟到 completion fencing。 */
  branchGeneration?: number;
  exitCode?: number;
  type: RuntimeTaskType;
  isBackgrounded?: boolean;
  messageSink?: RuntimeTaskMessageSink;
  output?: AgentOutput;
  parentSessionId?: SessionId;
  pendingMessages?: RuntimeTaskPendingMessage[];
  prompt?: string;
  /**
   * workflow run 产物的序列化文本。TaskOutput 的投影只读得到 registry 条目（dwf 从不写
   * outputFile），所以产物必须在终态更新时就存到条目上。
   */
  resultText?: string;
  /**
   * 是谁请求停止这个任务（"user" = GUI / 后台面板，"model" = TaskStop）。dwf 停止分支在调
   * 端口 cancel 之前写下它；终态通知稍后由 waiter 结算时读它。重臂（resume 新生命）随结算面复位。
   */
  stopInitiator?: "user" | "model";
  taskType?: RuntimeTaskType;
  traceContext?: TraceContext;
  turnId?: TurnId;
  usage?: RuntimeTaskUsageSnapshot;
}

export interface RuntimeTaskRegistry {
  all(): Record<string, RuntimeTaskSnapshot>;
  get(id: string): RuntimeTaskSnapshot | undefined;
  drainMessages(id: string): RuntimeTaskPendingMessage[];
  queueMessage(id: string, message: RuntimeTaskPendingMessage): RuntimeTaskSnapshot | undefined;
  register(task: RuntimeTaskSnapshot): void;
  remove(id: string): void;
  requestBackground(id: string): boolean;
  setActiveBranchGeneration?(generation: number): void;
  update(
    id: string,
    patcher: (task: RuntimeTaskSnapshot) => RuntimeTaskSnapshot,
  ): RuntimeTaskSnapshot | undefined;
  waitForBackgroundRequest(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeTaskSnapshot | undefined>;
  waitForTerminal(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeTaskSnapshot | undefined>;
}

interface RuntimeTaskWaiter {
  onAbort?: () => void;
  reject: (error: unknown) => void;
  resolve: (task: RuntimeTaskSnapshot | undefined) => void;
  signal?: AbortSignal;
}

const TERMINAL_STATUSES = new Set<RuntimeTaskSnapshot["status"]>([
  "completed",
  "failed",
  "cancelled",
  "killed",
  "stopped",
  "lost",
]);

export class InMemoryRuntimeTaskRegistry implements RuntimeTaskRegistry {
  private activeBranchGeneration = 0;
  private readonly backgroundWaiters = new Map<string, Set<RuntimeTaskWaiter>>();
  private readonly tasks = new Map<string, RuntimeTaskSnapshot>();
  private readonly terminalWaiters = new Map<string, Set<RuntimeTaskWaiter>>();

  register(task: RuntimeTaskSnapshot): void {
    const stamped = {
      ...task,
      branchGeneration: task.branchGeneration ?? this.activeBranchGeneration,
    };
    this.tasks.set(stamped.taskId, stamped);
    this.resolveIfTerminal(stamped.taskId, stamped);
    this.resolveIfBackgrounded(stamped.taskId, stamped);
  }

  setActiveBranchGeneration(generation: number): void {
    this.activeBranchGeneration = generation;
    this.migrateNonTerminalTaskBranchGenerations(generation);
  }

  /**
   * 推进分支代数时把仍存活的非终态任务迁移到新代数。
   *
   * 调用点：init / resume 时注册表为空，迁移是 no-op；实际生效于 conversation rewind
   * （applyConversationRewindPlan）。回卷只取消被移除 turn 的后台任务
   * （cancelRemovedBranchBackgroundTasks，fail-closed）；
   * 存活任务属于保留分支前缀。若保留旧代数戳，它们的终态通知与事件会被 stale-branch
   * fencing 当旧分支残留整体丢弃——注册表已终态而 UI 永久「运行中」、用户取消只得到
   * background_task_not_running（zcode-plugins issue #64）。
   *
   * 终态任务刻意不迁移：结果已由结算路径持有，出队围栏仍需旧代数丢弃 rewind 前已入队的
   * 命令（旧分支输入不得注入新分支）；迟到的终态事件由 isStaleBranchRuntimeTaskEvent
   * 的「终态优先于代数」口径放行。
   */
  private migrateNonTerminalTaskBranchGenerations(generation: number): void {
    for (const [taskId, task] of this.tasks) {
      if (isTerminalRuntimeTask(task)) continue;
      if (task.branchGeneration === generation) continue;
      this.tasks.set(taskId, { ...task, branchGeneration: generation });
    }
  }

  update(
    id: string,
    patcher: (task: RuntimeTaskSnapshot) => RuntimeTaskSnapshot,
  ): RuntimeTaskSnapshot | undefined {
    const current = this.tasks.get(id);
    if (!current) return undefined;
    const next = patcher(current);
    this.tasks.set(id, next);
    this.resolveIfTerminal(id, next);
    this.resolveIfBackgrounded(id, next);
    return next;
  }

  requestBackground(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || isTerminalRuntimeTask(task)) return false;
    const next: RuntimeTaskSnapshot = { ...task, isBackgrounded: true };
    this.tasks.set(id, next);
    this.resolveBackgroundWaiters(id, next);
    return true;
  }

  remove(id: string): void {
    this.tasks.delete(id);
    this.resolveTerminalWaiters(id, undefined);
    this.resolveBackgroundWaiters(id, undefined);
  }

  get(id: string): RuntimeTaskSnapshot | undefined {
    return this.tasks.get(id);
  }

  all(): Record<string, RuntimeTaskSnapshot> {
    return Object.fromEntries(this.tasks);
  }

  queueMessage(id: string, message: RuntimeTaskPendingMessage): RuntimeTaskSnapshot | undefined {
    return this.update(id, (task) => ({
      ...task,
      pendingMessages: [...(task.pendingMessages ?? []), message],
    }));
  }

  drainMessages(id: string): RuntimeTaskPendingMessage[] {
    const task = this.tasks.get(id);
    if (!task || !task.pendingMessages || task.pendingMessages.length === 0) return [];
    const messages = task.pendingMessages;
    this.tasks.set(id, { ...task, pendingMessages: [] });
    return messages;
  }

  waitForBackgroundRequest(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeTaskSnapshot | undefined> {
    const current = this.tasks.get(id);
    if (!current || current.isBackgrounded || isTerminalRuntimeTask(current)) {
      return Promise.resolve(current?.isBackgrounded ? current : undefined);
    }
    return this.waitFor(this.backgroundWaiters, id, options);
  }

  waitForTerminal(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeTaskSnapshot | undefined> {
    const current = this.tasks.get(id);
    if (!current || isTerminalRuntimeTask(current)) return Promise.resolve(current);
    return this.waitFor(this.terminalWaiters, id, options);
  }

  private waitFor(
    waitersByTask: Map<string, Set<RuntimeTaskWaiter>>,
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeTaskSnapshot | undefined> {
    const signal = options?.signal;
    if (signal?.aborted) return Promise.reject(abortReason(signal));

    return new Promise((resolve, reject) => {
      const waiter: RuntimeTaskWaiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          this.removeWaiter(waitersByTask, id, waiter);
          reject(abortReason(signal));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      let waiters = waitersByTask.get(id);
      if (!waiters) {
        waiters = new Set();
        waitersByTask.set(id, waiters);
      }
      waiters.add(waiter);
    });
  }

  private resolveIfBackgrounded(id: string, task: RuntimeTaskSnapshot): void {
    if (task.isBackgrounded) {
      this.resolveBackgroundWaiters(id, task);
    }
  }

  private resolveIfTerminal(id: string, task: RuntimeTaskSnapshot): void {
    if (isTerminalRuntimeTask(task)) {
      this.resolveTerminalWaiters(id, task);
      this.resolveBackgroundWaiters(id, undefined);
    }
  }

  private resolveBackgroundWaiters(id: string, task: RuntimeTaskSnapshot | undefined): void {
    this.resolveWaiters(this.backgroundWaiters, id, task);
  }

  private resolveTerminalWaiters(id: string, task: RuntimeTaskSnapshot | undefined): void {
    this.resolveWaiters(this.terminalWaiters, id, task);
  }

  private resolveWaiters(
    waitersByTask: Map<string, Set<RuntimeTaskWaiter>>,
    id: string,
    task: RuntimeTaskSnapshot | undefined,
  ): void {
    const waiters = waitersByTask.get(id);
    if (!waiters) return;
    waitersByTask.delete(id);
    for (const waiter of waiters) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve(task);
    }
  }

  private removeWaiter(
    waitersByTask: Map<string, Set<RuntimeTaskWaiter>>,
    id: string,
    waiter: RuntimeTaskWaiter,
  ): void {
    const waiters = waitersByTask.get(id);
    if (!waiters) return;
    waiters.delete(waiter);
    if (waiters.size === 0) waitersByTask.delete(id);
  }
}

export function isTerminalRuntimeTask(task: Pick<RuntimeTaskSnapshot, "status">): boolean {
  return TERMINAL_STATUSES.has(task.status);
}

export function hasRunningBackgroundRuntimeTask(registry: RuntimeTaskRegistry): boolean {
  return Object.values(registry.all()).some(
    (task) => task.isBackgrounded === true && task.status === "running",
  );
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Runtime task wait aborted");
}
