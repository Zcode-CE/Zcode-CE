/**
 * bootstrap 投影对齐多文字块（blockIndex phase 2 的后续）。
 *
 * 背景：blockIndex 落地后一条 assistant 消息可以有多个文字 part，冷恢复按 part 逐块合成
 * ModelStreaming，所以投影本来就该是多行。真正还按「一条消息一段文字」写的是 bootstrap
 * 自己的取文本处：transcript-hydration 的 textOfMessage 用 join("") 把块粘成一句，
 * session-mapper 的 goal 标题比对与 v4-bridge 的 retryTurn prompt 各有一份形态不同的拼接。
 *
 * 本文件钉四件事（对应 task-29 的四条断言）：
 * 1. 冷恢复三个文字 part（写库顺序与块序不同）→ 投影里三行 assistantText，按块序排列；
 * 2. 旧数据（单块、无 blockIndex 的混排）行输出逐字节不变——金样取自改动前的 HEAD；
 * 3. 反馈落点仍指向该轮第一段文字，多块不会把赞/踩挪到后面的块；
 * 4. 子代理查询在多块摘要下游标仍逐页推进，不重不漏。
 *
 * 多文字块的用户消息不再被粘成 "ab"：real user 与 guide 内联 steer 两条路径都断言块间空行。
 *
 * 运行：cd apps/zcode-cli/packages/bootstrap && node --import tsx --test test/bootstrapMultiBlockProjection.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  orderAssistantBlockParts,
  type AssistantMessageInfo,
  type MessagePart,
  type MessageWithParts,
  type PartId,
  type ProjectID,
  type ReasoningPart,
  type SessionId,
  type SessionInfo,
  type TextPart,
  type ToolPart,
  type UserMessageInfo,
} from "@zcode/contracts";
import { mergeColdConversationEvents } from "../src/zcode-protocol-v4/cold-event-merge.js";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";
import { MESSAGE_TEXT_BLOCK_SEPARATOR, joinMessageTextBlocks } from "../src/message-text.js";
import {
  paginateEndedSubagents,
  projectSessionSubagents,
} from "../src/zcode-protocol/subagent-session-query.js";

const SESSION_ID = "session_multiblock" as SessionId;
const USER_ID = "message_user" as UserMessageInfo["id"];
const STEER_ID = "message_steer" as UserMessageInfo["id"];
const ASSISTANT_ID = "message_assistant" as AssistantMessageInfo["id"];
const BLOCK_SEPARATOR = MESSAGE_TEXT_BLOCK_SEPARATOR;

function textPart(messageID: string, id: string, text: string, blockIndex?: number): MessagePart {
  const part: TextPart = {
    id: id as PartId,
    sessionID: SESSION_ID,
    messageID: messageID as TextPart["messageID"],
    type: "text",
    text,
  };
  if (blockIndex !== undefined) part.blockIndex = blockIndex;
  return part;
}

function reasoningPart(id: string, text: string): MessagePart {
  const part: ReasoningPart = {
    id: id as PartId,
    sessionID: SESSION_ID,
    messageID: ASSISTANT_ID,
    type: "reasoning",
    text,
    time: { start: 2_100 },
  };
  return part;
}

function toolPart(id: string): MessagePart {
  const part: ToolPart = {
    id: id as PartId,
    sessionID: SESSION_ID,
    messageID: ASSISTANT_ID,
    type: "tool",
    callID: `call_${id}`,
    tool: "read",
    state: {
      status: "completed",
      input: {},
      output: "file contents",
      title: "read",
      metadata: {},
      time: { start: 2_200, end: 2_300 },
    },
  };
  return part;
}

function userMessage(parts: MessagePart[], created = 1_000, metadata?: Record<string, unknown>): MessageWithParts {
  const info: UserMessageInfo = {
    id: USER_ID,
    sessionID: SESSION_ID,
    role: "user",
    time: { created },
    agent: "zcode-agent",
  };
  if (metadata) info.metadata = metadata;
  return { info, parts };
}

function steerMessage(parts: MessagePart[]): MessageWithParts {
  const info: UserMessageInfo = {
    id: STEER_ID,
    sessionID: SESSION_ID,
    role: "user",
    time: { created: 1_500 },
    agent: "zcode-agent",
    metadata: { turnSteerDelivery: "guide" },
  };
  return { info, parts };
}

function assistantMessage(
  parts: MessagePart[],
  metadata?: Record<string, unknown>,
): MessageWithParts {
  const info: AssistantMessageInfo = {
    id: ASSISTANT_ID,
    sessionID: SESSION_ID,
    role: "assistant",
    time: { created: 2_000, completed: 3_000 },
    parentID: USER_ID,
    mode: "build",
    agent: "zcode-agent",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  if (metadata) info.metadata = metadata;
  return { info, parts };
}

/** 冷恢复三段归约：transcript → 合成事件 → 三源合并 → 投影 hydration replay。 */
function snapshotOf(messages: MessageWithParts[]) {
  const merged = mergeColdConversationEvents({ memoryEvents: [], messages, sessionId: SESSION_ID });
  const projection = new ProductProjection(SESSION_ID, "epoch-multiblock");
  projection.beginHydrationReplay();
  for (const event of merged.events) projection.applyHydrationEvent(event);
  projection.completeHydrationReplay();
  return projection.getSnapshot();
}

function visibleRows(messages: MessageWithParts[]) {
  return snapshotOf(messages).rows.window.map((row) => ({
    feedback: "feedback" in row ? row.feedback : undefined,
    kind: row.kind,
    text: "text" in row ? row.text : undefined,
  }));
}

// ── ① 冷恢复三个文字块 ─────────────────────────────────────────
test("冷恢复：三个文字块各自一行，顺序按 blockIndex 而不是写库顺序", () => {
  // 写库顺序 t3(5) / t1(1) / t2(3)：只读工具在流中写库、文字块在流结束后写库，
  // 读边界（adapters）用 orderAssistantBlockParts 还原流序，这里复现同一条数据流。
  const written = [
    textPart(ASSISTANT_ID, "t3", "third", 5),
    textPart(ASSISTANT_ID, "t1", "first", 1),
    textPart(ASSISTANT_ID, "t2", "second", 3),
  ];
  const ordered = orderAssistantBlockParts({ role: "assistant" }, written);
  const rows = visibleRows([
    userMessage([textPart(USER_ID, "u1", "多块")]),
    assistantMessage(ordered),
  ]);

  const assistantRows = rows.filter((row) => row.kind === "assistantText");
  assert.deepEqual(
    assistantRows.map((row) => row.text),
    ["first", "second", "third"],
  );
});

// ── ② 旧数据逐字节不变 ─────────────────────────────────────────
// 金样在改动前的 HEAD（47f26637）上跑同一条归约链路取得：投影行窗口的 JSON 快照。
const GOLDEN_SINGLE_BLOCK =
  '{"window":[{"rowId":1,"turnId":"message_user","entityId":"message_user","productTurnId":"message_user","visibility":"visible","createdAt":1000,"createdAtSeq":2,"kind":"turnHeader","origin":"userInput","executionKind":"agent","state":"completedSuccess","startedAt":1000,"endedAt":3000,"activeMs":2000,"historyRoundCount":1},{"rowId":2,"turnId":"message_user","entityId":"message_user","productTurnId":"message_user","visibility":"visible","createdAt":1000,"createdAtSeq":2,"kind":"userInput","text":"旧数据单块","origin":"realUser","actions":{"canEdit":true,"editDisposition":"rewind"}},{"rowId":3,"turnId":"message_user","entityId":"message_assistant","productTurnId":"message_user","visibility":"visible","createdAt":2000,"createdAtSeq":3,"kind":"assistantText","assistantResponseId":"message_assistant","text":"only one","state":"complete","actions":{"canFork":true,"canRetry":true}}],"totalCount":3,"firstRowId":1}';
const GOLDEN_LEGACY_MIXED =
  '{"window":[{"rowId":1,"turnId":"message_user","entityId":"message_user","productTurnId":"message_user","visibility":"visible","createdAt":1000,"createdAtSeq":2,"kind":"turnHeader","origin":"userInput","executionKind":"agent","state":"completedSuccess","startedAt":1000,"endedAt":3000,"activeMs":2000,"historyRoundCount":1},{"rowId":2,"turnId":"message_user","entityId":"message_user","productTurnId":"message_user","visibility":"visible","createdAt":1000,"createdAtSeq":2,"kind":"userInput","text":"旧数据混排","origin":"realUser","actions":{"canEdit":true,"editDisposition":"rewind"}},{"rowId":3,"turnId":"message_user","entityId":"message_assistant","productTurnId":"message_user","visibility":"visible","createdAt":1003,"createdAtSeq":3,"kind":"reasoning","assistantResponseId":"message_assistant","text":"先看文件","state":"complete"},{"rowId":4,"turnId":"message_user","entityId":"message_assistant","productTurnId":"message_user","visibility":"visible","createdAt":2000,"createdAtSeq":6,"kind":"assistantText","assistantResponseId":"message_assistant","text":"Let me check.","state":"complete"},{"rowId":5,"turnId":"message_user","entityId":"call_call-1","productTurnId":"message_user","visibility":"visible","createdAt":1009,"createdAtSeq":9,"kind":"toolCall","assistantResponseId":"message_assistant","toolCallId":"call_call-1","toolName":"read","status":"success","inputText":"{}","input":{},"startedAt":1010,"output":{"text":"file contents"},"endedAt":1011},{"rowId":6,"turnId":"message_user","entityId":"message_assistant","productTurnId":"message_user","visibility":"visible","createdAt":2000,"createdAtSeq":12,"kind":"assistantText","assistantResponseId":"message_assistant","text":"Done.","state":"complete","actions":{"canFork":true,"canRetry":true}}],"totalCount":6,"firstRowId":1}';

test("旧数据硬护栏：单块与无 blockIndex 的混排输出逐字节不变", () => {
  const single = snapshotOf([
    userMessage([textPart(USER_ID, "u1", "旧数据单块")]),
    assistantMessage([textPart(ASSISTANT_ID, "t1", "only one")]),
  ]);
  assert.equal(JSON.stringify(single.rows), GOLDEN_SINGLE_BLOCK);

  const mixed = snapshotOf([
    userMessage([textPart(USER_ID, "u1", "旧数据混排")]),
    assistantMessage([
      reasoningPart("r1", "先看文件"),
      textPart(ASSISTANT_ID, "t1", "Let me check."),
      toolPart("call-1"),
      textPart(ASSISTANT_ID, "t2", "Done."),
    ]),
  ]);
  assert.equal(JSON.stringify(mixed.rows), GOLDEN_LEGACY_MIXED);
});

test("文字块拼接：单块与旧拼接逐字节相同，多块保留块边界", () => {
  const single = [textPart(USER_ID, "u1", "only one")];
  assert.equal(joinMessageTextBlocks(single), "only one");
  // ignored 块与非文字 part 不参与拼接；空块不留空行。
  assert.equal(joinMessageTextBlocks([textPart(USER_ID, "u1", "")]), "");
  const ignored: MessagePart = { ...textPart(USER_ID, "u2", "hidden"), ignored: true } as MessagePart;
  assert.equal(joinMessageTextBlocks([textPart(USER_ID, "u1", "kept"), ignored, toolPart("call-2")]), "kept");
  assert.equal(
    joinMessageTextBlocks([textPart(USER_ID, "u1", "line-a"), textPart(USER_ID, "u2", "line-b")]),
    `line-a${BLOCK_SEPARATOR}line-b`,
  );
});


test("多文字块用户消息：real user 与 guide 内联 steer 的正文保留块边界", () => {
  const rows = visibleRows([
    userMessage([textPart(USER_ID, "u1", "line-a"), textPart(USER_ID, "u2", "line-b")]),
    steerMessage([textPart(STEER_ID, "s1", "steer-a"), textPart(STEER_ID, "s2", "steer-b")]),
    assistantMessage([textPart(ASSISTANT_ID, "t1", "ok")]),
  ]);
  assert.deepEqual(
    rows.filter((row) => row.kind === "userInput").map((row) => row.text),
    [`line-a${BLOCK_SEPARATOR}line-b`, `steer-a${BLOCK_SEPARATOR}steer-b`],
  );
});
// ── ③ 反馈落点 ────────────────────────────────────────────────
test("反馈落点：多文字块仍落在该轮第一段文字", () => {
  const rows = visibleRows([
    userMessage([textPart(USER_ID, "u1", "多块")]),
    assistantMessage(
      [
        textPart(ASSISTANT_ID, "t1", "first", 1),
        textPart(ASSISTANT_ID, "t2", "second", 3),
        textPart(ASSISTANT_ID, "t3", "third", 5),
      ],
      { assistantFeedback: "like" },
    ),
  ]);
  const assistantRows = rows.filter((row) => row.kind === "assistantText");
  assert.deepEqual(
    assistantRows.map((row) => row.feedback),
    ["like", undefined, undefined],
  );
});

// ── ④ 子代理会话查询 ──────────────────────────────────────────
const PARENT_PROJECT = "project_multiblock" as ProjectID;

function sessionInfo(id: string, taskType: SessionInfo["taskType"]): SessionInfo {
  return {
    id: id as SessionId,
    projectID: PARENT_PROJECT,
    taskType,
    slug: id,
    directory: "/tmp",
    title: id,
    version: "test",
    time: { created: 1_000, updated: 2_000 },
  } as SessionInfo;
}

function agentToolPart(childSessionId: string): MessagePart {
  return {
    id: `part_${childSessionId}` as PartId,
    sessionID: SESSION_ID,
    messageID: ASSISTANT_ID,
    type: "tool",
    tool: "Agent",
    callID: `call_${childSessionId}`,
    state: {
      status: "completed",
      input: { description: `delegate ${childSessionId}` },
      output: JSON.stringify({
        agentId: `agent_${childSessionId}`,
        childSessionId,
        description: `delegate ${childSessionId}`,
      }),
      title: "Agent",
      metadata: {},
      time: { start: 2_200, end: 2_300 },
    },
  } as MessagePart;
}

test("子代理查询：多块摘要保留三块，分页游标逐页推进不重不漏", () => {
  const childSessionIds = ["child_a", "child_b", "child_c"];
  const parentSession = sessionInfo("session_parent", "interactive");
  const parentMessages: MessageWithParts[] = [
    {
      info: {
        id: ASSISTANT_ID,
        sessionID: SESSION_ID,
        role: "assistant",
        time: { created: 2_000, completed: 3_000 },
        parentID: USER_ID,
        mode: "build",
        agent: "zcode-agent",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: childSessionIds.map(agentToolPart),
    },
  ];
  const childSessionsById = new Map(
    childSessionIds.map((id) => [id, sessionInfo(id, "subagent_child")] as const),
  );
  // 子会话最后一条 assistant 有三个文字块：摘要必须带上三块（块间空行），不是只剩第一块。
  const childMessagesById = new Map(
    childSessionIds.map(
      (id) =>
        [
          id,
          [
            assistantMessage([
              textPart(ASSISTANT_ID, "t1", `${id} first`, 1),
              textPart(ASSISTANT_ID, "t2", `${id} second`, 3),
              textPart(ASSISTANT_ID, "t3", `${id} third`, 5),
            ]),
          ],
        ] as const,
    ),
  );

  const projection = projectSessionSubagents({
    revision: 1,
    parentSession,
    messages: parentMessages,
    childSessionsById,
    childMessagesById,
    childProjectionsById: new Map(),
  });
  assert.equal(projection.ended.length, childSessionIds.length);
  for (const item of projection.ended) {
    assert.equal(
      item.summary,
      `${item.childSessionId} first${BLOCK_SEPARATOR}${item.childSessionId} second${BLOCK_SEPARATOR}${item.childSessionId} third`,
    );
  }

  // 游标推进：每页一条，三页走完，顺序与 ended 列表一致，不重不漏。
  const visited: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < childSessionIds.length + 1; page += 1) {
    const result = paginateEndedSubagents(projection.ended, {
      ...(cursor === undefined ? {} : { cursor }),
      limit: 1,
    });
    if (result.items.length === 0) break;
    assert.equal(result.items.length, 1);
    visited.push(result.items[0]!.childSessionId);
    cursor = result.nextCursor;
    if (cursor === undefined) break;
  }
  assert.deepEqual(visited, projection.ended.map((item) => item.childSessionId));
  assert.equal(new Set(visited).size, visited.length);
});
