import assert from "node:assert/strict";
import test from "node:test";
import { createMessageId, createSessionId, type MessageWithParts } from "@zcode/contracts";
import {
  countActorTranscript,
  seedActorTranscript,
} from "../src/app/workflow-actor-transcript.js";
import {
  createActorTranscriptStoreDouble,
  createFakeLogger,
  textPart,
  userMessage,
  type ActorTranscriptStoreDouble,
} from "./support/actorTranscriptStoreDouble.js";

/**
 * 转录种子门（`holdsOnlySeedMessages`）的判据测试。
 *
 * 缺陷背景（.reverse/98-ce4/PROTOCOL-V4-LANDING.md §④.7，已用 HEAD 真实代码实测复现）：
 * `inFlight.messageBoundary` 取自前驱会话此刻的消息条数，是导入缓存里**唯一一个不是 journal
 * 事实**的数。它在两次构建之间变大时，修订 run 的一次普通「停止 → resume」就会带着更大的 M
 * 再次调进 `seedActorTranscript`；若目标会话此时已有**自己的** live 消息、但总数仍 < M，
 * 老规则会去重抄 0..M-1 —— 前 N 条是对既有种子 id 的 upsert（无害），而 N..M-1 是**新 id**，
 * 于是前驱的消息被追加到本会话自己的历史**之后**。
 *
 * 机制在 `packages/adapters/src/storage/session-store/repositories/messages.ts:77`：
 *   insert 时 sequence = (select coalesce(max(sequence), -1) + 1 from message where session_id = ?)
 * 所以种子拿到的是**比既有历史更大的** sequence；`messages()` 按
 * `order by sequence is null, sequence, time_created, rowid`（:230）返回 ⇒ 模型看到的
 * 上下文**前后颠倒**，且**全程无异常、无日志**。这就是「静默的上下文错乱」。
 *
 * 为什么必须单测而不是只靠端到端：三个错误方向（跳过条件写反 ⇒ 正常续跑不再复制、
 * 门只看条数 ⇒ 装了别的内容也照抄、跳过不留日志 ⇒ 回归时无迹可寻）**都不报错**，
 * 只在真实使用里表现为「子代理读到一段不属于它的、颠倒的上文」。
 *
 * 运行：cd apps/zcode-cli/packages/bootstrap && node --import tsx \
 *   --import ../../../../packages/services/test/support/zcodeSourceResolver.mjs \
 *   --test test/workflowActorTranscriptSeedGate.test.ts
 */

const TARGET = createSessionId("actor-target");
const SOURCE = createSessionId("actor-source");
/** 前驱边界：种子要抄 3 条。 */
const SEED_COUNT = 3;

/** 种子副本的 id 口径，与实现里的 {@link seededMessageId} 同源（createMessageId 会加 msg_ 前缀）。 */
function seedMessageId(index: number): string {
  return String(createMessageId(`${TARGET}-seed-${index}`));
}

/** 源会话的 3 条消息（2 条 user + 1 条 assistant，assistant 的 parentID 指向第 0 条）。 */
function buildSourceMessages() {
  return [
    {
      info: userMessage({ id: "msg_src-0", sessionID: SOURCE, created: 1_000 }),
      parts: [textPart({ id: "part_src-0", sessionID: SOURCE, messageID: "msg_src-0", text: "u0" })],
    },
    {
      info: userMessage({ id: "msg_src-1", sessionID: SOURCE, created: 1_001 }),
      parts: [textPart({ id: "part_src-1", sessionID: SOURCE, messageID: "msg_src-1", text: "u1" })],
    },
    {
      info: userMessage({ id: "msg_src-2", sessionID: SOURCE, created: 1_002 }),
      parts: [textPart({ id: "part_src-2", sessionID: SOURCE, messageID: "msg_src-2", text: "u2" })],
    },
  ];
}

/**
 * 建一个 store：源会话装好 3 条，目标会话按场景预置既有内容。
 *
 * @param targetExisting 目标会话「此刻已经落库」的消息。空数组 = 全新会话（场景 C）。
 */
function createStore(targetExisting: readonly ReturnType<typeof userMessage>[]) {
  const store = createActorTranscriptStoreDouble();
  const source = buildSourceMessages();
  return (async () => {
    for (const message of source) {
      await store.saveMessage(message.info);
      for (const part of message.parts) await store.savePart(part);
    }
    // 目标会话的既有内容（可能含种子 id，也可能是它自己的历史）。
    for (const info of targetExisting) store.seedOwnMessage(info);
    return store;
  })();
}

/** 场景 A：目标会话已经有**自己的** 1 条消息（id 不是种子 id），且 1 < 3。 */
function ownHistory(): ReturnType<typeof userMessage>[] {
  return [userMessage({ id: "msg_own-0", sessionID: TARGET, created: 2_000 })];
}

/** 场景 B：目标会话只有种子前缀的第 0 条（复制到一半崩溃后 resume）。 */
function halfCopiedPrefix(): ReturnType<typeof userMessage>[] {
  return [userMessage({ id: seedMessageId(0), sessionID: TARGET, created: 2_000 })];
}

/** 场景 C：目标会话为空。 */
function emptySession(): ReturnType<typeof userMessage>[] {
  return [];
}

async function runScenario(
  store: ActorTranscriptStoreDouble,
  logger?: ReturnType<typeof createFakeLogger>["logger"],
) {
  const before = await store.messages({ sessionID: TARGET });
  // 计数器里已经含**建 store 时**写源会话的那几次，所以只取本次场景的增量：
  // 「写了几条」必须从调用点算起，否则判据 1 会被自己的夹具污染成恒真。
  const messagesBefore = store.saveMessageCalls.length;
  const partsBefore = store.savePartCalls.length;
  const returned = await seedActorTranscript({
    ...(logger === undefined ? {} : { logger }),
    seed: { sourceSessionId: String(SOURCE), messageCount: SEED_COUNT },
    store,
    targetSessionId: TARGET,
  });
  const after = await store.messages({ sessionID: TARGET });
  return {
    before,
    returned,
    after,
    written: store.saveMessageCalls.length - messagesBefore,
    partsWritten: store.savePartCalls.length - partsBefore,
  };
}

/**
 * 判据 2：顺序不变式（**不依赖实现**，只依赖 store 的真实排序语义）。
 *
 * 「前驱消息被追加到本会话历史之后」这个现象的直接表述是：**任何一条种子消息都不允许
 * 出现在某条非种子消息之后**；且只要种子在场，第 i 条种子就必须落在下标 i。
 * 这条判据同时覆盖「upsert 到正确位置」与「没有多出条目」两种错法。
 */
function assertSeedOrderInvariant(
  messages: readonly MessageWithParts[],
  scenario: string,
): void {
  const seedIds = new Set(
    Array.from({ length: SEED_COUNT }, (_, index) => seedMessageId(index)),
  );
  let seenNonSeed = false;
  messages.forEach((message, index) => {
    const id = String(message.info.id);
    if (!seedIds.has(id)) {
      seenNonSeed = true;
      return;
    }
    assert.equal(
      seenNonSeed,
      false,
      `[${scenario}] 种子消息 ${id} 落在既有历史之后（下标 ${index}）—— ` +
        "这正是「前驱消息被追加到本会话自己的历史之后」，模型看到的上文前后颠倒",
    );
    assert.equal(
      id,
      seedMessageId(index),
      `[${scenario}] 种子前缀必须落在下标 ${index}`,
    );
  });
}

// ————————————————————————————————————————————————————————————————
// 判据 1（复制点，最强）
// ————————————————————————————————————————————————————————————————

test("判据1：目标已有自己的消息且条数 < messageCount ⇒ 返回 undefined 且一条都不写", async () => {
  const store = await createStore(ownHistory());
  const { returned, written, partsWritten } = await runScenario(store);

  assert.equal(
    returned,
    undefined,
    "目标会话有自己的历史时，seedActorTranscript 必须跳过（返回 undefined）",
  );
  assert.equal(
    written,
    0,
    "跳过的场景下 store.saveMessage 的调用次数必须为 0（写 3 条 = 静默上下文错乱）",
  );
  assert.equal(partsWritten, 0, "跳过的场景下不得写任何 part");
});

test("判据1 对照：只含种子前缀 / 空会话 ⇒ 照旧复制 3 条（回归）", async () => {
  const half = await createStore(halfCopiedPrefix());
  const halfResult = await runScenario(half);
  assert.equal(halfResult.returned, 3, "只含种子前缀的会话是「复制到一半」，必须照旧补齐");
  assert.equal(halfResult.written, 3);

  const fresh = await createStore(emptySession());
  const freshResult = await runScenario(fresh);
  assert.equal(freshResult.returned, 3, "空会话必须照旧复制");
  assert.equal(freshResult.written, 3);
});

// ————————————————————————————————————————————————————————————————
// 判据 2（顺序不变式）
// ————————————————————————————————————————————————————————————————

test("判据2：种子前缀必须占据前 messageCount 个下标，绝不追加到既有历史之后", async () => {
  const store = await createStore(ownHistory());
  const { after } = await runScenario(store);

  // 目标会话自己的那条历史必须**原样**留在下标 0，且没有被种子挤到后面。
  assert.equal(String(after[0]!.info.id), "msg_own-0", "既有历史必须仍在最前");
  assertSeedOrderInvariant(after, "A：已有自己的消息");
});

test("判据2 对照：半截前缀补齐后 seed i 恰好落在下标 i（回归）", async () => {
  const store = await createStore(halfCopiedPrefix());
  const { after } = await runScenario(store);

  assert.equal(after.length, 3, "补齐后恰好 messageCount 条，不得多出条目");
  after.forEach((message, index) => {
    assert.equal(String(message.info.id), seedMessageId(index), `下标 ${index} 必须是第 ${index} 条种子`);
  });
  assertSeedOrderInvariant(after, "B：半截前缀");

  const fresh = await createStore(emptySession());
  const freshAfter = (await runScenario(fresh)).after;
  assert.equal(freshAfter.length, 3);
  assertSeedOrderInvariant(freshAfter, "C：空会话");
});

// ————————————————————————————————————————————————————————————————
// 判据 3（日志可观测）
// ————————————————————————————————————————————————————————————————

test("判据3：跳过必须留一条 warn，带 event / existingMessageCount / messageCount / sessionId", async () => {
  const store = await createStore(ownHistory());
  const { logger, warns } = createFakeLogger();
  await runScenario(store, logger);

  assert.equal(warns.length, 1, "「悄无声息」是这条缺陷的一半，跳过必须恰好留一条 warn");
  const warn = warns[0]!;
  assert.equal(
    warn.context?.event,
    "dynamic_workflow.actor.seed_skipped_live_session",
    "warn 必须带稳定的 event 名，供日志检索与告警",
  );
  assert.equal(warn.context?.existingMessageCount, 1);
  assert.equal(warn.context?.messageCount, SEED_COUNT);
  assert.equal(warn.context?.sessionId, TARGET);
});

test("判据3 对照：正常复制路径不得产生 warn（回归）", async () => {
  for (const [scenario, existing] of [
    ["B：半截前缀", halfCopiedPrefix()],
    ["C：空会话", emptySession()],
  ] as const) {
    const store = await createStore(existing);
    const { logger, warns } = createFakeLogger();
    await runScenario(store, logger);
    assert.equal(warns.length, 0, `[${scenario}] 正常复制不该留 warn`);
  }
});

test("回归：不传 logger 时跳过路径不得抛错（logger 是可选的）", async () => {
  const store = await createStore(ownHistory());
  const { returned } = await runScenario(store);
  assert.equal(returned, undefined);
});

test("回归：countActorTranscript 的口径不受这道门影响", async () => {
  const store = await createStore(ownHistory());
  assert.equal(await countActorTranscript(store, TARGET), 1);
});
