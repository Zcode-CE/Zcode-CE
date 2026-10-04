import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRuntimeTaskRegistry } from "../src/runtime-task/registry.js";
import { isStaleBranchRuntimeTaskEvent } from "../src/runtime/methods/runtime-command-generation.js";
import { enqueueBackgroundTaskNotification } from "../src/runtime/methods/background-notifications.js";
import { setCustomSessionTitle } from "../src/runtime/methods/session-title.js";
import { SessionEventType } from "../src/runtime/deps.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { RuntimeTaskSnapshot } from "../src/runtime-task/registry.js";
import type {
  Logger,
  RuntimeCommand,
  SessionEvent,
  SessionInfo,
  TraceContext,
} from "@zcode/contracts";

/**
 * T1 修复单测（zcode-plugins issue #64 / .reverse/102 T1）：
 * 编辑消息重发（conversation rewind）导致后台智能体完成通知与终态事件被
 * stale-branch fencing 静默丢弃（debug 级、无返回值），UI 永久「运行中」。
 *
 * 断言打在四个最终消费点：
 * 1. setActiveBranchGeneration 的代数迁移（存活任务并入新分支）；
 * 2. isStaleBranchRuntimeTaskEvent 终态事件优先于代数（竞态兜底）；
 * 3. enqueueBackgroundTaskNotification 的入队结果回传（stale/shutdown 不再静默）；
 * 4. setCustomSessionTitle 乐观锁（T2 / issue #60：custom 标题不被冻结路径覆盖）。
 *
 * 运行：cd apps/zcode-cli/packages/core && node --import tsx --test test/runtimeTaskBranchFencing.test.ts
 */

interface MemoryLog {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  event?: string;
  reason?: string;
  taskId?: string;
}

function makeLogger(): { logger: Logger; logs: MemoryLog[] } {
  const logs: MemoryLog[] = [];
  const logger = {
    debug: (message: string, context?: Record<string, unknown>) =>
      logs.push({ level: "debug", message, ...(context as MemoryLog) }),
    info: (message: string, context?: Record<string, unknown>) =>
      logs.push({ level: "info", message, ...(context as MemoryLog) }),
    warn: (message: string, context?: Record<string, unknown>) =>
      logs.push({ level: "warn", message, ...(context as MemoryLog) }),
    error: (message: string, context?: Record<string, unknown>) =>
      logs.push({ level: "error", message, ...(context as MemoryLog) }),
  } as unknown as Logger;
  return { logger, logs };
}

function makeTaskSnapshot(input: {
  taskId: string;
  status: RuntimeTaskSnapshot["status"];
  branchGeneration?: number;
  turnId?: string;
}): RuntimeTaskSnapshot {
  return {
    taskId: input.taskId,
    agentId: input.taskId,
    agentType: "Explore",
    description: "test agent",
    isBackgrounded: true,
    outputFile: "/tmp/core-defects/output.txt",
    parentToolCallId: "call_1",
    parentSessionId: "session_parent",
    prompt: "do something",
    startedAt: new Date(),
    status: input.status,
    taskType: "local_agent",
    type: "local_agent",
    ...(input.branchGeneration === undefined ? {} : { branchGeneration: input.branchGeneration }),
    ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
  } as RuntimeTaskSnapshot;
}

function makeFenceRuntime(options: {
  branchGeneration: number;
  registry: InMemoryRuntimeTaskRegistry;
  logger: Logger;
}): AgentRuntimeInternal {
  return {
    branchGeneration: options.branchGeneration,
    runtimeTaskRegistry: options.registry,
    logger: options.logger,
  } as unknown as AgentRuntimeInternal;
}

function makeNotificationRuntime(options: {
  branchGeneration: number;
  registry: InMemoryRuntimeTaskRegistry;
  logger: Logger;
  shuttingDown?: boolean;
}): { runtime: AgentRuntimeInternal; commands: RuntimeCommand[] } {
  const commands: RuntimeCommand[] = [];
  const runtime = {
    shuttingDown: options.shuttingDown ?? false,
    logger: options.logger,
    branchGeneration: options.branchGeneration,
    runtimeTaskRegistry: options.registry,
    enqueueRuntimeCommand: (command: RuntimeCommand) => {
      commands.push(command);
    },
    // saveSessionInput 返回 falsy ⇒ 不进入 trackResidencyBlockingWork，保持单测聚焦。
    sessionStore: { saveSessionInput: () => undefined },
  } as unknown as AgentRuntimeInternal;
  return { runtime, commands };
}

const traceContext = { traceId: "trace_1", spanId: "span_1" } as TraceContext;

function taskEvent(type: SessionEvent["type"], taskId: string | undefined): SessionEvent {
  return {
    type,
    payload: taskId === undefined ? {} : { taskId },
    sessionId: "session_parent",
    timestamp: Date.now(),
  } as unknown as SessionEvent;
}

// ---------------------------------------------------------------- registry 迁移

test("setActiveBranchGeneration 把存活运行中任务迁移到新代数，终态任务保留旧戳", () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  registry.setActiveBranchGeneration(1);
  registry.register(makeTaskSnapshot({ taskId: "running_kept", status: "running" }));
  registry.register(makeTaskSnapshot({ taskId: "running_orphan", status: "running" }));
  registry.register(makeTaskSnapshot({ taskId: "terminal_old", status: "completed" }));

  // 模拟 conversation rewind：回卷只取消被移除 turn 的任务，这里 running_kept/orphan
  // 属于保留前缀（或无 turn 锚点），推进代数时必须并入新分支。
  registry.setActiveBranchGeneration(2);

  assert.equal(registry.get("running_kept")?.branchGeneration, 2);
  assert.equal(registry.get("running_orphan")?.branchGeneration, 2);
  // 终态任务不迁移：其结果已由结算路径持有，旧代数用于出队围栏丢弃 rewind 前已入队命令。
  assert.equal(registry.get("terminal_old")?.branchGeneration, 1);
});

test("迁移后新注册仍按当前 active 代数盖章", () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  registry.setActiveBranchGeneration(3);
  registry.register(makeTaskSnapshot({ taskId: "fresh", status: "running" }));
  assert.equal(registry.get("fresh")?.branchGeneration, 3);
});

// ---------------------------------------------------------------- 围栏：终态优先

test("终态事件对注册表内存量任务优先于代数（竞态兜底）", () => {
  const { logger, logs } = makeLogger();
  const registry = new InMemoryRuntimeTaskRegistry();
  registry.setActiveBranchGeneration(1);
  registry.register(makeTaskSnapshot({ taskId: "raced", status: "completed" }));
  // registry.update 已落终态、事件尚未发出的交错：任务戳仍是旧代数 1，runtime 已推进到 2。
  const runtime = makeFenceRuntime({ branchGeneration: 2, registry, logger });

  assert.equal(
    isStaleBranchRuntimeTaskEvent(
      runtime,
      taskEvent(SessionEventType.BackgroundTaskCompleted, "raced"),
    ),
    false,
  );
  assert.equal(
    isStaleBranchRuntimeTaskEvent(runtime, taskEvent(SessionEventType.SubagentStopped, "raced")),
    false,
  );
  const accepted = logs.find(
    (log) => log.event === "runtime.task_event.stale_branch_terminal_accepted",
  );
  assert.ok(accepted, "终态事件放行应留 warn 痕迹");
  assert.equal(accepted?.taskId, "raced");
});

test("进度事件对陈旧存活任务仍按代数丢弃，且日志升级到 warn", () => {
  const { logger, logs } = makeLogger();
  const registry = new InMemoryRuntimeTaskRegistry();
  registry.setActiveBranchGeneration(1);
  registry.register(makeTaskSnapshot({ taskId: "stale_running", status: "running" }));
  const runtime = makeFenceRuntime({ branchGeneration: 2, registry, logger });

  assert.equal(
    isStaleBranchRuntimeTaskEvent(
      runtime,
      taskEvent(SessionEventType.BackgroundTaskUpdated, "stale_running"),
    ),
    true,
  );
  const dropped = logs.find((log) => log.event === "runtime.task_event.stale_branch_dropped");
  assert.ok(dropped, "丢弃日志应为 warn 级（issue #64 复盘口径）");
  assert.equal(dropped?.level, "warn");
  assert.equal(dropped?.taskId, "stale_running");
});

test("非受围事件类型与代数匹配/任务缺失时放行（回归断言）", () => {
  const { logger } = makeLogger();
  const registry = new InMemoryRuntimeTaskRegistry();
  registry.setActiveBranchGeneration(1);
  registry.register(makeTaskSnapshot({ taskId: "current", status: "running" }));
  const runtime = makeFenceRuntime({ branchGeneration: 1, registry, logger });

  assert.equal(
    isStaleBranchRuntimeTaskEvent(runtime, taskEvent(SessionEventType.ModelComplete, "current")),
    false,
  );
  assert.equal(
    isStaleBranchRuntimeTaskEvent(
      runtime,
      taskEvent(SessionEventType.BackgroundTaskUpdated, "current"),
    ),
    false,
  );
  assert.equal(
    isStaleBranchRuntimeTaskEvent(
      runtime,
      taskEvent(SessionEventType.BackgroundTaskCompleted, "unknown_task"),
    ),
    false,
  );
  assert.equal(
    isStaleBranchRuntimeTaskEvent(
      runtime,
      taskEvent(SessionEventType.BackgroundTaskCompleted, undefined),
    ),
    false,
  );
});

// ------------------------------------------------- 入队结果回传（不再静默丢弃）

test("enqueueBackgroundTaskNotification：代数匹配时入队成功并回传 enqueued:true", async () => {
  const { logger, logs } = makeLogger();
  const registry = new InMemoryRuntimeTaskRegistry();
  registry.setActiveBranchGeneration(2);
  registry.register(makeTaskSnapshot({ taskId: "kept", status: "running" }));
  const { runtime, commands } = makeNotificationRuntime({ branchGeneration: 2, registry, logger });

  const result = await enqueueBackgroundTaskNotification.call(runtime, {
    taskId: "kept",
    text: "done",
    traceContext,
  });

  assert.deepEqual(result, { enqueued: true });
  assert.equal(commands.length, 1);
  // 命令戳当前分支代数，供出队围栏识别 rewind 前已入队的旧分支输入。
  assert.equal(commands[0]?.branchGeneration, 2);
  assert.ok(
    !logs.some((log) => log.event === "runtime.background_task_notification.stale_branch_dropped"),
  );
});

test("enqueueBackgroundTaskNotification：陈旧代数丢弃并回传 enqueued:false + stale_branch（warn 级）", async () => {
  const { logger, logs } = makeLogger();
  const registry = new InMemoryRuntimeTaskRegistry();
  registry.setActiveBranchGeneration(1);
  registry.register(makeTaskSnapshot({ taskId: "stale", status: "running" }));
  const { runtime, commands } = makeNotificationRuntime({ branchGeneration: 2, registry, logger });

  const result = await enqueueBackgroundTaskNotification.call(runtime, {
    taskId: "stale",
    text: "done",
    traceContext,
  });

  assert.deepEqual(result, { enqueued: false, reason: "stale_branch" });
  assert.equal(commands.length, 0);
  const dropped = logs.find(
    (log) => log.event === "runtime.background_task_notification.stale_branch_dropped",
  );
  assert.ok(dropped);
  assert.equal(dropped?.level, "warn");
});

test("enqueueBackgroundTaskNotification：shutdown 丢弃回传 enqueued:false + shutdown", async () => {
  const { logger } = makeLogger();
  const registry = new InMemoryRuntimeTaskRegistry();
  registry.setActiveBranchGeneration(1);
  registry.register(makeTaskSnapshot({ taskId: "shutting", status: "running" }));
  const { runtime, commands } = makeNotificationRuntime({
    branchGeneration: 1,
    registry,
    logger,
    shuttingDown: true,
  });

  const result = await enqueueBackgroundTaskNotification.call(runtime, {
    taskId: "shutting",
    text: "done",
    traceContext,
  });

  assert.deepEqual(result, { enqueued: false, reason: "shutdown" });
  assert.equal(commands.length, 0);
});

// ------------------------------------------------- T2：setCustomSessionTitle 乐观锁

interface FakeSessionRow {
  id: string;
  title: string;
  titleSource: SessionInfo["titleSource"];
}

function makeFakeSessionStore(initial: FakeSessionRow) {
  let row: FakeSessionRow = { ...initial };
  const store = {
    async getSession(): Promise<SessionInfo> {
      return { ...row } as SessionInfo;
    },
    // 与 adapters/sessions.ts 的乐观锁口径一致：当前 titleSource 不在期望集合内则不更新。
    async updateSession(input: {
      id: string;
      title: string;
      titleSource: SessionInfo["titleSource"];
      expectedTitleSources?: readonly SessionInfo["titleSource"][];
    }): Promise<SessionInfo | undefined> {
      if (
        input.expectedTitleSources &&
        input.expectedTitleSources.length > 0 &&
        !input.expectedTitleSources.includes(row.titleSource ?? "first_input")
      ) {
        return undefined;
      }
      row = { id: input.id, title: input.title, titleSource: input.titleSource };
      return { ...row } as SessionInfo;
    },
  };
  return store;
}

function makeTitleRuntime(options: {
  sessionStore: ReturnType<typeof makeFakeSessionStore>;
  logger: Logger;
}): { runtime: AgentRuntimeInternal; appended: SessionEvent[] } {
  const appended: SessionEvent[] = [];
  const runtime = {
    sessionId: "session_1",
    logger: options.logger,
    sessionStore: options.sessionStore,
    createEvent: (type: SessionEvent["type"], payload: Record<string, unknown>) =>
      ({ type, payload, sessionId: "session_1" }) as SessionEvent,
    appendEvent: async (event: SessionEvent) => {
      appended.push(event);
    },
  } as unknown as AgentRuntimeInternal;
  return { runtime, appended };
}

test("setCustomSessionTitle：custom 标题在期望锁下不被 automation 冻结覆盖（issue #60）", async () => {
  const { logger, logs } = makeLogger();
  const store = makeFakeSessionStore({
    id: "session_1",
    title: "用户手动命名",
    titleSource: "custom",
  });
  const { runtime, appended } = makeTitleRuntime({ sessionStore: store, logger });

  await setCustomSessionTitle.call(runtime, {
    title: "Automation 标题",
    traceContext,
    expectedTitleSources: ["default", "first_input", "generated"],
  });

  // 乐观锁命中失败 ⇒ 不持久化、不发 SessionTitleUpdated，用户标题保持不动。
  const session = await store.getSession();
  assert.equal(session?.title, "用户手动命名");
  assert.equal(session?.titleSource, "custom");
  assert.equal(appended.length, 0);
  const skipped = logs.find((log) => log.event === "session_title_custom.skipped");
  assert.ok(skipped, "跳过应留 debug 痕迹");
  assert.equal(skipped?.reason, "title_source_not_expected");
});

test("setCustomSessionTitle：generated 标题在期望锁内被冻结为 custom", async () => {
  const { logger } = makeLogger();
  const store = makeFakeSessionStore({
    id: "session_1",
    title: "旧自动标题",
    titleSource: "generated",
  });
  const { runtime, appended } = makeTitleRuntime({ sessionStore: store, logger });

  await setCustomSessionTitle.call(runtime, {
    title: "Automation 标题",
    traceContext,
    expectedTitleSources: ["default", "first_input", "generated"],
  });

  const session = await store.getSession();
  assert.equal(session?.title, "Automation 标题");
  assert.equal(session?.titleSource, "custom");
  assert.equal(appended.length, 1);
  assert.equal(appended[0]?.type, SessionEventType.SessionTitleUpdated);
});

test("setCustomSessionTitle：不传期望锁 = 用户重命名，无条件覆盖 custom", async () => {
  const { logger } = makeLogger();
  const store = makeFakeSessionStore({
    id: "session_1",
    title: "旧自动标题",
    titleSource: "custom",
  });
  const { runtime, appended } = makeTitleRuntime({ sessionStore: store, logger });

  await setCustomSessionTitle.call(runtime, { title: "新名字", traceContext });

  const session = await store.getSession();
  assert.equal(session?.title, "新名字");
  assert.equal(session?.titleSource, "custom");
  assert.equal(appended.length, 1);
});
