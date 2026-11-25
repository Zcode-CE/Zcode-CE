/**
 * live 到达路径的块序号：流式分配、结果转块、提交到历史、持久化文字块。
 *
 * 为什么必须钉住这条（移植上游 v3.18.2 的 assistant-block-order 规格）：只加读边界排序不分配序号，
 * 排序就是空转。live 路径有三段必须一起成立：
 * 1. 流式事件分配 blockIndex（reasoning / text / tool 共用一个序号空间，工具之后复用的文字 id 要新开块）；
 * 2. 模型结果按块转成历史条目，内容块与工具调用共用序号排序；
 * 3. 写库按文字块逐块写 part 并带序号，冷恢复才能和 live 一样一块一行。
 * 没有 textBlocks 的旧结果继续走旧条目，行为逐字节不变（旧数据硬护栏）。
 *
 * 运行：cd apps/zcode-cli/packages/core && node --import tsx --test test/assistantLiveBlockOrder.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { MessageId, SessionId, TextPart } from "@zcode/contracts";
import {
  createMessageHistory,
  type RuntimeMessageEntry,
  type ToolCallInput,
} from "../src/agent/message-history.js";
import { createTextBlock, getOrCreateTextBlock, getOrCreateReasoningBlock } from "../src/runtime/methods/reasoning-stream.js";
import { persistTextBlockParts } from "../src/runtime/methods/message-persistence.js";
import { commitAssistantToTurnRequest } from "../src/runtime/methods/turn-output-token-continuation.js";
import { orderedAssistantHistoryBlocks } from "../src/runtime/helpers/assistant-history-blocks.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { RegularTurnLoopState } from "../src/runtime/methods/turn-loop-state.js";
import type { RuntimeModelTextResult } from "../src/runtime/types.js";

const SESSION_ID = "session_1" as SessionId;
const MESSAGE_ID = "message_1" as MessageId;

function assistantEntries(entries: readonly RuntimeMessageEntry[]): RuntimeMessageEntry[] {
  return entries.filter(
    (entry) => entry.kind !== "attachment" && entry.message.role === "assistant",
  );
}

function resultOf(overrides: Partial<RuntimeModelTextResult> = {}): RuntimeModelTextResult {
  return {
    finishReason: "stop",
    text: "Let me check.Now edit.Done.",
    textBlocks: [
      { type: "text", text: "Let me check.", blockIndex: 1 },
      { type: "text", text: "Now edit.", blockIndex: 3 },
      { type: "text", text: "Done.", blockIndex: 5 },
    ],
    reasoning: [{ type: "reasoning", text: "先看文件", blockIndex: 0 }],
    toolCalls: [
      { id: "call_read", name: "read", input: {}, blockIndex: 2 },
      { id: "call_write", name: "write", input: {}, blockIndex: 4 },
    ],
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    ...overrides,
  };
}

function liveRuntime() {
  const messageHistory = createMessageHistory();
  const runtime = {
    messageHistory,
    sessionId: SESSION_ID,
    logger: undefined,
  } as unknown as AgentRuntimeInternal;
  const state = {
    model: { providerId: "test-provider", modelId: "test-model" },
    modelResponse: "Let me check.Now edit.Done.",
    turnRequestState: { entries: [] },
  } as unknown as RegularTurnLoopState;
  return { messageHistory, runtime, state };
}

test("流式分配：reasoning / text / tool 共用序号，工具后复用的文字 id 新开块", () => {
  let nextBlockIndex = 0;
  const allocateBlockIndex = () => nextBlockIndex++;
  const lastAllocatedBlockIndex = () => (nextBlockIndex > 0 ? nextBlockIndex - 1 : undefined);
  const reasoning = [] as { type: "reasoning"; text: string; blockIndex?: number }[];
  const reasoningById = new Map();
  const textBlocks = [] as { type: "text"; text: string; blockIndex?: number }[];
  const textById = new Map();

  const reasoningBlock = getOrCreateReasoningBlock({
    id: "r0",
    reasoning,
    reasoningById,
    allocateBlockIndex,
  });
  createTextBlock({ id: "txt-0", textBlocks, textById, allocateBlockIndex });
  // openai-compatible 在工具调用之后复用同一个文字 id：这里先分配一个工具块，再回到 txt-0。
  allocateBlockIndex();
  const reused = getOrCreateTextBlock({
    id: "txt-0",
    textBlocks,
    textById,
    allocateBlockIndex,
    lastAllocatedBlockIndex,
  });

  assert.equal(reasoningBlock.blockIndex, 0);
  assert.deepEqual(
    textBlocks.map((block) => block.blockIndex),
    [1, 3],
  );
  assert.equal(reused.created, true);
  // 同一个 id 且仍是最后一块时复用原块，不再分配序号。
  const same = getOrCreateTextBlock({
    id: "txt-0",
    textBlocks,
    textById,
    allocateBlockIndex,
    lastAllocatedBlockIndex,
  });
  assert.equal(same.created, false);
  assert.equal(same.block.blockIndex, 3);
});

test("结果转块：内容块与工具调用共用序号排序，旧结果返回 undefined", () => {
  const blocks = orderedAssistantHistoryBlocks(resultOf(), [
    { id: "call_read", name: "read", input: {}, blockIndex: 2 },
    { id: "call_write", name: "write", input: {}, blockIndex: 4 },
  ]);
  assert.ok(blocks);
  // 转块只负责收集，排序由 buildAssistantEntries 统一做（与上游同一分工）。
  assert.deepEqual(
    blocks
      .map((block) => (block.kind === "content" ? block.block.blockIndex : block.call.blockIndex))
      .sort((left, right) => left! - right!),
    [0, 1, 2, 3, 4, 5],
  );

  // 没有 textBlocks：非流式未编号的旧结果按旧条目提交。
  assert.equal(orderedAssistantHistoryBlocks(resultOf({ textBlocks: undefined })), undefined);
});

test("live 提交：有序结果产出按块排列的条目，旧结果保持旧条目", () => {
  const ordered = liveRuntime();
  const toolCalls: ToolCallInput[] = [
    { id: "call_read", name: "read", input: {}, blockIndex: 2 },
    { id: "call_write", name: "write", input: {}, blockIndex: 4 },
  ];
  assert.equal(
    commitAssistantToTurnRequest(ordered.runtime, ordered.state, resultOf(), toolCalls),
    true,
  );
  const [entry] = assistantEntries(ordered.messageHistory.toRuntimeEntries());
  assert.ok(entry && entry.kind !== "attachment");
  const content = entry.message.content;
  assert.ok(Array.isArray(content));
  assert.deepEqual(
    content.map((block) => block.blockIndex),
    [0, 1, 3, 5],
  );
  assert.deepEqual(
    entry.message.toolCalls?.map((call) => call.blockIndex),
    [2, 4],
  );

  const legacy = liveRuntime();
  assert.equal(
    commitAssistantToTurnRequest(
      legacy.runtime,
      legacy.state,
      resultOf({ textBlocks: undefined }),
      toolCalls,
    ),
    true,
  );
  const [legacyEntry] = assistantEntries(legacy.messageHistory.toRuntimeEntries());
  assert.ok(legacyEntry && legacyEntry.kind !== "attachment");
  const legacyContent = legacyEntry.message.content;
  assert.ok(Array.isArray(legacyContent));
  // 旧条目：[全部思考, 一段拼接文字]，工具调用不带序号。
  assert.deepEqual(legacyContent, [
    { type: "reasoning", text: "先看文件", providerOptions: undefined },
    { type: "text", text: "Let me check.Now edit.Done." },
  ]);
  assert.equal(legacyEntry.message.toolCalls?.[0]?.blockIndex, undefined);
});

test("写库：每个文字块一个 text part 且带序号，空块不写，旧结果写单个无序号 part", async () => {
  const persisted: TextPart[] = [];
  const runtime = {
    persistPart: async (part: TextPart) => {
      persisted.push(part);
    },
    sessionId: SESSION_ID,
    logger: undefined,
  } as unknown as AgentRuntimeInternal;

  await persistTextBlockParts(
    runtime,
    {
      messageId: MESSAGE_ID,
      textBlocks: [
        { type: "text", text: "Let me check.", blockIndex: 1 },
        { type: "text", text: "", blockIndex: 2 },
        { type: "text", text: "Now edit.", blockIndex: 3 },
      ],
      text: "Let me check.Now edit.",
      time: { start: 1, end: 2 },
    },
    {} as never,
  );
  assert.deepEqual(
    persisted.map((part) => [part.text, part.blockIndex]),
    [
      ["Let me check.", 1],
      ["Now edit.", 3],
    ],
  );

  persisted.length = 0;
  await persistTextBlockParts(
    runtime,
    {
      messageId: MESSAGE_ID,
      textBlocks: undefined,
      text: "Let me check.Now edit.",
      time: { start: 1, end: 2 },
    },
    {} as never,
  );
  assert.deepEqual(
    persisted.map((part) => [part.text, part.blockIndex]),
    [["Let me check.Now edit.", undefined]],
  );
});
