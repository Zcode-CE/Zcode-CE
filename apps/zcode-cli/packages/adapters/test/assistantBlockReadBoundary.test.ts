/**
 * 读边界（session-store repository）：assistant 的块 part 按 blockIndex 还原到达顺序。
 *
 * 为什么必须钉住这条（移植上游 v3.18.2 的 assistant-block-order 规格）：
 * 库里 part 的物理顺序是写库顺序，不是流顺序——只读工具在流中写库，reasoning / text 在流结束后写库。
 * messages() 与 messageWithParts() 是 V4 冷恢复、services 与 fork 共用的读取点；不在这里按 blockIndex
 * 重排，消费方就会把文字块排到后面的思考块之后，Anthropic 校验思考块签名前缀时返回 400
 * （The block is bound to a different conversation）。
 *
 * 这里用真实 SQLite（Node 内置 node:sqlite + 生产迁移）走「写入 → 读边界 → 顺序」的完整链路；
 * 临时库落在系统临时目录，用例结束即删除。
 *
 * 运行：cd apps/zcode-cli/packages/adapters && node --import tsx --test test/assistantBlockReadBoundary.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { ModelInputMessage } from "@zcode/contracts";
import { toAiSdkMessages } from "../src/model/transform.js";
import { runSqliteSessionMigrations } from "../src/storage/session-store/migration-runner.js";
import {
  messageWithParts,
  messages,
  saveMessage,
  savePart,
} from "../src/storage/session-store/repositories/messages.js";

const SESSION_ID = "session_1";
const MESSAGE_ID = "message_1";
const START_TIME = 1;

async function withSessionDatabase(
  run: (db: DatabaseSync) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "zcode-blockorder-"));
  const dbPath = join(dir, "session.db");
  const db = new DatabaseSync(dbPath);
  try {
    runSqliteSessionMigrations(db, dbPath, 5_000, { backupRootDir: join(dir, "backup") });
    db.prepare(
      "insert into session (id, project_id, slug, directory, title, version, time_created, time_updated) values (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(SESSION_ID, "project_1", "session-1", "/tmp", "test", "1", START_TIME, START_TIME);
    await run(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function partBase(id: string) {
  return { id, sessionID: SESSION_ID, messageID: MESSAGE_ID };
}

/** 按写库顺序保存 part：未带 blockIndex 时模拟升级前写入的旧消息。 */
async function saveParts(db: DatabaseSync, parts: readonly Record<string, unknown>[]) {
  await saveMessage(db, {
    id: MESSAGE_ID,
    sessionID: SESSION_ID,
    role: "assistant",
    time: { created: START_TIME, completed: START_TIME + 1 },
    parentID: "message_user",
    mode: "build",
    agent: "zcode-agent",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  } as never);
  for (const part of parts) await savePart(db, part as never);
}

function ids(parts: readonly { id: string }[]): string[] {
  return parts.map((part) => part.id);
}

test("乱序到达：读边界按 blockIndex 还原到达顺序（messages 与 messageWithParts）", async () => {
  await withSessionDatabase(async (db) => {
    // 到达顺序：reasoning 0、text 1、只读工具 Read 2、text 3、text 5。
    // 写库顺序：只读工具在流中写库，reasoning / text 在流结束后写库 ⇒ 物理顺序与到达顺序不同。
    await saveParts(db, [
      { ...partBase("part_step_start"), type: "step-start" },
      {
        ...partBase("part_tool"),
        type: "tool",
        callID: "call_read",
        tool: "read",
        blockIndex: 2,
        state: { status: "pending", input: {}, raw: "" },
      },
      {
        ...partBase("part_reasoning"),
        type: "reasoning",
        text: "think",
        blockIndex: 0,
        time: { start: START_TIME },
      },
      { ...partBase("part_text_1"), type: "text", text: "Let me check.", blockIndex: 1 },
      { ...partBase("part_text_3"), type: "text", text: "Now edit.", blockIndex: 3 },
      { ...partBase("part_text_5"), type: "text", text: "Done.", blockIndex: 5 },
    ]);

    const [message] = await messages(db, { sessionID: SESSION_ID as never });
    assert.ok(message);
    // 非块 part（step-start）位置不变，块 part 之间按 blockIndex 重排。
    assert.deepEqual(ids(message.parts), [
      "part_step_start",
      "part_reasoning",
      "part_text_1",
      "part_tool",
      "part_text_3",
      "part_text_5",
    ]);

    const single = await messageWithParts(db, {
      sessionID: SESSION_ID as never,
      messageID: MESSAGE_ID as never,
    });
    assert.deepEqual(ids(single!.parts), ids(message.parts));
  });
});

test("旧消息回归护栏：没有 blockIndex 时读边界保持物理顺序", async () => {
  await withSessionDatabase(async (db) => {
    await saveParts(db, [
      { ...partBase("part_text_a"), type: "text", text: "A" },
      { ...partBase("part_text_b"), type: "text", text: "B" },
      {
        ...partBase("part_reasoning"),
        type: "reasoning",
        text: "think",
        time: { start: START_TIME },
      },
      {
        ...partBase("part_tool"),
        type: "tool",
        callID: "call_read",
        tool: "read",
        state: { status: "pending", input: {}, raw: "" },
      },
    ]);

    const [message] = await messages(db, { sessionID: SESSION_ID as never });
    assert.ok(message);
    assert.deepEqual(ids(message.parts), [
      "part_text_a",
      "part_text_b",
      "part_reasoning",
      "part_tool",
    ]);
  });
});
test("请求投影：有序条目按 blockIndex 排列内容块与工具调用，序号不进入请求", () => {
  const messages: ModelInputMessage[] = [
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "先想", blockIndex: 0 },
        { type: "text", text: "Let me check.", blockIndex: 1 },
        { type: "text", text: "Now edit.", blockIndex: 3 },
      ],
      toolCalls: [{ id: "call_read", name: "read", input: {}, blockIndex: 2 }],
    },
  ];

  const [projected] = toAiSdkMessages(messages, {});
  assert.ok(projected && projected.role === "assistant");
  assert.deepEqual(
    projected.content.map((part) => part.type),
    ["reasoning", "text", "tool-call", "text"],
  );
  // blockIndex 只用于排序，不能进入 provider 请求体。
  assert.equal(JSON.stringify(projected).includes("blockIndex"), false);

  // 旧条目（没有序号）：维持旧的 [内容块..., 工具调用...] 拼接。
  const [legacy] = toAiSdkMessages(
    [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "先想" },
          { type: "text", text: "Let me check.Now edit." },
        ],
        toolCalls: [{ id: "call_read", name: "read", input: {} }],
      },
    ],
    {},
  );
  assert.ok(legacy && legacy.role === "assistant");
  assert.deepEqual(
    legacy.content.map((part) => part.type),
    ["reasoning", "text", "tool-call"],
  );
});
