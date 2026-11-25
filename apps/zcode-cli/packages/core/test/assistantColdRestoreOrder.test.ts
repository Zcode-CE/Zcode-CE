/**
 * 冷恢复的有序分支：多个文字块保持独立、旧数据逐字节不变、live 与冷恢复同序。
 *
 * 为什么必须钉住这三条（移植上游 v3.18.2 的 assistant-block-order 规格，设计依据见上游
 * apps/zcode-cli/docs/design/v2/model/assistant-block-order.md）：
 * - 旧路径用 "\n\n" 把多个文字 part 拼成一段，冷恢复只剩一行，而 live 是每块一行。
 * - 旧数据（没有 blockIndex）必须继续走旧拼接路径，请求字节不变；这是升级的兼容护栏。
 * - live 与冷恢复必须走同一个构造函数 buildAssistantEntries，否则续发请求会换字节。
 *
 * 输入是读边界的输出（adapters 的 messages() / messageWithParts() 已按 blockIndex 重排），
 * 这里用 orderAssistantBlockParts 复现读边界，让两个包的断言在同一条数据流上衔接。
 *
 * 运行：cd apps/zcode-cli/packages/core && node --import tsx --test test/assistantColdRestoreOrder.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  orderAssistantBlockParts,
  type AssistantMessageInfo,
  type MessageId,
  type MessagePart,
  type MessageWithParts,
  type PartId,
  type ReasoningPart,
  type SessionId,
  type StepStartPart,
  type TextPart,
  type TokenUsageInfo,
  type ToolPart,
} from "@zcode/contracts";
import {
  buildAssistantEntries,
  createMessageHistory,
  type AssistantHistoryBlock,
  type RuntimeMessageEntry,
} from "../src/agent/message-history.js";
import { hydrateMessageHistoryFromSession } from "../src/agent/session-history-hydrator.js";

const SESSION_ID = "session_1" as SessionId;
const USER_MESSAGE_ID = "message_user" as MessageId;
const ASSISTANT_MESSAGE_ID = "message_assistant" as MessageId;
const TOKENS: TokenUsageInfo = {
  input: 10,
  output: 5,
  reasoning: 0,
  cache: { read: 0, write: 0 },
};
const ASSISTANT = { role: "assistant" } as const;
const START_TIME = 1;

function partBase(id: string): { id: PartId; sessionID: SessionId; messageID: MessageId } {
  return { id: id as PartId, sessionID: SESSION_ID, messageID: ASSISTANT_MESSAGE_ID };
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

function toolPart(id: string, blockIndex?: number): ToolPart {
  return {
    ...partBase(id),
    type: "tool",
    callID: `call_${id}`,
    tool: id,
    state: {
      status: "completed",
      input: {},
      output: "file contents",
      title: id,
      metadata: {},
      time: { start: START_TIME, end: START_TIME + 1 },
    },
    ...(blockIndex === undefined ? {} : { blockIndex }),
  };
}

function stepStartPart(id: string): StepStartPart {
  return { ...partBase(id), type: "step-start" };
}

function assistantMessage(parts: MessagePart[]): MessageWithParts {
  const info: AssistantMessageInfo = {
    id: ASSISTANT_MESSAGE_ID,
    sessionID: SESSION_ID,
    role: "assistant",
    time: { created: START_TIME, completed: START_TIME + 1 },
    parentID: USER_MESSAGE_ID,
    modelId: "test-model" as AssistantMessageInfo["modelId"],
    providerId: "test-provider" as AssistantMessageInfo["providerId"],
    mode: "build",
    agent: "zcode-agent",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: TOKENS,
  };
  return { info, parts };
}

// 到达顺序：reasoning 0、text 1、只读工具 Read 2、text 3、text 5。
// 写库顺序不是这个顺序：只读工具在流中写库，reasoning / text 在流结束后写库。
function writtenParts(): MessagePart[] {
  return [
    stepStartPart("step-start"),
    toolPart("read", 2),
    reasoningPart("think", "先看文件", 0),
    textPart("check", "Let me check.", 1),
    textPart("edit", "Now edit.", 3),
    textPart("done", "Done.", 5),
  ];
}

function assistantEntries(entries: readonly RuntimeMessageEntry[]): RuntimeMessageEntry[] {
  return entries.filter(
    (entry) => entry.kind !== "attachment" && entry.message.role === "assistant",
  );
}

function assistantContent(entry: RuntimeMessageEntry) {
  assert.ok(entry.kind !== "attachment");
  return entry.message.content;
}

test("冷恢复：多个文字块各自成为一个内容块，不拼成一段", async () => {
  const history = createMessageHistory();
  await hydrateMessageHistoryFromSession({
    history,
    messages: [assistantMessage(orderAssistantBlockParts(ASSISTANT, writtenParts()))],
  });

  const entries = assistantEntries(history.toRuntimeEntries());
  assert.equal(entries.length, 1);
  const content = assistantContent(entries[0]!);
  assert.ok(Array.isArray(content));

  const texts = content.filter((block) => block.type === "text").map((block) => block.text);
  assert.deepEqual(texts, ["Let me check.", "Now edit.", "Done."]);
  // 思考块保持自己的到达序号，并且在文字块之前。
  const reasoning = content.filter((block) => block.type === "reasoning");
  assert.deepEqual(
    reasoning.map((block) => block.blockIndex),
    [0],
  );
  // 工具调用带同一序号空间里的 blockIndex，供请求投影与文字块一起排序。
  assert.deepEqual(
    entries[0]!.kind === "attachment" ? [] : entries[0]!.message.toolCalls?.map((call) => call.blockIndex),
    [2],
  );
});

test("旧数据硬护栏：没有 blockIndex 时仍是旧拼接与旧布局", async () => {
  // 同一批 part 去掉 blockIndex：模拟升级前写入的消息。
  const legacyParts: MessagePart[] = [
    stepStartPart("step-start"),
    toolPart("read"),
    reasoningPart("think", "先看文件"),
    textPart("check", "Let me check."),
    textPart("edit", "Now edit."),
    textPart("done", "Done."),
  ];
  const history = createMessageHistory();
  await hydrateMessageHistoryFromSession({
    history,
    messages: [assistantMessage(orderAssistantBlockParts(ASSISTANT, legacyParts))],
  });

  const entries = assistantEntries(history.toRuntimeEntries());
  assert.equal(entries.length, 1);
  const content = assistantContent(entries[0]!);
  assert.ok(Array.isArray(content));
  // 旧布局：[全部思考, 一段文字]；文字仍用 "\n\n" 拼接。
  assert.deepEqual(content, [
    { type: "reasoning", text: "先看文件", providerOptions: undefined },
    { type: "text", text: "Let me check.\n\nNow edit.\n\nDone." },
  ]);
  const toolCalls =
    entries[0]!.kind === "attachment" ? undefined : entries[0]!.message.toolCalls;
  assert.equal(toolCalls?.[0]?.blockIndex, undefined);
});

test("live 与冷恢复同序：同一个构造函数产出相同条目", async () => {
  const readBack = orderAssistantBlockParts(ASSISTANT, writtenParts());
  const history = createMessageHistory();
  await hydrateMessageHistoryFromSession({ history, messages: [assistantMessage(readBack)] });
  const cold = assistantEntries(history.toRuntimeEntries());

  // live：runtime 用同一次结果构造块（reasoning / textBlocks / toolCalls 都带 blockIndex）。
  const blocks: AssistantHistoryBlock[] = [
    {
      kind: "content",
      block: { type: "reasoning", text: "先看文件", providerOptions: undefined, blockIndex: 0 },
    },
    { kind: "content", block: { type: "text", text: "Let me check.", blockIndex: 1 } },
    {
      kind: "tool",
      call: { id: "call_read", input: {}, name: "read", blockIndex: 2 },
    },
    { kind: "content", block: { type: "text", text: "Now edit.", blockIndex: 3 } },
    { kind: "content", block: { type: "text", text: "Done.", blockIndex: 5 } },
  ];
  const liveEntries = buildAssistantEntries({
    blocks,
    model: {
      providerId: "test-provider" as AssistantMessageInfo["providerId"],
      modelId: "test-model" as AssistantMessageInfo["modelId"],
    },
    tokens: TOKENS,
  });
  // live 提交也经过 messageHistory.addEntries 的同一份克隆，两边比较的是 canonical history 条目。
  const liveHistory = createMessageHistory();
  liveHistory.addEntries(liveEntries);
  const live = assistantEntries(liveHistory.toRuntimeEntries());

  assert.deepEqual(cold, live);
});
