import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationRowsPartition } from "../src/v4/conversationRowsPartition.js";
import {
  buildConversationTurnRenderUnits,
  createConversationTurnRenderUnitsSelector,
  sameItems,
} from "../src/v4/conversationTurnRenderUnits.js";

/**
 * 长会话流式派生的复用契约（spec：docs/ui/chat-virtual-scroll.md「每帧派生成本」）。
 *
 * 回归的是上游 3.17.2 修掉的卡顿根因：选择器每帧对全部 rows 分组并逐轮确认「没变」，
 * 成本随历史长度线性增长。修复后历史段按 history 数组引用缓存，每帧只 materialize 尾轮。
 * 这里钉住两条不能破的性质：
 * ① 等价：分区选择器的输出与对全部 rows 一次性构建逐项相等（否则复用会改变界面）；
 * ② 引用稳定：尾轮增长时历史段的数组与 unit 引用必须原样保留（否则缓存全失效、卡顿回来）。
 */

const T0 = 1_760_000_000_000;
let rowId = 0;
const nextId = () => ++rowId;

function baseRow(turnId: string, at: number) {
  return { rowId: nextId(), turnId, createdAt: at, createdAtSeq: nextId() };
}

function turnHeader(turnId: string, at: number): ConversationRow {
  return { ...baseRow(turnId, at), kind: "turnHeader", origin: "userInput" } as ConversationRow;
}

function userInput(turnId: string, text: string, at: number): ConversationRow {
  return {
    ...baseRow(turnId, at),
    kind: "userInput",
    origin: "realUser",
    text,
  } as ConversationRow;
}

function assistantText(
  turnId: string,
  text: string,
  state: "streaming" | "complete",
  at: number,
): ConversationRow {
  return { ...baseRow(turnId, at), kind: "assistantText", text, state } as ConversationRow;
}

/** 一轮：header + 用户输入 + 助手正文。 */
function turn(turnId: string, text: string, state: "streaming" | "complete"): ConversationRow[] {
  const at = T0 + nextId();
  return [
    turnHeader(turnId, at),
    userInput(turnId, "问题 " + turnId, at + 1),
    assistantText(turnId, text, state, at + 2),
  ];
}

const history = [
  ...turn("t1", "第一轮回答", "complete"),
  ...turn("t2", "第二轮回答", "complete"),
  ...turn("t3", "第三轮回答", "complete"),
];
const streamingTail = turn("t4", "正在流式输出", "streaming");
const partition: ConversationRowsPartition = { history, tail: streamingTail };

const allRows = [...history, ...streamingTail];

test("分区选择器与全量构建逐项相等（等价性）", () => {
  const select = createConversationTurnRenderUnitsSelector();
  const out = select(partition, { nowMs: T0 + 1_000_000 });
  const full = buildConversationTurnRenderUnits(allRows, { nowMs: T0 + 1_000_000 });
  assert.deepEqual([...out.history, ...out.tail], full);
});

test("尾轮流式增长时历史段数组与 unit 引用保持不变", () => {
  const select = createConversationTurnRenderUnitsSelector();
  const first = select(partition, { nowMs: T0 + 1_000_000 });
  const grownTail = [...streamingTail];
  grownTail[grownTail.length - 1] = assistantText(
    "t4",
    "正在流式输出，又多了几个字",
    "streaming",
    T0 + 1,
  );
  const second = select({ history, tail: grownTail }, { nowMs: T0 + 1_000_001 });

  assert.equal(second.history, first.history, "历史段数组引用必须保留");
  assert.equal(second.history.length, first.history.length);
  second.history.forEach((unit, index) => {
    assert.equal(unit, first.history[index], "历史段 unit 引用必须保留");
  });
  assert.notEqual(second.tail, first.tail, "尾轮必须重算");
});

test("历史段变化后重新推导，且结果仍与全量构建相等", () => {
  const select = createConversationTurnRenderUnitsSelector();
  const first = select(partition, { nowMs: T0 + 1_000_000 });
  // t4 完成并冻结进历史：历史引用变了，必须重算历史段而不是继续用旧结果。
  const nextHistory = [...history, ...turn("t4", "第四轮回答", "complete")];
  const nextTail = turn("t5", "第五轮输出中", "streaming");
  const second = select({ history: nextHistory, tail: nextTail }, { nowMs: T0 + 1_000_002 });

  assert.notEqual(second.history, first.history);
  assert.deepEqual(
    [...second.history, ...second.tail],
    buildConversationTurnRenderUnits([...nextHistory, ...nextTail], { nowMs: T0 + 1_000_002 }),
  );
});

test("尾轮被过滤掉时历史末项按最后一轮重新归一化", () => {
  const select = createConversationTurnRenderUnitsSelector();
  // 只有一个 header 的尾轮会被 shouldKeepRenderUnit 过滤；此时历史末项才是「最后一轮」。
  const emptyTail: ConversationRow[] = [turnHeader("t9", T0 + 9)];
  const out = select({ history, tail: emptyTail }, { nowMs: T0 + 1_000_000 });
  assert.deepEqual(
    [...out.history, ...out.tail],
    buildConversationTurnRenderUnits(history, { nowMs: T0 + 1_000_000 }),
  );
  assert.equal(out.history.at(-1)?.isLastTurn, true);
});

test("sameItems 只做逐项引用比较", () => {
  const a = { id: 1 };
  assert.equal(sameItems([a, a], [a, a]), true);
  assert.equal(sameItems([a], [a, a]), false);
  assert.equal(sameItems([a], [{ id: 1 }]), false);
  assert.equal(sameItems([], []), true);
});
