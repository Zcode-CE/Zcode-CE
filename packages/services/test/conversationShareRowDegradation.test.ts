import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { buildConversationSharePublicProjection } from "../src/conversation-share/conversationSharePublicProjection.js";

/**
 * 不可读行绝不进分享产物（task-12 的分享侧断言）。
 *
 * 背景：snapshot 与 rows/range 逐行降级后，分享读取路径可能拿到 unreadable 占位行。
 * 占位行是「本端读不懂这一行」的诊断事实，不是会话内容 —— 它既不能投影成占位发给别人，
 * 也不能让整次分享失败。这里钉三件事：
 * 1. 含不可读行的会话仍能分享成功；
 * 2. 产物里不出现该行（也没有任何 kind: "unreadable"）；
 * 3. 过滤不是「什么都放行」：同一路径上的真实违规照旧拒绝。
 *
 * 运行：cd packages/services && node --import tsx --test test/conversationShareRowDegradation.test.ts
 */

const TURN_ID = "t1";
const PRODUCT_TURN_ID = "pt-1";

function wireRows(): ConversationRow[] {
  return [
    {
      rowId: 1,
      turnId: TURN_ID,
      productTurnId: PRODUCT_TURN_ID,
      createdAt: 1_700_000_000_000,
      createdAtSeq: 1,
      kind: "turnHeader",
      origin: "userInput",
      state: "completedSuccess",
      startedAt: 1_700_000_000_000,
    },
    {
      rowId: 2,
      turnId: TURN_ID,
      productTurnId: PRODUCT_TURN_ID,
      createdAt: 1_700_000_000_001,
      createdAtSeq: 2,
      kind: "userInput",
      origin: "realUser",
      text: "hello",
    },
  ];
}

/** 消费端合成的占位行：没有 productTurnId，正是「当成内容投影」时会炸的那一档。 */
const UNREADABLE_ROW = {
  kind: "unreadable",
  rowId: 9001,
  turnId: TURN_ID,
  createdAt: 1_700_000_000_002,
  createdAtSeq: 3,
  sourceKind: "toolCall",
  reason: "invalidRow",
} as const;

const SELECTION = [PRODUCT_TURN_ID];

test("含不可读行的会话仍能分享成功，且占位行不进产物", () => {
  const rows = [...wireRows(), UNREADABLE_ROW] as unknown as ConversationRow[];
  const projection = buildConversationSharePublicProjection({
    rows,
    selectedProductTurnIds: SELECTION,
  });
  // 1) 分享成功：占位行不阻断其余可分享内容。
  assert.equal(projection.rows.length, 2);
  assert.deepEqual(
    projection.rows.map((row) => row.kind),
    ["turnHeader", "userInput"],
  );
  // 2) 产物干净：既没有占位行，也没有任何 unreadable 痕迹（含原始 kind 摘要）。
  assert.equal(
    projection.rows.some((row) => row.kind === "unreadable"),
    false,
  );
  const serialized = JSON.stringify(projection);
  assert.equal(serialized.includes("unreadable"), false, "产物里不得出现 unreadable 字样");
  assert.equal(serialized.includes("sourceKind"), false, "产物里不得出现占位行的诊断字段");
  assert.equal(serialized.includes("9001"), false, "产物里不得出现占位行的 rowId");
  // 3) 公开身份仍按可分享行连续编号（跳过占位行不能让 rowId 出现空洞）。
  assert.deepEqual(
    projection.rows.map((row) => row.rowId),
    [1, 2],
  );
});

test("过滤不是放行：真实违规仍被拒绝", () => {
  // 对照组：同一路径上「轮次仍在跑」必须继续失败，证明上面的成功不是因为整条链路放宽了。
  const rows = wireRows();
  const runningHeader = { ...(rows[0] as Record<string, unknown>), state: "running" };
  assert.throws(
    () =>
      buildConversationSharePublicProjection({
        rows: [runningHeader, rows[1]!] as unknown as ConversationRow[],
        selectedProductTurnIds: SELECTION,
      }),
    (error: unknown) => {
      assert.equal((error as { kind?: string }).kind, "invalid_conversation");
      return true;
    },
  );
});
