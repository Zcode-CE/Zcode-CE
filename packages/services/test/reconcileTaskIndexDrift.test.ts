import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { ZCODE_AGENT_PROVIDER } from "@zcode/shared";
import type { SessionsIndexReconcileResult } from "@zcode/shared/zcode-protocol-v4";
import { reconcileTaskIndexDrift } from "../src/zcode-agent/reconcileTaskIndexDrift.js";

/**
 * 上游 3.16.2 W1：services 侧的索引漂移校准（能力探测 + 克制判据）。
 *
 * 三条判据，各自对应一个真实的静默错误：
 * 1. 能力探测：旧 CLI 没有 reconcile 时整体跳过——不能"没能力就当没会话"，那会删光列表。
 * 2. 只消费明确删除：exists:false 只是这次查询没命中（类型过滤、分页外、身份不符），
 *    以缺席推断删除不可逆；只有 deleted:true 才收口索引行。
 * 3. 有界：单批 <= 256（协议上限），一次校准不能把上千行塞进一个请求。
 *
 * 注：本测试不启动真实 CLI 进程，agentService/repo 都是最小桩——被测的是
 * 漂移判据本身，不是 RPC 传输（传输由 bootstrap 侧 gateway 测试钉住）。
 */

const WORKSPACE = { workspacePath: "/work/app" } as const;

function meta(taskId: string): ZCodeTaskMeta {
  return {
    taskId,
    traceId: `trace-${taskId}`,
    title: taskId,
    workspacePath: WORKSPACE.workspacePath,
    createdAt: 1,
    updatedAt: 2,
    mode: "default",
    provider: ZCODE_AGENT_PROVIDER,
  } as ZCodeTaskMeta;
}

function createRepo(taskIds: string[]) {
  const listed: unknown[] = [];
  const updates: Array<{ taskId: string; patch: unknown }> = [];
  return {
    listed,
    updates,
    repo: {
      listTaskMetas: async (params: unknown) => {
        listed.push(params);
        return taskIds.map(meta);
      },
      updateTaskState: async (params: { taskId: string; patch: unknown }) => {
        updates.push({ taskId: params.taskId, patch: params.patch });
        return meta(params.taskId);
      },
    },
  };
}

function fact(deleted: boolean, sessionId: string) {
  return {
    sessionId,
    exists: true as const,
    deleted,
    title: sessionId,
    titleSource: "generated" as const,
    createdAt: 1,
    updatedAt: 2,
  };
}

test("能力探测：旧 CLI 无 reconcileSessionsIndexV4 → 不查索引、不改行", async () => {
  const { listed, updates, repo } = createRepo(["a", "b"]);
  await reconcileTaskIndexDrift({
    target: WORKSPACE,
    visibleSessionIds: new Set(["a"]),
    agentService: {},
    taskIndexRepo: repo,
    isCurrent: () => true,
    onRemoved: () => assert.fail("不应广播移除"),
  });
  assert.deepEqual(listed, []);
  assert.deepEqual(updates, []);
});

test("只对快照缺席的行发查询，且只收口 CLI 明确删除的行", async () => {
  const { listed, updates, repo } = createRepo(["visible", "deleted", "absent"]);
  const queried: string[][] = [];
  const removed: string[] = [];
  await reconcileTaskIndexDrift({
    target: WORKSPACE,
    visibleSessionIds: new Set(["visible"]),
    agentService: {
      reconcileSessionsIndexV4: async ({ sessionIds }) => {
        queried.push([...sessionIds]);
        return {
          sessions: [fact(true, "deleted"), { sessionId: "absent", exists: false, deleted: false }],
        } satisfies SessionsIndexReconcileResult;
      },
    },
    taskIndexRepo: repo,
    isCurrent: () => true,
    onRemoved: () => removed.push("removed"),
  });
  // 可见行不进 reconcile（快照已给出它的状态）。
  assert.deepEqual(queried, [["deleted", "absent"]]);
  // provider 过滤：查询与写入都必须限定在 CLI provider 上。
  assert.deepEqual(listed, [{ ...WORKSPACE, provider: ZCODE_AGENT_PROVIDER }]);
  // exists:false 不是删除；只有 deleted:true 收口。
  assert.deepEqual(updates, [{ taskId: "deleted", patch: { deleted: true } }]);
  assert.equal(removed.length, 1);
});

test("分批：超过 256 个缺席 ID 时按协议上限切开", async () => {
  const ids = Array.from({ length: 300 }, (_, i) => `s${i}`);
  const { repo } = createRepo(ids);
  const batches: number[] = [];
  await reconcileTaskIndexDrift({
    target: WORKSPACE,
    visibleSessionIds: new Set(),
    agentService: {
      reconcileSessionsIndexV4: async ({ sessionIds }) => {
        batches.push(sessionIds.length);
        return { sessions: [] };
      },
    },
    taskIndexRepo: repo,
    isCurrent: () => true,
    onRemoved: () => undefined,
  });
  assert.deepEqual(batches, [256, 44]);
});

test("代际校验：isCurrent 转假后立即停止，不再写后续行", async () => {
  const { updates, repo } = createRepo(["a", "b", "c"]);
  let live = true;
  await reconcileTaskIndexDrift({
    target: WORKSPACE,
    visibleSessionIds: new Set(),
    agentService: {
      reconcileSessionsIndexV4: async ({ sessionIds }) => ({
        sessions: sessionIds.map((sessionId) => fact(true, sessionId)),
      }),
    },
    taskIndexRepo: repo,
    isCurrent: () => live,
    onRemoved: () => {
      // 第一行写完后订阅已换代：后续行不得再落库。
      live = false;
    },
  });
  assert.deepEqual(updates, [{ taskId: "a", patch: { deleted: true } }]);
});
