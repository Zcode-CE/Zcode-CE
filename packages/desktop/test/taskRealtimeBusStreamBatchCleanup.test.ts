import assert from "node:assert/strict";
import test from "node:test";
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import { TaskRealtimeBus } from "../src/main/taskRealtimeBus.js";

/**
 * mirror 表项的生命周期：run 一结束就必须回收。
 *
 * 回归形态：`streamBatches` 过去只在「最后一批 ops 恰好包含 terminal stream event」时才删除。
 * 以异常/取消收尾、owner host 先退出、或最后一个 op 是 permission_request 的 run，表项连同
 * 最多 512KB 的 replay 缓冲永久驻留 —— 主进程内存随跑过的任务数单调增长，且没有任何回收路径。
 *
 * 断言口径：租约释放、host 退出、终态事件三条结束路径都必须把 streamBatches 归零，
 * 且回收前最后一批 ops 仍被投递（不能靠丢数据换内存）。
 */

const WORKSPACE_PATH = "/tmp/zcode-bus-ws";
const WORKSPACE_KEY = WORKSPACE_PATH;
const TASK_ID = "task-1";
// 目标 schema 要求 runId 与 traceId 一致、workspaceKey 等于 identity 回退规则的结果。
const RUN_ID = "run-1";
const TRACE_ID = RUN_ID;
const TARGET = {
  workspacePath: WORKSPACE_PATH,
  workspaceKey: WORKSPACE_KEY,
  taskId: TASK_ID,
  runId: RUN_ID,
  traceId: TRACE_ID,
};

const SILENT_LOGGER = { info: () => {}, warn: () => {} };

function createBus(): TaskRealtimeBus {
  return new TaskRealtimeBus({ logger: SILENT_LOGGER });
}

function createFakeHost() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const onceListeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const posted: any[] = [];
  const child = {
    on(event: string, listener: (...args: unknown[]) => void) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return child;
    },
    once(event: string, listener: (...args: unknown[]) => void) {
      const set = onceListeners.get(event) ?? new Set();
      set.add(listener);
      onceListeners.set(event, set);
      return child;
    },
    off(event: string, listener: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(listener);
      onceListeners.get(event)?.delete(listener);
      return child;
    },
    postMessage(message: unknown) {
      posted.push(message);
    },
  } as unknown as ElectronUtilityProcess;
  return {
    child,
    posted,
    emitMessage(message: unknown) {
      for (const listener of listeners.get("message") ?? []) listener(message);
    },
    emitExit() {
      const pending = [...(onceListeners.get("exit") ?? [])];
      onceListeners.delete("exit");
      for (const listener of pending) listener();
    },
  };
}

function acquireLease(host: ReturnType<typeof createFakeHost>): void {
  host.emitMessage({
    type: "task-run-lease-acquire",
    request: { ...TARGET, leaseRequestId: "lease-1" },
  });
}

function publishStreamEvent(
  host: ReturnType<typeof createFakeHost>,
  event: Record<string, unknown>,
): void {
  host.emitMessage({
    type: "task-stream-op-publish",
    target: TARGET,
    op: { kind: "stream_event", event },
  });
}

test("非终态结束（租约释放）：mirror 表项被回收，且末批 ops 仍投递", () => {
  const bus = createBus();
  const host = createFakeHost();
  bus.registerHost({
    hostId: "host-1",
    windowId: 1,
    child: host.child,
    workspaceKeys: [WORKSPACE_KEY],
  });

  acquireLease(host);
  publishStreamEvent(host, {
    type: "message_delta",
    taskId: TASK_ID,
    traceId: TRACE_ID,
    content: "hi",
  });
  assert.equal(bus.collectMemoryDiagnostics().streamBatches, 1, "运行中的 run 应保留 mirror 表项");

  const postedBeforeRelease = host.posted.length;
  // 以异常/取消收尾：没有 task_complete / task_error 终态事件。
  host.emitMessage({ type: "task-run-lease-release", target: TARGET });

  assert.equal(
    bus.collectMemoryDiagnostics().streamBatches,
    0,
    "租约释放后必须回收表项，否则 replay 缓冲永久驻留",
  );
  assert.ok(
    host.posted.length > postedBeforeRelease,
    "回收前必须把剩余 ops 投递出去，不能用丢数据换内存",
  );
  bus.unregisterHost("host-1");
});

test("owner host 退出（崩溃/关窗）：mirror 表项被回收", () => {
  const bus = createBus();
  const host = createFakeHost();
  bus.registerHost({
    hostId: "host-1",
    windowId: 1,
    child: host.child,
    workspaceKeys: [WORKSPACE_KEY],
  });

  acquireLease(host);
  publishStreamEvent(host, {
    type: "message_delta",
    taskId: TASK_ID,
    traceId: TRACE_ID,
    content: "hi",
  });
  assert.equal(bus.collectMemoryDiagnostics().streamBatches, 1);

  host.emitExit();
  assert.equal(
    bus.collectMemoryDiagnostics().streamBatches,
    0,
    "owner host 退出后 mirror 表项必须回收",
  );
});

test("终态事件仍正常收尾：投递 terminal 批次并回收表项", () => {
  const bus = createBus();
  const host = createFakeHost();
  bus.registerHost({
    hostId: "host-1",
    windowId: 1,
    child: host.child,
    workspaceKeys: [WORKSPACE_KEY],
  });

  acquireLease(host);
  publishStreamEvent(host, {
    type: "message_delta",
    taskId: TASK_ID,
    traceId: TRACE_ID,
    content: "hi",
  });
  publishStreamEvent(host, { type: "task_complete", taskId: TASK_ID, traceId: TRACE_ID });

  assert.equal(bus.collectMemoryDiagnostics().streamBatches, 0);
  const batches = host.posted.filter(
    (message) => message?.event?.type === "task_stream_mirror_batch",
  );
  assert.ok(batches.length >= 1, "终态批次必须投递给宿主");
  assert.equal(
    batches.some((message) => message.event.terminal === true),
    true,
    "终态批次必须带 terminal 标记",
  );
  bus.unregisterHost("host-1");
});

test("运行中多次发布不会误删表项", () => {
  const bus = createBus();
  const host = createFakeHost();
  bus.registerHost({
    hostId: "host-1",
    windowId: 1,
    child: host.child,
    workspaceKeys: [WORKSPACE_KEY],
  });

  acquireLease(host);
  publishStreamEvent(host, {
    type: "message_delta",
    taskId: TASK_ID,
    traceId: TRACE_ID,
    content: "a",
  });
  publishStreamEvent(host, {
    type: "message_delta",
    taskId: TASK_ID,
    traceId: TRACE_ID,
    content: "b",
  });
  assert.equal(bus.collectMemoryDiagnostics().streamBatches, 1, "同一 run 只应有一个表项");
  bus.unregisterHost("host-1");
});
