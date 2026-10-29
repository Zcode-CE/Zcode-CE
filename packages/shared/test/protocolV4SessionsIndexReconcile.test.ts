import assert from "node:assert/strict";
import test from "node:test";
import {
  sessionsIndexReconcileParamsSchema,
  sessionsIndexReconcileResultSchema,
} from "../src/zcode-protocol-v4/sessions-index.js";
import { V4_METHODS } from "../src/zcode-protocol-v4/transport.js";

/**
 * 上游 3.16.2 W1：sessionsIndex/reconcile 的 wire 契约。
 *
 * 三条判据，每条都对应一个会静默出错的接线错误：
 * 1. 形状：exists 是判别键，两种分支的字段集不能互相"借用"（缺 title 的 exists:true
 *    会让桌面把标题写成 undefined；多字段的 exists:false 说明有人把删除事实塞错了分支）。
 * 2. 严格：params/result 都是 .strict()，未知键必须拒绝——否则 Host 与 CLI 对同一份
 *    语义的字段集分叉后，多出来的键会被静默忽略。
 * 3. 有界：单次最多 256 个 ID（与 CLI/服务层分批一致），超限必须在协议边界拒绝，
 *    不能指望下游分页。
 */

const WORKSPACE = "/work/app";

test("route 常量：线上方法名固定为 v4/sessionsIndex/reconcile", () => {
  assert.equal(V4_METHODS.sessionsIndexReconcile, "v4/sessionsIndex/reconcile");
});

test("params：最小合法形状往返不改写内容", () => {
  const raw = { workspaceId: WORKSPACE, sessionIds: ["s1", "s2"] };
  assert.deepEqual(sessionsIndexReconcileParamsSchema.parse(raw), raw);
});

test("params：workspaceId 空串、空 sessionId、未知键、超限都必须拒绝", () => {
  const reject = (value: unknown) =>
    assert.throws(() => sessionsIndexReconcileParamsSchema.parse(value));
  reject({ workspaceId: "", sessionIds: ["s1"] });
  reject({ workspaceId: WORKSPACE, sessionIds: [""] });
  reject({ workspaceId: WORKSPACE, sessionIds: ["s1"], extra: true });
  reject({ workspaceId: WORKSPACE });
  reject({ sessionIds: ["s1"] });
  // 边界：256 允许，257 拒绝。
  assert.equal(
    sessionsIndexReconcileParamsSchema.parse({
      workspaceId: WORKSPACE,
      sessionIds: Array.from({ length: 256 }, (_, i) => `s${i}`),
    }).sessionIds.length,
    256,
  );
  reject({
    workspaceId: WORKSPACE,
    sessionIds: Array.from({ length: 257 }, (_, i) => `s${i}`),
  });
});

test("result：两种分支往返；可选 lastOutcome 缺席时不伪造", () => {
  const missing = { sessionId: "s1", exists: false as const, deleted: false as const };
  const present = {
    sessionId: "s2",
    exists: true as const,
    deleted: false,
    title: "示例任务",
    titleSource: "generated" as const,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
  };
  const parsed = sessionsIndexReconcileResultSchema.parse({ sessions: [missing, present] });
  assert.deepEqual(parsed, { sessions: [missing, present] });
  const withOutcome = sessionsIndexReconcileResultSchema.parse({
    sessions: [{ ...present, deleted: true, lastOutcome: "interrupted" }],
  });
  assert.equal(
    withOutcome.sessions[0].exists && withOutcome.sessions[0].lastOutcome,
    "interrupted",
  );
  assert.equal(withOutcome.sessions[0].exists ? withOutcome.sessions[0].deleted : null, true);
});

test("result：exists:true 缺字段、exists:false 携带摘要字段、未知键都必须拒绝", () => {
  const reject = (value: unknown) =>
    assert.throws(() => sessionsIndexReconcileResultSchema.parse(value));
  // exists:false 只能是 {sessionId, exists:false, deleted:false}
  reject({ sessions: [{ sessionId: "s1", exists: false, deleted: true }] });
  reject({ sessions: [{ sessionId: "s1", exists: false, deleted: false, title: "t" }] });
  // exists:true 必须带摘要与两个时间戳
  reject({ sessions: [{ sessionId: "s1", exists: true, deleted: false }] });
  reject({
    sessions: [
      {
        sessionId: "s1",
        exists: true,
        deleted: false,
        title: "t",
        titleSource: "generated",
        createdAt: 1,
      },
    ],
  });
  // titleSource 只接受 default/generated/custom
  reject({
    sessions: [
      {
        sessionId: "s1",
        exists: true,
        deleted: false,
        title: "t",
        titleSource: "manual",
        createdAt: 1,
        updatedAt: 2,
      },
    ],
  });
  // lastOutcome 只接受三值
  reject({
    sessions: [
      {
        sessionId: "s1",
        exists: true,
        deleted: false,
        title: "t",
        titleSource: "custom",
        createdAt: 1,
        updatedAt: 2,
        lastOutcome: "done",
      },
    ],
  });
  // 结果对象与分支对象都不接受未知键
  reject({ sessions: [], extra: 1 });
});

test("result：sessions 上限 256（与 params 对称）", () => {
  const fact = (i: number) => ({
    sessionId: `s${i}`,
    exists: false as const,
    deleted: false as const,
  });
  assert.equal(
    sessionsIndexReconcileResultSchema.parse({
      sessions: Array.from({ length: 256 }, (_, i) => fact(i)),
    }).sessions.length,
    256,
  );
  assert.throws(() =>
    sessionsIndexReconcileResultSchema.parse({
      sessions: Array.from({ length: 257 }, (_, i) => fact(i)),
    }),
  );
});
