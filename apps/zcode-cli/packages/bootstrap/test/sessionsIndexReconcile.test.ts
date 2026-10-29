import assert from "node:assert/strict";
import test from "node:test";
import type { V4GatewayHost } from "../src/zcode-protocol-v4/v4-gateway.js";
import { ConversationV4Gateway } from "../src/zcode-protocol-v4/v4-gateway.js";
import { reconcileStoredSessions } from "../src/zcode-protocol/sessions-index-reconcile.js";

/**
 * 上游 3.16.2 W1：sessionsIndex/reconcile 的 CLI 侧接线。
 *
 * 钉三件事：
 * 1. 能力缺席必须报固定 unavailable —— 退化成"空结果"会让桌面把全部会话当成不存在。
 * 2. 有能力时透传：入参先过 schema，宿主返回值再过 schema（宿主 bug 不能进 wire）。
 * 3. 持久事实查询只碰 getSession：workspace 归属（远端 identity 强于目录）、标题来源归一、
 *    缺失即 exists:false；不创建也不恢复 runtime（查询面类型就是 `getSession` 单方法）。
 */

const UNAVAILABLE = "sessionsIndex/reconcile is unavailable";

function createGateway(capability?: V4GatewayHost["reconcileSessions"]) {
  const calls: unknown[] = [];
  const host = {
    sessionExists: () => false,
    emitWireFrame: () => undefined,
    executeCommand: async () => undefined,
    ...(capability
      ? {
          reconcileSessions: async (params: Parameters<NonNullable<typeof capability>>[0]) => {
            calls.push(params);
            return capability(params);
          },
        }
      : {}),
  } as unknown as V4GatewayHost;
  const gateway = new ConversationV4Gateway(host);
  return { calls, gateway };
}

const PARAMS = { workspaceId: "/work/app", sessionIds: ["s1"] };

test("gateway：宿主无 reconcileSessions 能力 → 固定 unavailable 文案", async () => {
  const { gateway } = createGateway();
  try {
    await assert.rejects(() => gateway.reconcileSessions(PARAMS), { message: UNAVAILABLE });
  } finally {
    gateway.dispose();
  }
});

test("gateway：有能力时透传解析后的参数与结果（逐字段）", async () => {
  const fact = {
    sessionId: "s1",
    exists: true as const,
    deleted: false,
    title: "示例任务",
    titleSource: "custom" as const,
    createdAt: 10,
    updatedAt: 20,
  };
  const { calls, gateway } = createGateway(async () => ({ sessions: [fact] }));
  try {
    const result = await gateway.reconcileSessions(PARAMS);
    assert.deepEqual(calls, [PARAMS]);
    assert.deepEqual(result, { sessions: [fact] });
  } finally {
    gateway.dispose();
  }
});

test("gateway：非法入参在调用宿主前被 schema 拒绝", async () => {
  const { calls, gateway } = createGateway(async () => ({ sessions: [] }));
  try {
    await assert.rejects(() => gateway.reconcileSessions({ workspaceId: "/work/app" }));
    await assert.rejects(() =>
      gateway.reconcileSessions({ ...PARAMS, extra: 1 }),
    );
    assert.deepEqual(calls, []);
  } finally {
    gateway.dispose();
  }
});

test("gateway：宿主返回越界形状（exists:true 缺 title）必须拒绝，不得下发", async () => {
  const { gateway } = createGateway(
    async () =>
      ({ sessions: [{ sessionId: "s1", exists: true, deleted: false }] }) as never,
  );
  try {
    await assert.rejects(() => gateway.reconcileSessions(PARAMS));
  } finally {
    gateway.dispose();
  }
});

type StoredSession = {
  id: string;
  directory: string;
  workspaceID?: string;
  title: string;
  titleSource?: string;
  time: { created: number; updated: number };
};

function createStore(sessions: StoredSession[]) {
  const requested: string[] = [];
  return {
    requested,
    store: {
      getSession: async (sessionId: string) => {
        requested.push(sessionId);
        const found = sessions.find((session) => session.id === sessionId);
        // 只提供被测代码读取的字段；其余字段由 store 保证存在，本测试不模拟它们。
        return (found ?? null) as never;
      },
    },
  };
}

test("bridge 查询：本地 workspace 缺 identity 的会话正常命中，缺记录返回 exists:false", async () => {
  const { store } = createStore([
    { id: "s1", directory: "/work/app", title: "任务一", titleSource: "custom", time: { created: 1, updated: 2 } },
  ]);
  const result = await reconcileStoredSessions({
    store,
    workspaceId: "/work/app",
    sessionIds: ["s1", "gone"],
  });
  assert.deepEqual(result.sessions, [
    {
      sessionId: "s1",
      exists: true,
      deleted: false,
      title: "任务一",
      titleSource: "custom",
      createdAt: 1,
      updatedAt: 2,
    },
    { sessionId: "gone", exists: false, deleted: false },
  ]);
});

test("bridge 查询：目录不一致 / 其他 identity 的会话不算命中", async () => {
  const { store } = createStore([
    { id: "other-dir", directory: "/work/elsewhere", title: "t", time: { created: 1, updated: 1 } },
    {
      id: "other-identity",
      directory: "/work/app",
      workspaceID: "remote:docker:box:/work/app",
      title: "t",
      time: { created: 1, updated: 1 },
    },
  ]);
  const result = await reconcileStoredSessions({
    store,
    workspaceId: "/work/app",
    sessionIds: ["other-dir", "other-identity"],
  });
  assert.deepEqual(
    result.sessions.map((fact) => fact.exists),
    [false, false],
  );
});

test("bridge 查询：远端 identity 必须精确匹配 identity 而非目录", async () => {
  const remoteIdentity = "remote:docker:box:/work/app";
  const { store } = createStore([
    { id: "local", directory: "/work/app", title: "本地", time: { created: 1, updated: 1 } },
    {
      id: "remote",
      directory: "/work/app",
      workspaceID: remoteIdentity,
      title: "远端",
      time: { created: 5, updated: 6 },
    },
  ]);
  const result = await reconcileStoredSessions({
    store,
    workspaceId: remoteIdentity,
    sessionIds: ["local", "remote"],
  });
  assert.deepEqual(result.sessions, [
    { sessionId: "local", exists: false, deleted: false },
    {
      sessionId: "remote",
      exists: true,
      deleted: false,
      title: "远端",
      titleSource: "generated",
      createdAt: 5,
      updatedAt: 6,
    },
  ]);
});

test("bridge 查询：重复 ID 只查一次（分批上限之内去重）", async () => {
  const { requested, store } = createStore([
    { id: "s1", directory: "/work/app", title: "t", titleSource: "default", time: { created: 1, updated: 1 } },
  ]);
  const result = await reconcileStoredSessions({
    store,
    workspaceId: "/work/app",
    sessionIds: ["s1", "s1"],
  });
  assert.deepEqual(requested, ["s1"]);
  assert.equal(result.sessions.length, 1);
});
