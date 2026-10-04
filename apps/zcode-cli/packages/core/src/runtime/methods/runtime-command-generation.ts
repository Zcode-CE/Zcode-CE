import { SessionEventType, traceContextToLogContext } from "../deps.js";
import type { SessionEvent } from "../deps.js";
import type { RuntimeCommand } from "../command-queue.js";
import type { AgentRuntimeInternal } from "../internal.js";

export function isStaleBranchRuntimeCommand(
  runtime: AgentRuntimeInternal,
  command: RuntimeCommand,
): boolean {
  if (
    command.mode !== "task-notification" &&
    command.mode !== "subagent-message" &&
    command.mode !== "control-only-turn"
  ) {
    return false;
  }
  if (command.branchGeneration === runtime.branchGeneration) return false;
  // rewind 与后台 completion 存在竞态；命令即使已入队，也必须在持久化和
  // provider 注入前再次校验 generation，旧分支结果只留诊断日志。
  runtime.logger?.debug("Dropped queued stale-branch runtime command", {
    ...traceContextToLogContext(command.traceContext),
    branchGeneration: command.branchGeneration,
    commandId: command.id,
    currentBranchGeneration: runtime.branchGeneration,
    event: "runtime.command.stale_branch_dropped",
    mode: command.mode,
    module: "core.runtime",
  });
  return true;
}

export function isStaleBranchRuntimeTaskEvent(
  runtime: AgentRuntimeInternal,
  event: SessionEvent,
): boolean {
  if (
    event.type !== SessionEventType.BackgroundTaskUpdated &&
    event.type !== SessionEventType.BackgroundTaskCompleted &&
    event.type !== SessionEventType.SubagentMessage &&
    event.type !== SessionEventType.SubagentStopped
  ) {
    return false;
  }
  const payload =
    event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? (event.payload as Record<string, unknown>)
      : {};
  const taskId =
    typeof payload.taskId === "string"
      ? payload.taskId
      : typeof payload.agentId === "string"
        ? payload.agentId
        : undefined;
  if (!taskId) return false;
  const task = runtime.runtimeTaskRegistry.get(taskId);
  if (!task || task.branchGeneration === runtime.branchGeneration) return false;
  // 终态事件优先于代数：注册表是任务状态的唯一所有者，UI 必须观察到终态转移。
  // 若按代数丢弃终态事件，注册表已 completed/stopped 而 UI 永久「运行中」，
  // 用户取消只能得到 background_task_not_running（zcode-plugins issue #64）。
  // 修复后正常路径由注册表代数迁移保证代数匹配；此处兜底 rewind 与 completion
  // 在 await 边界交错的竞态（registry.update 已落终态、事件尚未发出）。
  if (
    event.type === SessionEventType.BackgroundTaskCompleted ||
    event.type === SessionEventType.SubagentStopped
  ) {
    runtime.logger?.warn("Accepted terminal runtime task event with stale branch generation", {
      branchGeneration: task.branchGeneration,
      currentBranchGeneration: runtime.branchGeneration,
      event: "runtime.task_event.stale_branch_terminal_accepted",
      eventType: event.type,
      module: "core.runtime",
      taskId,
    });
    return false;
  }
  // 非终态（进度/消息）事件对陈旧任务保持丢弃：旧分支的中间状态不应再刷新 UI；
  // 但丢弃必须可见——静默 debug 会让缺失调查无迹可循（issue #64 复盘口径）。
  runtime.logger?.warn("Dropped stale-branch runtime task event", {
    branchGeneration: task.branchGeneration,
    currentBranchGeneration: runtime.branchGeneration,
    event: "runtime.task_event.stale_branch_dropped",
    eventType: event.type,
    module: "core.runtime",
    taskId,
  });
  return true;
}
