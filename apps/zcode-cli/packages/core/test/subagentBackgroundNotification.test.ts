import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createExploreSubagentPort,
  type ParentTaskNotificationCommand,
  type ParentTaskNotificationEnqueueResult,
} from "../src/subagent/runner.js";
import { InMemoryRuntimeTaskRegistry } from "../src/runtime-task/registry.js";
import { SessionEventType } from "../src/runtime/deps.js";
import type {
  AgentBackgroundedOutput,
  Logger,
  SessionEvent,
  SubagentStartRequest,
} from "@zcode/contracts";

/**
 * T1 point 5 单测（issue #64 / .reverse/102 T1）：后台智能体终态链路。
 *
 * 修复前 enqueueParentTaskNotification 类型上返回 undefined，父队列把通知按
 * stale-branch 丢弃后 subagent runner 仍然盖 notified 戳并打 info「已入队」——
 * 完成通知永久丢失且无报错。修复后父队列显式拒绝必须：
 *   1. 回传 enqueued:false + reason（不再静默）；
 *   2. runner 不盖 notified、不打「已入队」info、改打 warn；
 *   3. 终态事件（BackgroundTaskCompleted / SubagentStopped）照常发出——
 *      UI 终态转移不依赖通知入队，否则注册表已 completed 而 UI 永久「运行中」。
 *
 * 运行：cd apps/zcode-cli/packages/core && node --import tsx --test test/subagentBackgroundNotification.test.ts
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

interface Harness {
  outputRootDir: string;
  registry: InMemoryRuntimeTaskRegistry;
  emittedEvents: SessionEvent[];
  enqueueCalls: ParentTaskNotificationCommand[];
  logs: MemoryLog[];
  start(input: {
    agentId: string;
    enqueueResult: ParentTaskNotificationEnqueueResult;
  }): Promise<AgentBackgroundedOutput>;
}

function createHarness(): Harness {
  const { logger, logs } = makeLogger();
  const registry = new InMemoryRuntimeTaskRegistry();
  const emittedEvents: SessionEvent[] = [];
  const enqueueCalls: ParentTaskNotificationCommand[] = [];
  const outputRootDir = mkdtempSync(join(tmpdir(), "core-defects-runner-"));

  async function start(input: {
    agentId: string;
    enqueueResult: ParentTaskNotificationEnqueueResult;
  }): Promise<AgentBackgroundedOutput> {
    const port = createExploreSubagentPort({
      logger,
      outputRootDir,
      runtimeTaskRegistry: registry,
      createAgentId: () => input.agentId,
      runExploreAgent: async () => ({
        // 测试桩不调用 onSessionReady：runAgentToCompletion 的回落兜底会触发 readiness。
        response: "子 agent 完成",
        traceId: "trace_child",
        events: [],
      }),
      emitParentEvent: async (event: SessionEvent) => {
        emittedEvents.push(event);
      },
      enqueueParentTaskNotification: (notification: ParentTaskNotificationCommand) => {
        enqueueCalls.push(notification);
        return input.enqueueResult;
      },
    });
    const request: SubagentStartRequest = {
      agentType: "Explore",
      description: "后台探测代理",
      parentToolCallId: "call_background",
      prompt: "search the workspace",
      sessionId: "session_parent",
      trace: { traceId: "trace_parent", spanId: "span_parent" },
      turnId: "turn_parent",
      workingDirectory: outputRootDir,
      workspaceRoot: outputRootDir,
    };
    return await port.start(request);
  }

  return { outputRootDir, registry, emittedEvents, enqueueCalls, logs, start };
}

/** 微任务/IO 轮等待后台完成链路的全部可观测效应落盘（无超时掩盖）。 */
async function waitForEffects(predicate: () => boolean, label: string): Promise<void> {
  for (let iteration = 0; iteration < 5000; iteration += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (!predicate()) {
    throw new Error("后台完成链路效应未观察到：" + label);
  }
}

function terminalEventTypes(emittedEvents: SessionEvent[]): string[] {
  return emittedEvents
    .filter(
      (event) =>
        event.type === SessionEventType.BackgroundTaskCompleted ||
        event.type === SessionEventType.SubagentStopped,
    )
    .map((event) => event.type);
}

test("父队列接受通知时：盖 notified 戳、打 info「已入队」、发出两个终态事件", async () => {
  const harness = createHarness();
  try {
    const output = await harness.start({
      agentId: "agent_accepted",
      enqueueResult: { enqueued: true },
    });
    assert.equal(output.backgroundTaskId, "agent_accepted");

    await waitForEffects(
      () =>
        harness.registry.get("agent_accepted")?.status === "completed" &&
        harness.registry.get("agent_accepted")?.notified === true &&
        harness.enqueueCalls.length >= 1 &&
        harness.emittedEvents.length >= 2,
      "accepted: 终态 + notified + 入队 + 事件",
    );

    const snapshot = harness.registry.get("agent_accepted");
    assert.equal(snapshot?.status, "completed");
    assert.equal(snapshot?.notified, true);
    assert.equal(harness.enqueueCalls.length, 1);
    assert.equal(harness.enqueueCalls[0]?.taskId, "agent_accepted");

    const enqueuedLog = harness.logs.find(
      (log) => log.event === "subagent.background.notification.enqueued",
    );
    assert.ok(enqueuedLog, "接受时应打 info「已入队」日志");
    assert.equal(enqueuedLog?.level, "info");

    assert.ok(
      !harness.logs.some((log) => log.event === "subagent.background.notification.rejected"),
      "接受时不应有 rejected 日志",
    );
    assert.ok(
      !harness.logs.some(
        (log) => log.event === "subagent.background.terminal_notification.not_enqueued",
      ),
      "接受时不应有 not_enqueued 日志",
    );

    assert.deepEqual(terminalEventTypes(harness.emittedEvents), [
      SessionEventType.BackgroundTaskCompleted,
      SessionEventType.SubagentStopped,
    ]);
  } finally {
    rmSync(harness.outputRootDir, { recursive: true, force: true });
  }
});

test("父队列按 stale_branch 拒绝时：不盖 notified、warn 留痕、终态事件仍发出（UI 不卡死）", async () => {
  const harness = createHarness();
  try {
    const output = await harness.start({
      agentId: "agent_rejected",
      enqueueResult: { enqueued: false, reason: "stale_branch" },
    });
    assert.equal(output.backgroundTaskId, "agent_rejected");

    await waitForEffects(
      () =>
        harness.registry.get("agent_rejected")?.status === "completed" &&
        harness.enqueueCalls.length >= 1 &&
        harness.emittedEvents.length >= 2,
      "rejected: 终态 + 入队尝试 + 事件",
    );

    const snapshot = harness.registry.get("agent_rejected");
    assert.equal(snapshot?.status, "completed");
    // 未入队即未通知：notified 戳不能盖（修复前会盖，形成 fake-notified）。
    assert.notEqual(snapshot?.notified, true);

    const rejectedLog = harness.logs.find(
      (log) => log.event === "subagent.background.notification.rejected",
    );
    assert.ok(rejectedLog, "拒绝应打 warn 并带 reason");
    assert.equal(rejectedLog?.level, "warn");
    assert.equal(rejectedLog?.reason, "stale_branch");

    const notEnqueuedLog = harness.logs.find(
      (log) => log.event === "subagent.background.terminal_notification.not_enqueued",
    );
    assert.ok(notEnqueuedLog, "completion 路径应打 not_enqueued warn");

    assert.ok(
      !harness.logs.some((log) => log.event === "subagent.background.notification.enqueued"),
      "拒绝时不应再打「已入队」info（issue #64 的误导性成功痕迹）",
    );

    // 核心契约：通知被拒绝 ≠ UI 看不到终态——BackgroundTaskCompleted 与
    // SubagentStopped 必须照常发出，否则注册表已 completed 而 UI 永久「运行中」。
    assert.deepEqual(terminalEventTypes(harness.emittedEvents), [
      SessionEventType.BackgroundTaskCompleted,
      SessionEventType.SubagentStopped,
    ]);
  } finally {
    rmSync(harness.outputRootDir, { recursive: true, force: true });
  }
});
