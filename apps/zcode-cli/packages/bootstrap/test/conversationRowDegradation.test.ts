import assert from "node:assert/strict";
import test from "node:test";
import {
  TopicWireFrameAssembler,
  V4_WIRE_PROTOCOL_VERSION,
  WIRE_FAULT_INVALID_PAYLOAD,
  conversationTopicFrameSchema,
  isDeterministicContentFault,
  v4ConversationRowsRangeResultSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { createInitialConversationSnapshot } from "../src/zcode-protocol-v4/projection-state.js";

/**
 * snapshot 的 B 区逐行降级（上游 v3.18.0 同源，事故 sess_4142de31 / 2026-09-21）。
 *
 * 修复前：rows.window 是 z.array(conversationRowSchema)，一行读不懂则整帧被拒
 * （proto.frameAssemblyInvalidPayload）→ 确定性内容失败 → 强制 snapshot → 同一份内容再被拒
 * → fault.subscription.contentRejected，会话永久打不开。
 *
 * 钉四件事：
 * 1. 一行坏数据不影响其余行，且坏行以 unreadable 占位行保留 rowId 与原因；
 * 2. rows/range（历史回补）是同一个降级档位，不能只修打开会话；
 * 3. deltas 仍严格——丢一条行变更会让投影与权威发散；
 * 4. 连 RowBase 都读不懂时继续拒帧（fail closed），A 区也仍严格。
 */

const SESSION_ID = "row-degradation";

const VALID_USER_ROW = {
  rowId: 1,
  turnId: "turn-1",
  createdAt: 1_700_000_000_000,
  createdAtSeq: 1,
  kind: "userInput",
  origin: "realUser",
  text: "keep me",
};

function baseSnapshot(): Record<string, unknown> {
  const snapshot = createInitialConversationSnapshot(SESSION_ID, "epoch") as unknown as {
    rows: { window: Array<Record<string, unknown>>; totalCount: number; firstRowId: number | null };
  };
  snapshot.rows.window.push(VALID_USER_ROW);
  snapshot.rows.totalCount = 1;
  snapshot.rows.firstRowId = 1;
  return snapshot as unknown as Record<string, unknown>;
}

function rowsOf(snapshot: Record<string, unknown>) {
  return (snapshot as { rows: { window: Array<Record<string, unknown>> } }).rows;
}

function frameWith(snapshot: Record<string, unknown>) {
  return {
    topic: `conversation/${SESSION_ID}`,
    subscriptionId: "sub-1",
    fromSeq: 0,
    toSeq: 1,
    sentAt: 0,
    payload: { kind: "snapshot", snapshot },
  };
}

/** 比本端新的发送端：一种本端没有的行类型。这是最可能的偏斜源。 */
const UNKNOWN_KIND_ROW = {
  rowId: 9001,
  turnId: "turn-future",
  createdAt: 1_700_000_000_000,
  createdAtSeq: 9001,
  kind: "holographicPreview",
  payload: { anything: true },
};

/** 已知行类型，但必填字段缺席（闭集枚举加值、字段改名都会落到这一档）。 */
const SKEWED_TOOL_CALL_ROW = {
  rowId: 9002,
  turnId: "turn-future",
  createdAt: 1_700_000_000_001,
  createdAtSeq: 9002,
  kind: "toolCall",
  toolCallId: "future-call",
};

test("未知行类型只让那一行退化，整帧照常交付", () => {
  const snapshot = baseSnapshot();
  rowsOf(snapshot).window.push(UNKNOWN_KIND_ROW);
  const parsed = conversationTopicFrameSchema.parse(frameWith(snapshot));
  assert.equal(parsed.payload.kind, "snapshot");
  if (parsed.payload.kind !== "snapshot") return;
  const rows = parsed.payload.snapshot.rows.window;
  assert.equal(rows.length, 2);
  // 身份与位置原样保留：降级改变的是能不能渲染，不是它是否存在、排在哪里。
  assert.deepEqual(rows.at(-1), {
    kind: "unreadable",
    rowId: 9001,
    turnId: "turn-future",
    createdAt: 1_700_000_000_000,
    createdAtSeq: 9001,
    sourceKind: "holographicPreview",
    reason: "unknownKind",
  });
  // 占位行不携带任何无法确认的事实（原始脏数据不进投影、更不进日志）。
  assert.equal("payload" in (rows.at(-1) as object), false);
});

test("已知行类型的必填字段偏斜同样只退化那一行，且区分原因", () => {
  const snapshot = baseSnapshot();
  rowsOf(snapshot).window.push(SKEWED_TOOL_CALL_ROW);
  const parsed = conversationTopicFrameSchema.parse(frameWith(snapshot));
  if (parsed.payload.kind !== "snapshot") throw new Error("Expected a snapshot payload");
  const degraded = parsed.payload.snapshot.rows.window.at(-1);
  assert.equal(degraded?.kind, "unreadable");
  assert.equal(degraded?.rowId, 9002);
  // sourceKind 保留原自报类型，诊断时才分得清「未知类型」与「已知类型但字段偏斜」。
  assert.equal(degraded !== undefined && "sourceKind" in degraded ? degraded.sourceKind : null, "toolCall");
  assert.equal(degraded !== undefined && "reason" in degraded ? degraded.reason : null, "invalidRow");
});

test("合法行不受影响，计数与游标事实不变", () => {
  const clean = baseSnapshot();
  const skewed = baseSnapshot();
  rowsOf(skewed).window.push(UNKNOWN_KIND_ROW);
  const parsedClean = conversationTopicFrameSchema.parse(frameWith(clean));
  const parsedSkewed = conversationTopicFrameSchema.parse(frameWith(skewed));
  if (parsedClean.payload.kind !== "snapshot" || parsedSkewed.payload.kind !== "snapshot") {
    throw new Error("Expected snapshot payloads");
  }
  // union 的顺序是语义的一部分：严格成员在前，合法行不能被当成占位行。
  assert.deepEqual(parsedSkewed.payload.snapshot.rows.window.slice(0, -1), parsedClean.payload.snapshot.rows.window);
  assert.equal(parsedSkewed.payload.snapshot.rows.totalCount, rowsOf(skewed).totalCount);
  assert.equal(parsedSkewed.payload.snapshot.rows.firstRowId, rowsOf(skewed).firstRowId);
});

test("rows/range 历史回补是同一降级档位，合法行与记账字段不受影响", () => {
  const parsed = v4ConversationRowsRangeResultSchema.parse({
    rows: [VALID_USER_ROW, UNKNOWN_KIND_ROW],
    atSeq: 1,
    atRevision: 3,
    atLogEpoch: "epoch",
    hasMore: false,
  });
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0]?.kind, "userInput");
  assert.equal(parsed.rows[1]?.kind, "unreadable");
  assert.equal(
    parsed.rows[1] !== undefined && "sourceKind" in parsed.rows[1] ? parsed.rows[1].sourceKind : null,
    "holographicPreview",
  );
  // 降级只改一行能否渲染，不碰水位/游标事实。
  assert.equal(parsed.atSeq, 1);
  assert.equal(parsed.atRevision, 3);
  assert.equal(parsed.hasMore, false);
});

test("连 RowBase 的四个字段都读不懂时仍然拒帧", () => {
  const snapshot = baseSnapshot();
  // 没有 rowId 就无法确定身份与排序，降级会把「少一行」变成「错位的一屏」，必须 fail closed。
  rowsOf(snapshot).window.push({ turnId: "turn-future", kind: "holographicPreview" });
  assert.throws(() => conversationTopicFrameSchema.parse(frameWith(snapshot)));
});

test("A 区仍严格：会话级字段偏斜照样拒帧", () => {
  const snapshot = baseSnapshot();
  (snapshot as { control: { phase: string } }).control.phase = "paused-by-future-cli";
  assert.throws(() => conversationTopicFrameSchema.parse(frameWith(snapshot)));
});

/** 生产路径上的最后一层：帧组装器决定整帧生死（schema 拒收在这里变成 fault）。 */
function completeWireFrame(snapshot: Record<string, unknown>) {
  return {
    wireVersion: V4_WIRE_PROTOCOL_VERSION,
    kind: "complete",
    deliveryKind: "online",
    logicalFrameId: "f1",
    logicalFrameOrdinal: 1,
    topic: `conversation/${SESSION_ID}`,
    subscriptionId: "sub-1",
    frame: frameWith(snapshot),
  };
}

function assembleOnce(snapshot: Record<string, unknown>) {
  const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema);
  return assembler.accept(completeWireFrame(snapshot) as never);
}

test("最终消费点：含坏行的 snapshot 帧产出 complete 而不是 fault", () => {
  // 这一层才是「会话打不开」的现场：schema 拒收在这里变成 fault，客户端据此进恢复阶梯。
  const snapshot = baseSnapshot();
  rowsOf(snapshot).window.push(UNKNOWN_KIND_ROW);
  const events = assembleOnce(snapshot);
  assert.equal(
    events.filter((event) => event.kind === "fault").length,
    0,
    "一行读不懂不得把整帧打成 fault（那会让恢复阶梯永远撞同一份字节）",
  );
  const completes = events.filter((event) => event.kind === "complete");
  assert.equal(completes.length, 1);
  const delivered = completes[0]!.kind === "complete" ? completes[0]!.frame : undefined;
  const rows = delivered?.payload.kind === "snapshot" ? delivered.payload.snapshot.rows.window : [];
  assert.equal(rows.length, 2, "其余行必须活到消费点");
  assert.equal(rows[0]?.kind, "userInput");
  assert.equal(rows[1]?.kind, "unreadable");
  // 对照：同一条链路上 A 区坏了仍然是确定性内容失败（降级没有把整帧放宽）。
  const brokenA = baseSnapshot();
  (brokenA as { control: { phase: string } }).control.phase = "paused-by-future-cli";
  const brokenEvents = assembleOnce(brokenA);
  assert.deepEqual(
    brokenEvents
      .filter((event) => event.kind === "fault")
      .map((event) => (event.kind === "fault" ? event.fault.reasonCode : undefined)),
    [WIRE_FAULT_INVALID_PAYLOAD],
  );
  assert.equal(brokenEvents.filter((event) => event.kind === "complete").length, 0);
  // 这个 reasonCode 的分类决定了客户端会不会再发一次同样的字节（确定性 ⇒ 不重试，只报错）。
  assert.equal(isDeterministicContentFault(WIRE_FAULT_INVALID_PAYLOAD), true);
});

test("deltas 不走降级：丢一条行变更会让投影与权威发散", () => {
  assert.throws(() =>
    conversationTopicFrameSchema.parse({
      topic: `conversation/${SESSION_ID}`,
      subscriptionId: "sub-1",
      fromSeq: 0,
      toSeq: 1,
      sentAt: 0,
      payload: { kind: "deltas", deltas: [{ op: "row.appended", row: UNKNOWN_KIND_ROW }] },
    }),
  );
});