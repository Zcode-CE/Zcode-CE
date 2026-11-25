/**
 * assistant 内容块顺序（blockIndex）：读边界还原到达顺序、多文字块不被拼接、live 与冷恢复同序。
 *
 * 为什么必须钉住这三条（移植上游 v3.18.2 的 assistant-block-order 规格，设计依据见上游
 * apps/zcode-cli/docs/design/v2/model/assistant-block-order.md）：
 * - 库里 part 的物理顺序是写库顺序，不是流顺序：只读工具在流中写库，reasoning / text 在流结束后写库。
 *   不按 blockIndex 重排，文字块会被挪到后面的思考块之后，校验签名前缀的渠道返回 400
 *   （The block is bound to a different conversation）。
 * - 多个文字块如果在读取时被拼成一段，冷恢复就只剩一行，而 live 是每块一行。
 * - live 与冷恢复必须用同一个顺序来源（blockIndex）；两个来源不同，同一条消息的续发请求就会换字节。
 *
 * 本文件覆盖的范围：contracts 的块顺序契约（interfaces/session-store.port.ts）与 core 的历史工具选择
 * （agent/tool-part-order.ts）。runtime 分配序号、adapters 读边界与请求投影的接入不在本文件范围内，
 * 所以这里只能断言两条通路的顺序来源与结果一致，不能断言真实请求体逐字节相同。
 *
 * 运行：cd apps/zcode-cli/packages/core && node --import tsx --test test/assistantBlockOrder.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  assistantBlockParts,
  hasOrderedAssistantBlocks,
  isBlockIndex,
  orderAssistantBlockParts,
  sortByCompleteIndex,
  type MessageId,
  type MessagePart,
  type PartId,
  type ReasoningPart,
  type SessionId,
  type StepStartPart,
  type TextPart,
  type ToolPart,
} from "@zcode/contracts";
import { selectToolPartsForHistory } from "../src/agent/tool-part-order.js";

const SESSION_ID = "session_1" as SessionId;
const MESSAGE_ID = "message_1" as MessageId;
const ASSISTANT = { role: "assistant" } as const;
const USER = { role: "user" } as const;
const START_TIME = 1;

function partBase(id: string): { id: PartId; sessionID: SessionId; messageID: MessageId } {
  return { id: id as PartId, sessionID: SESSION_ID, messageID: MESSAGE_ID };
}

function textPart(id: string, text: string, blockIndex?: number): TextPart {
  return {
    ...partBase(id),
    type: "text",
    text,
    ...(blockIndex === undefined ? {} : { blockIndex }),
  };
}

function reasoningPart(id: string, text: string, blockIndex?: number): ReasoningPart {
  return {
    ...partBase(id),
    type: "reasoning",
    text,
    time: { start: START_TIME },
    ...(blockIndex === undefined ? {} : { blockIndex }),
  };
}

function toolPart(
  id: string,
  indexes: { blockIndex?: number; declarationIndex?: number } = {},
): ToolPart {
  return {
    ...partBase(id),
    type: "tool",
    callID: `call_${id}`,
    tool: id,
    state: { status: "pending", input: {}, raw: "" },
    ...(indexes.blockIndex === undefined ? {} : { blockIndex: indexes.blockIndex }),
    ...(indexes.declarationIndex === undefined
      ? {}
      : { declarationIndex: indexes.declarationIndex }),
  };
}

function stepStartPart(id: string): StepStartPart {
  return { ...partBase(id), type: "step-start" };
}

function ids(parts: readonly MessagePart[]): string[] {
  return parts.map((part) => part.id);
}

function callIds(parts: readonly ToolPart[]): string[] {
  return parts.map((part) => part.callID);
}

function toolPartsOf(parts: readonly MessagePart[]): ToolPart[] {
  return parts.filter((part): part is ToolPart => part.type === "tool");
}

test("乱序到达：读边界按 blockIndex 还原到达顺序，非块 part 的位置不变", () => {
  // 到达顺序是 reasoning 0、text 1、只读工具 Read 2、text 3。
  // 写库顺序不是这个顺序：只读工具在流中写库，reasoning / text 在流结束后写库。
  const written: MessagePart[] = [
    stepStartPart("step-start"),
    toolPart("read", { blockIndex: 2 }),
    reasoningPart("think", "先看文件", 0),
    textPart("check", "Let me check.", 1),
    textPart("edit", "Now edit.", 3),
  ];

  assert.equal(hasOrderedAssistantBlocks(written), true);
  assert.deepEqual(ids(orderAssistantBlockParts(ASSISTANT, written)), [
    "step-start",
    "think",
    "check",
    "read",
    "edit",
  ]);
  // 原始 parts 仍供 UI 与文件读取状态恢复使用，不能被就地改写。
  assert.deepEqual(ids(written), ["step-start", "read", "think", "check", "edit"]);
});

test("旧消息、混合消息与 user 消息保持物理顺序", () => {
  const legacy: MessagePart[] = [textPart("a", "A"), reasoningPart("b", "B"), toolPart("c")];
  assert.equal(hasOrderedAssistantBlocks(legacy), false);
  assert.deepEqual(ids(orderAssistantBlockParts(ASSISTANT, legacy)), ["a", "b", "c"]);

  // 混有旧版本写入的 part 时整条消息按旧数据处理，不存在部分有序。
  const mixed: MessagePart[] = [
    toolPart("tool", { blockIndex: 2 }),
    reasoningPart("reasoning", "R", 0),
    textPart("text", "X"),
  ];
  assert.equal(hasOrderedAssistantBlocks(mixed), false);
  assert.deepEqual(ids(orderAssistantBlockParts(ASSISTANT, mixed)), ["tool", "reasoning", "text"]);

  const userParts: MessagePart[] = [textPart("u1", "U1", 1), textPart("u0", "U0", 0)];
  assert.deepEqual(ids(orderAssistantBlockParts(USER, userParts)), ["u1", "u0"]);
});

test("多文字块不被拼接：读边界只重排，不合并、不丢块", () => {
  const written: MessagePart[] = [
    toolPart("read", { blockIndex: 2 }),
    textPart("p", "Let me check.", 1),
    textPart("q", "Now edit.", 3),
    textPart("r", "Done.", 5),
    reasoningPart("think", "想一下", 0),
  ];

  const readBack = orderAssistantBlockParts(ASSISTANT, written);
  const texts = assistantBlockParts(readBack)
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text);

  // 三块仍是三个 part：拼成一段会让冷恢复只剩一行，而 live 是三行。
  assert.deepEqual(texts, ["Let me check.", "Now edit.", "Done."]);
  assert.equal(assistantBlockParts(readBack).length, 5);
});

test("live 与冷恢复同一顺序：两条通路的顺序来源都是 blockIndex", () => {
  // provider 在流结束时按 index 发 tool_call，声明的先后（declarationIndex）却可能相反：
  // 这里让 blockIndex 顺序与 declarationIndex 顺序冲突，只有 blockIndex 一个来源时两组结果才一致。
  const written: MessagePart[] = [
    toolPart("native", { blockIndex: 1, declarationIndex: 0 }),
    toolPart("write", { blockIndex: 0, declarationIndex: 2 }),
    toolPart("read", { blockIndex: 2, declarationIndex: 1 }),
  ];
  const toolParts = toolPartsOf(written);

  // live：runtime 按块开始序号提交执行与结果（与 executeToolCallsForModelStep 用同一个 sortByCompleteIndex）。
  const live = sortByCompleteIndex(toolParts, (part) => part.blockIndex);
  assert.deepEqual(live ? callIds(live) : undefined, ["call_write", "call_native", "call_read"]);

  // 冷恢复：读边界先按 blockIndex 重排，再按同一规则选历史工具。
  const cold = selectToolPartsForHistory(toolPartsOf(orderAssistantBlockParts(ASSISTANT, written)));
  assert.deepEqual(callIds(cold), ["call_write", "call_native", "call_read"]);
  assert.deepEqual(callIds(cold), live ? callIds(live) : undefined);
});

test("旧记录仍按 declarationIndex 排序（不回归）", () => {
  const written: MessagePart[] = [
    toolPart("second", { declarationIndex: 1 }),
    toolPart("first", { declarationIndex: 0 }),
  ];
  // 读边界不动旧消息的物理顺序。
  assert.deepEqual(ids(orderAssistantBlockParts(ASSISTANT, written)), ["second", "first"]);
  // 历史选择回退到声明序号。
  assert.deepEqual(callIds(selectToolPartsForHistory(toolPartsOf(written))), [
    "call_first",
    "call_second",
  ]);
});

test("同一 callID 只保留最后一个 part，序号相同时保持物理顺序", () => {
  const retriedDone: ToolPart = {
    ...toolPart("read", { blockIndex: 0 }),
    state: { status: "running", input: {}, time: { start: START_TIME } },
  };
  const retriedLate: ToolPart = {
    ...toolPart("read", { blockIndex: 0 }),
    state: { status: "pending", input: {}, raw: "" },
  };
  const write = toolPart("write", { blockIndex: 1 });

  const selected = selectToolPartsForHistory([retriedDone, write, retriedLate]);
  // 同一声明只恢复最后新建的记录，旧 part 迟到更新不影响选择。
  assert.deepEqual(selected.map((part) => part.state.status), ["pending", "pending"]);
  assert.deepEqual(ids(selected), ["read", "write"]);

  // 不同 callID 共用同一序号时按物理顺序稳定排序。
  const tied = sortByCompleteIndex([write, retriedDone], (part) => part.blockIndex);
  assert.deepEqual(tied ? ids(tied) : undefined, ["read", "write"]);
});

test("isBlockIndex：只有非负整数是合法序号", () => {
  for (const value of [0, 1, 42]) assert.equal(isBlockIndex(value), true);
  for (const value of [undefined, null, -1, 1.5, Number.NaN, "0"]) {
    assert.equal(isBlockIndex(value), false);
  }
  // 有一项非法时整组不排序，由调用方退回物理顺序。
  assert.equal(sortByCompleteIndex([{ index: 0 }, { index: 1.5 }], (item) => item.index), undefined);
});
