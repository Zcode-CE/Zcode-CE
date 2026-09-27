import assert from "node:assert/strict";
import test from "node:test";
import {
  TopicWireFrameAssembler,
  V4_WIRE_PROTOCOL_VERSION,
  WIRE_FAULT_INVALID_PAYLOAD,
  conversationTopicFrameSchema,
  permissionRequestPayloadSchema,
  toolCallRowSchema,
  toolOutputSchema,
  workflowLaunchMetaSchema,
  workflowSettingsAmendMetaSchema,
} from "@zcode/shared/zcode-protocol-v4";

/**
 * 装饰性载荷（display / amend）的降级而非拒收契约测试。
 *
 * 为什么单独锁这一层：display 与 amend 都是装饰载荷——它们决定的是「这张卡怎么画」，
 * 不是「这一轮发生了什么」。本端读不懂一个装饰载荷时，正确的降级是只丢这个载荷；
 * 一旦它升级成 schema 拒收，代价是整帧被丢：row 没了、订阅进恢复阶梯，
 * 而对端重投的是同一批字节 ⇒ 同一条内容反复失败（v4ContentRejected.test.ts 锁的就是那个终态）。
 *
 * 三条口径（每条都在下面有断言，且每条都配一个对照证明判据有牙齿）：
 *   · 未知 kind 的 display ⇒ 解析成功且该字段为 undefined（降级），其余字段一个不少；
 *   · 同一份字节喂给帧组装器（生产路径上真正决定「整帧生死」的那一层）⇒ 产出 complete
 *     而不是 fault —— 这才是最终消费点，停在上面的 schema.safeParse 只能证明一半；
 *   · 降级只覆盖装饰载荷：同一行的非装饰字段（status / summary / runId / 取值域）照旧硬拒。
 *
 * M3 补充：`predecessorRunId` 可选化对应上游「就地 retune」的字节（只改并发上限、run 在飞时
 * 不另起 run ⇒ 没有前驱可指），但 `.min(1)` 仍然在位（空串照旧被拒）。
 *
 * 运行：cd packages/shared && node --import tsx --test test/protocolV4DisplayTolerance.test.ts
 */

const TOPIC = "conversation/s-1";
const SUBSCRIPTION_ID = "sub-1";
/** 本端读不懂的 display kind —— 跨版本时对端新加的那一个。 */
const FUTURE_DISPLAY = { kind: "future_kind" } as const;

/** 一帧 complete wire candidate（外层字段全合法，只有内层 row 值得怀疑）。 */
function completeFrame(rows: readonly unknown[]) {
  return {
    wireVersion: V4_WIRE_PROTOCOL_VERSION,
    kind: "complete",
    deliveryKind: "online",
    logicalFrameId: "f1",
    logicalFrameOrdinal: 1,
    topic: TOPIC,
    subscriptionId: SUBSCRIPTION_ID,
    frame: {
      topic: TOPIC,
      subscriptionId: SUBSCRIPTION_ID,
      fromSeq: 0,
      toSeq: 1,
      sentAt: 1,
      payload: {
        kind: "deltas",
        deltas: rows.map((row) => ({ op: "row.appended", row })),
      },
    },
  };
}

/** 走生产路径的那一层：帧组装器（schema 拒收在这里变成 fault，整帧在这里被判生死）。 */
function assembleOnce(rows: readonly unknown[]) {
  const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema);
  return assembler.accept(completeFrame(rows) as never);
}

/** 一条最小合法 toolCall row；`display` 由调用方给。 */
function toolCallRow(display: unknown) {
  return {
    kind: "toolCall",
    rowId: 1,
    turnId: "t1",
    createdAt: 1,
    createdAtSeq: 1,
    toolCallId: "c1",
    toolName: "Bash",
    status: "success",
    inputText: "{}",
    display,
  };
}

test("① 事实：toolOutputSchema 对未知 display kind 降级为 undefined，不拒整条 output", () => {
  const parsed = toolOutputSchema.safeParse({ text: "hi", display: FUTURE_DISPLAY });
  assert.equal(parsed.success, true, "未知 display kind 不得让整条 output 失败");
  assert.equal(parsed.success && parsed.data.display, undefined, "降级 = 该字段缺席");
  assert.equal(parsed.success && parsed.data.text, "hi", "其余字段一个不少");
  // 对照一：已知 kind 照旧原样保留（证明上面不是「display 一律被吞」）。
  const known = toolOutputSchema.safeParse({
    text: "hi",
    display: { kind: "local_agent_message", status: "success" },
  });
  assert.equal(known.success && known.data.display?.kind, "local_agent_message");
  // 对照二：降级只覆盖 display —— 同一个对象的必填字段照旧硬拒。
  assert.equal(toolOutputSchema.safeParse({ display: FUTURE_DISPLAY }).success, false);
});

test("② 事实：toolCallRowSchema 对未知 display kind 降级，行本身与 toolCallId 全须全尾", () => {
  const parsed = toolCallRowSchema.safeParse(toolCallRow(FUTURE_DISPLAY));
  assert.equal(parsed.success, true, "未知 display kind 不得让整条 row 失败");
  assert.equal(parsed.success && parsed.data.display, undefined);
  assert.equal(parsed.success && parsed.data.toolCallId, "c1", "行的身份字段必须还在");
  // 对照：同一行的非装饰字段照旧硬拒（status 不在闭集里）。
  assert.equal(
    toolCallRowSchema.safeParse({ ...toolCallRow(FUTURE_DISPLAY), status: "futureStatus" }).success,
    false,
  );
});

test("③ 事实：权限请求的 display 预览解析失败退化成纯文本 ask，不拒整份载荷", () => {
  const payload = {
    kind: "permission",
    toolCallId: "c1",
    toolName: "Bash",
    summary: "run rm -rf?",
    detail: null,
    display: FUTURE_DISPLAY,
    options: [],
  };
  const parsed = permissionRequestPayloadSchema.safeParse(payload);
  assert.equal(parsed.success, true);
  assert.equal(parsed.success && parsed.data.display, undefined);
  assert.equal(
    parsed.success && parsed.data.summary,
    "run rm -rf?",
    "授权文案必须还在（用户据此决策）",
  );
  // 对照：缺 summary 照旧被拒（降级没有把这份载荷整体放宽）。
  assert.equal(
    permissionRequestPayloadSchema.safeParse({ ...payload, summary: undefined }).success,
    false,
  );
});

test("④ 事实：workflowLaunch 的 create_workflow 图解析失败只丢这张图，不拒这条元数据", () => {
  const meta = { runId: "r1", toolCallId: "launch-1", display: FUTURE_DISPLAY };
  const parsed = workflowLaunchMetaSchema.safeParse(meta);
  assert.equal(parsed.success, true);
  assert.equal(parsed.success && parsed.data.display, undefined);
  assert.equal(parsed.success && parsed.data.runId, "r1");
  // 对照：runId 是身份字段，照旧必填。
  assert.equal(workflowLaunchMetaSchema.safeParse({ toolCallId: "launch-1" }).success, false);
});

test("⑤ 最终消费点：含未知 display kind 的整帧产出 complete（不是 fault），行与帧都活着", () => {
  const events = assembleOnce([toolCallRow(FUTURE_DISPLAY)]);
  const faults = events.filter((event) => event.kind === "fault");
  const completes = events.filter((event) => event.kind === "complete");
  assert.equal(faults.length, 0, "装饰载荷不得把整帧打成 fault（那会让订阅进恢复阶梯）");
  assert.equal(completes.length, 1);
  const frame = completes[0]!.kind === "complete" ? completes[0]!.frame : undefined;
  const deltas = frame?.payload.kind === "deltas" ? frame.payload.deltas : undefined;
  assert.equal(deltas?.length, 1, "row 必须活到消费点");
  const row = deltas?.[0]?.op === "row.appended" ? deltas[0].row : undefined;
  assert.equal(row?.kind, "toolCall");
  assert.equal(row?.kind === "toolCall" && row.toolCallId, "c1");
  assert.equal(row?.kind === "toolCall" && row.display, undefined, "降级只丢 display");
  // 对照：同一帧里换成非装饰字段非法 ⇒ 必须是 fault（证明上面那条不是在「任何字节都放行」）。
  const control = assembleOnce([{ ...toolCallRow(FUTURE_DISPLAY), status: "futureStatus" }]);
  assert.deepEqual(
    control
      .filter((event) => event.kind === "fault")
      .map((event) => (event.kind === "fault" ? event.fault.reasonCode : undefined)),
    [WIRE_FAULT_INVALID_PAYLOAD],
  );
  assert.equal(control.filter((event) => event.kind === "complete").length, 0);
});

test("⑥ M3 事实：就地 retune 的 amend 块没有 predecessorRunId 也合法", () => {
  const parsed = workflowSettingsAmendMetaSchema.safeParse({
    maxConcurrency: { from: 13, to: 4 },
    ceiling: 4,
  });
  assert.equal(parsed.success, true, "「就地生效」的字节不得被拒 —— 拒了就是整条设置轮消失");
  assert.equal(parsed.success && parsed.data.predecessorRunId, undefined);
  assert.equal(parsed.success && parsed.data.ceiling, 4);
  // 对照一：在场时照旧解析得出（可选 ≠ 被忽略）。
  const withPredecessor = workflowSettingsAmendMetaSchema.safeParse({
    predecessorRunId: "run-1",
    ceiling: 4,
  });
  assert.equal(withPredecessor.success && withPredecessor.data.predecessorRunId, "run-1");
  // 对照二：只放宽了「在不在」，没有放宽「是什么」——空串与非法取值照旧硬拒。
  assert.equal(workflowSettingsAmendMetaSchema.safeParse({ predecessorRunId: "" }).success, false);
  assert.equal(workflowSettingsAmendMetaSchema.safeParse({ ceiling: 0 }).success, false);
});

test("⑦ 最终消费点：就地 retune 的设置轮（无 predecessorRunId）整帧产出 complete", () => {
  const settingsTurn = {
    kind: "userInput",
    rowId: 2,
    turnId: "t1",
    createdAt: 2,
    createdAtSeq: 2,
    text: "[settings] 并发上限 13 → 4",
    origin: "workflowLaunch",
    workflowLaunch: {
      runId: "r1",
      toolCallId: "settings-1",
      amend: { maxConcurrency: { from: 13, to: 4 }, ceiling: 4 },
    },
  };
  const events = assembleOnce([settingsTurn]);
  assert.equal(
    events.filter((event) => event.kind === "fault").length,
    0,
    "就地 retune 的字节必须过得了帧",
  );
  const completes = events.filter((event) => event.kind === "complete");
  assert.equal(completes.length, 1);
  const frame = completes[0]!.kind === "complete" ? completes[0]!.frame : undefined;
  const deltas = frame?.payload.kind === "deltas" ? frame.payload.deltas : undefined;
  const row = deltas?.[0]?.op === "row.appended" ? deltas[0].row : undefined;
  assert.equal(row?.kind === "userInput" && row.workflowLaunch?.runId, "r1");
  assert.equal(row?.kind === "userInput" && row.workflowLaunch?.amend?.ceiling, 4);
  assert.equal(row?.kind === "userInput" && row.workflowLaunch?.amend?.predecessorRunId, undefined);
  // 对照：设置轮的 runId 是联接键，照旧必填。
  const broken = assembleOnce([
    { ...settingsTurn, workflowLaunch: { toolCallId: "settings-1", amend: { ceiling: 4 } } },
  ]);
  assert.deepEqual(
    broken
      .filter((event) => event.kind === "fault")
      .map((event) => (event.kind === "fault" ? event.fault.reasonCode : undefined)),
    [WIRE_FAULT_INVALID_PAYLOAD],
  );
});
