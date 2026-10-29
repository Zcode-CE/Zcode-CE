import assert from "node:assert/strict";
import test from "node:test";
import { DEFERRED_TOOL_CALL_NAME, TOOL_SEARCH_NAME } from "@zcode/contracts";
import { executeToolCall } from "../src/tool/executor/call-runner.js";
import type { ToolExecutorDeps } from "../src/tool/executor/types.js";
import type { ToolEntry, ExecutableToolCall } from "../src/tool/types.js";

/**
 * Executor 级准入：DeferredToolCall 的拒绝发生在任何生命周期之前。
 *
 * 之前的测试覆盖了 resolveDeferredToolCall 本身与 turn-tools 的接线；这里补最后一环：
 * executeToolCall 收到拒绝时不会调用目标工具 handler，并返回配对失败结果。
 * 覆盖两条拒绝分支：未启用搜索（off）与目录里没有目标工具。
 */

const targetHandlerCalls: string[] = [];

function targetEntry(): ToolEntry {
  return {
    capability: "test target",
    metadata: { name: "Bash", readOnly: false, destructive: true },
    handler: async () => {
      targetHandlerCalls.push("Bash");
      return "should not run";
    },
  } as unknown as ToolEntry;
}

function makeDeps(overrides: Partial<Record<string, unknown>> = {}) {
  const events: unknown[] = [];
  const registry = {
    get: (name: string) => (name === "Bash" ? targetEntry() : undefined),
    list: () => [targetEntry()],
  };
  const deps = {
    registry,
    permissionService: {},
    emitEvent: async (event: unknown) => {
      events.push(event);
    },
    sessionId: "session-tool-search-admission",
    defaultTimeoutMs: 1_000,
    ...overrides,
  } as unknown as ToolExecutorDeps;
  return { deps, events };
}

const call: ExecutableToolCall = {
  id: "call-1",
  name: DEFERRED_TOOL_CALL_NAME,
  input: { name: "Bash", input: { command: "echo hi" } },
};

test("搜索未启用：DeferredToolCall 被拒，目标 handler 不执行，且发出配对失败事件", async () => {
  targetHandlerCalls.length = 0;
  const { deps, events } = makeDeps();
  const result = await executeToolCall(deps, {} as never, call);
  assert.equal(result.success, false);
  assert.match(String(result.error?.message), /DeferredToolCall is not available/u);
  assert.deepEqual(targetHandlerCalls, [], "目标工具不应被执行");
  assert.ok(events.length > 0, "拒绝必须走 emitToolCallError，而不是静默返回");
});

test("目录里没有目标：仍被拒，提示该工具不在本次请求里", async () => {
  targetHandlerCalls.length = 0;
  const { deps } = makeDeps();
  const result = await executeToolCall(deps, {} as never, call, {
    toolSearch: {
      mode: "local",
      enabled: true,
      catalog: [{ name: DEFERRED_TOOL_CALL_NAME, deferred: true }],
      discovered: new Set<string>(),
    },
  });
  assert.equal(result.success, false);
  assert.match(String(result.error?.message), /not available in this request/u);
  assert.deepEqual(targetHandlerCalls, []);
});
