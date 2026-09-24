import assert from "node:assert/strict";
import test from "node:test";
import {
  SUBSCRIPTION_CONTENT_REJECTED,
  TopicWireFrameAssembler,
  V4_WIRE_PROTOCOL_VERSION,
  WIRE_FAULT_INVALID_PAYLOAD,
  conversationTopicFrameSchema,
  isDeterministicContentFault,
  sessionsIndexTopic,
  sessionsIndexTopicFrameSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { createTopicWireDecoder } from "../src/v4/topicWireDecoder.js";
import { ConversationProjectionStore } from "../src/v4/conversationProjectionStore.js";
import { SessionsIndexStore } from "../src/v4/sessionsIndexStore.js";

/**
 * 「schema 拒收 ⇒ 内容拒收（可诊断）而非瞬态故障」的端到端测试。
 *
 * 链路（中间每一环都是生产实现，没有替身）：
 *   wire candidate（complete 帧，载荷是本端读不懂的形状）
 *     → TopicWireFrameAssembler.accept  ← 生产实现，schema 在这里拒收
 *     → createTopicWireDecoder          ← 生产实现，fault 在这里上报
 *     → store 自己注册的 onAssemblyFault 监听 → handleAssemblyFault(reasonCode)
 *     → 恢复阶梯 / 终态
 * 只有链路两端的传输面是替身。
 *
 * 两个 store 各有各的最终消费点，两条都测：
 *   · ConversationProjectionStore：\`getState().lastError\`（UI 与遥测直接读它）；
 *   · SessionsIndexStore：\`getStatus()\` + 之后有没有再 subscribe
 *     （它的 fail-closed 会清空投影并排一次有界退避重订阅 —— 对确定性失败那就是一个
 *     永不收敛的重订阅循环）。
 *
 * 场景（每个 store 一世）：先喂一帧合法 initial snapshot（让水位有效，resume 档才可能被
 * 选中），再投两次同一份被拒的内容 —— 这正是上游注释说的形状：resume 只会把同一批
 * delta 再投一遍，必然再被拒。
 *
 * 运行：cd packages/ui && node --import tsx --test test/v4ContentRejected.test.ts
 */

const SUBSCRIPTION_ID = "sub-1";
const CONVERSATION_TOPIC = "conversation/s-1";
const SESSIONS_TOPIC = sessionsIndexTopic("ws-1");
/** 恢复 flight 的帧期限（毫秒）。测试里压缩成立即兑现来跨过它。 */
const FRAME_DEADLINE_MS = 30_000;
/** sessionsIndexStore 的退避重订阅延迟（ERROR_RECOVERY_RETRY_DELAYS_MS[0]）。 */
const ERROR_RECOVERY_RETRY_DELAY_MS = 5_000;

/**
 * 一次「schema 拒收」的物理帧：外层 candidate 字段全合法，内层 frame 载荷本端读不懂
 * （payload.kind 是对端新加的、本端 schema 不认识的形状）—— 跨版本时的实际形状：字节过了
 * length/checksum/UTF-8/JSON 四道关，卡在 schema 上。
 */
function rejectedCandidate(topic: string) {
  return {
    wireVersion: V4_WIRE_PROTOCOL_VERSION,
    kind: "complete" as const,
    deliveryKind: "online" as const,
    logicalFrameId: "f1",
    logicalFrameOrdinal: 1,
    topic,
    subscriptionId: SUBSCRIPTION_ID,
    frame: {
      topic,
      subscriptionId: SUBSCRIPTION_ID,
      fromSeq: 0,
      toSeq: 1,
      sentAt: 1,
      payload: { kind: "future-op-kind", rows: [] },
    },
  };
}

test("第 1 环（事实）：schema 拒收的 reasonCode 就是内容确定性失败那一个", () => {
  const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema);
  const events = assembler.accept(rejectedCandidate(CONVERSATION_TOPIC) as never);
  const faults = events.filter((e) => e.kind === "fault");
  assert.equal(faults.length, 1, "必须恰好产出一个 fault（且没有 complete）");
  const reasonCode = faults[0]!.kind === "fault" ? faults[0]!.fault.reasonCode : undefined;
  assert.equal(reasonCode, WIRE_FAULT_INVALID_PAYLOAD);
  assert.equal(isDeterministicContentFault(reasonCode), true);
  // 反向：瞬态那几个不得被误判成确定性（判据必须有牙齿）。
  assert.equal(isDeterministicContentFault("proto.frameAssemblyChecksumMismatch"), false);
  assert.equal(isDeterministicContentFault("proto.frameAssemblyInvalidJson"), false);
  assert.equal(isDeterministicContentFault(undefined), false);
});

test("第 2 环（事实）：decoder 把该 fault 原样交给订阅方，reasonCode 一路带着", () => {
  const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema);
  const seen: Array<{ reasonCode?: string }> = [];
  const decoder = createTopicWireDecoder(
    assembler,
    () => undefined,
    (fault) => seen.push({ reasonCode: fault.reasonCode }),
  );
  decoder.accept(rejectedCandidate(CONVERSATION_TOPIC) as never);
  assert.deepEqual(seen, [{ reasonCode: WIRE_FAULT_INVALID_PAYLOAD }]);
  decoder.clear();
});

/**
 * 第 3 环（实测上游那句「resume 只会把同一批 delta 再投一遍，必然同样被拒」）：
 * 每次都用全新的 assembler（= 一次重订阅之后的新组装器）喂同一份内容，
 * 拒收结论逐次相同 —— 所以瞬态阶梯的 resume 档在这里是纯浪费，这就是「跳过它」的依据。
 */
test("第 3 环（实测确定性）：同一份内容跨三次新订阅都得到同一个拒收结论", () => {
  const reasonCodes = [1, 2, 3].map(() => {
    const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema);
    const events = assembler.accept(rejectedCandidate(CONVERSATION_TOPIC) as never);
    return events
      .filter((e) => e.kind === "fault")
      .map((e) => (e.kind === "fault" ? e.fault.reasonCode : undefined));
  });
  assert.deepEqual(reasonCodes, [
    [WIRE_FAULT_INVALID_PAYLOAD],
    [WIRE_FAULT_INVALID_PAYLOAD],
    [WIRE_FAULT_INVALID_PAYLOAD],
  ]);
});

/** 把 resync / subscribe / unsubscribe 全记下来的 transport 替身（链路两端的传输面）。 */
function makeTransport() {
  const resyncs: Array<{ forceSnapshot: boolean }> = [];
  const faultListeners: Array<
    (fault: {
      topic: string;
      subscriptionId: string;
      reasonCode?: string;
      deliveryKind?: string;
    }) => void
  > = [];
  const frameListeners: Array<(frame: unknown, context?: { deliveryKind?: string }) => void> = [];
  let unsubscribes = 0;
  let subscribes = 0;
  const transport = {
    subscribe: async () => {
      subscribes += 1;
      return { ack: { subscriptionId: SUBSCRIPTION_ID, mode: "resume" as const, logEpoch: "e1" } };
    },
    activate: () => undefined,
    resync: async (params: { forceSnapshot?: boolean }) => {
      resyncs.push({ forceSnapshot: params.forceSnapshot === true });
      return { ack: { subscriptionId: SUBSCRIPTION_ID, mode: "snapshot" as const } };
    },
    unsubscribe: async () => {
      unsubscribes += 1;
    },
    onFrame: (listener: (frame: unknown, context?: { deliveryKind?: string }) => void) => {
      frameListeners.push(listener);
      return () => undefined;
    },
    onAssemblyFault: (listener: (fault: never) => void) => {
      faultListeners.push(listener as never);
      return () => undefined;
    },
    onRuntimeRestart: () => () => undefined,
  };
  return {
    transport,
    resyncs,
    /**
     * 喂一帧合法 snapshot，走 transport 的 onFrame（= sessionsIndexStore.connect 注册的
     * 那条路）。它的作用是让 `subscriptionHasAppliedBase` 为真 —— 否则恢复阶梯的第一档
     * 无论如何都会是 forceSnapshot，两条路径就分不开了。
     */
    deliverValidSnapshot(topic: string, frame: unknown, deliveryKind: string) {
      for (const listener of frameListeners) listener(frame, { deliveryKind });
      void topic;
    },
    /** 经 store 自己注册的 onAssemblyFault 监听投递一条 fault（生产路径）。 */
    emitFault(fault: {
      topic: string;
      subscriptionId: string;
      reasonCode?: string;
      deliveryKind?: string;
    }) {
      for (const listener of faultListeners) listener(fault as never);
    },
    get unsubscribes() {
      return unsubscribes;
    },
    get subscribes() {
      return subscribes;
    },
  };
}

/** 让 store 的 promise 续体跑完。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** 只压缩给定的那几个 timer 值，其余 setTimeout（含测试自己的等待）原样。 */
async function withCompressedTimers(
  values: readonly number[],
  run: () => Promise<void>,
): Promise<void> {
  const realSetTimeout = globalThis.setTimeout;
  const compress = new Set(values);
  (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((
    handler: () => void,
    ms?: number,
    ...rest: unknown[]
  ) =>
    realSetTimeout(
      handler,
      ms !== undefined && compress.has(ms) ? 0 : (ms ?? 0),
      ...rest,
    )) as typeof setTimeout;
  try {
    await run();
    await settle();
    await settle();
    await new Promise((resolve) => realSetTimeout(resolve, 20));
    await settle();
  } finally {
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = realSetTimeout;
  }
}

/**
 * 走一次「真实 assembler 拒收 → decoder → store 注册的监听」，返回投递函数，
 * 以便随后用同一个 reasonCode 重投第二次。
 */
function wireRejectedCandidate(
  topic: string,
  fake: ReturnType<typeof makeTransport>,
  frameSchema: never,
) {
  const assembler = new TopicWireFrameAssembler(frameSchema);
  const decoder = createTopicWireDecoder(
    assembler,
    () => undefined,
    (fault) => {
      fake.emitFault({
        topic: fault.topic,
        subscriptionId: fault.subscriptionId,
        ...(fault.reasonCode === undefined ? {} : { reasonCode: fault.reasonCode }),
        ...(fault.deliveryKind === undefined ? {} : { deliveryKind: fault.deliveryKind }),
      });
    },
  );
  decoder.accept(rejectedCandidate(topic) as never);
  return decoder;
}

// ————————————————— ConversationProjectionStore —————————————————

test("最终消费点 A：schema 拒收 ⇒ 跳过 resume 档、lastError = contentRejected（UI/遥测直接读它）", async () => {
  const fake = makeTransport();
  const store = new ConversationProjectionStore(CONVERSATION_TOPIC, fake.transport as never);
  await store.connect();
  // 合法 initial snapshot：走 store 的公开帧入口（生产里由 SessionDataLayer 调用）。
  store.handleFrame(
    {
      topic: CONVERSATION_TOPIC,
      subscriptionId: SUBSCRIPTION_ID,
      fromSeq: 0,
      toSeq: 1,
      sentAt: 1,
      payload: {
        kind: "snapshot",
        snapshot: { protocolVersion: 1, logEpoch: "e1", seq: 1, rows: [] },
      },
    } as never,
    { deliveryKind: "initial" },
  );
  await settle();
  assert.equal(store.getState().status, "live");

  const decoder = wireRejectedCandidate(
    CONVERSATION_TOPIC,
    fake,
    conversationTopicFrameSchema as never,
  );
  await withCompressedTimers([FRAME_DEADLINE_MS], async () => {
    // 第二投：同一份内容再被拒 —— resume 档必然复现同一个结论。
    fake.emitFault({
      topic: CONVERSATION_TOPIC,
      subscriptionId: SUBSCRIPTION_ID,
      reasonCode: WIRE_FAULT_INVALID_PAYLOAD,
      deliveryKind: "recovery",
    });
  });
  decoder.clear();

  // ① 第一档必须是 forceSnapshot，而不是瞬态阶梯的 resume。
  assert.deepEqual(fake.resyncs, [{ forceSnapshot: true }]);
  // ② 终态 lastError 是内容拒收，不是 recoveryFailed。
  assert.equal(store.getState().status, "error");
  assert.equal(store.getState().lastError, SUBSCRIPTION_CONTENT_REJECTED);
  assert.notEqual(store.getState().lastError, "fault.subscription.recoveryFailed");
});

test("对照 A：同一份 fixture 换成**瞬态** reasonCode ⇒ resume 档、lastError = recoveryFailed", async () => {
  const fake = makeTransport();
  const store = new ConversationProjectionStore(CONVERSATION_TOPIC, fake.transport as never);
  await store.connect();
  store.handleFrame(
    {
      topic: CONVERSATION_TOPIC,
      subscriptionId: SUBSCRIPTION_ID,
      fromSeq: 0,
      toSeq: 1,
      sentAt: 1,
      payload: {
        kind: "snapshot",
        snapshot: { protocolVersion: 1, logEpoch: "e1", seq: 1, rows: [] },
      },
    } as never,
    { deliveryKind: "initial" },
  );
  await settle();

  fake.emitFault({
    topic: CONVERSATION_TOPIC,
    subscriptionId: SUBSCRIPTION_ID,
    reasonCode: "proto.frameAssemblyChecksumMismatch",
    deliveryKind: "online",
  });
  await withCompressedTimers([FRAME_DEADLINE_MS], async () => {
    fake.emitFault({
      topic: CONVERSATION_TOPIC,
      subscriptionId: SUBSCRIPTION_ID,
      reasonCode: "proto.frameAssemblyChecksumMismatch",
      deliveryKind: "recovery",
    });
  });

  // ① 瞬态先走 resume 档（不 forceSnapshot）—— 与上一条形成可观测差别。
  assert.deepEqual(fake.resyncs, [{ forceSnapshot: false }]);
  // ② 终态是传输侧失败，不是内容拒收。
  assert.equal(store.getState().status, "error");
  assert.equal(store.getState().lastError, "fault.subscription.recoveryFailed");
  assert.notEqual(store.getState().lastError, SUBSCRIPTION_CONTENT_REJECTED);
});

// ————————————————— SessionsIndexStore —————————————————

test("最终消费点 B：schema 拒收 ⇒ 终态 error 且**不再重订阅**（不会陷入永不收敛的重订阅循环）", async () => {
  const fake = makeTransport();
  const store = new SessionsIndexStore();
  await store.connect(fake.transport as never);
  // 先喂一帧合法 initial snapshot：让水位有效，resume 档才可能被选中（否则第一档恒为
  // forceSnapshot，两条路径分不开）。
  fake.deliverValidSnapshot(
    SESSIONS_TOPIC,
    {
      topic: SESSIONS_TOPIC,
      subscriptionId: SUBSCRIPTION_ID,
      fromSeq: 0,
      toSeq: 1,
      sentAt: 1,
      payload: {
        kind: "snapshot",
        snapshot: { protocolVersion: 1, workspaceId: "ws-1", logEpoch: "e1", sessions: [] },
      },
    },
    "initial",
  );
  await settle();
  assert.equal(store.getStatus(), "live");
  const subscribesAfterConnect = fake.subscribes;

  const decoder = wireRejectedCandidate(
    SESSIONS_TOPIC,
    fake,
    sessionsIndexTopicFrameSchema as never,
  );
  await withCompressedTimers([FRAME_DEADLINE_MS, ERROR_RECOVERY_RETRY_DELAY_MS], async () => {
    fake.emitFault({
      topic: SESSIONS_TOPIC,
      subscriptionId: SUBSCRIPTION_ID,
      reasonCode: WIRE_FAULT_INVALID_PAYLOAD,
      deliveryKind: "recovery",
    });
  });
  decoder.clear();

  // ① 第一档是 forceSnapshot（跳过 resume）。
  assert.deepEqual(fake.resyncs, [{ forceSnapshot: true }]);
  // ② 终态停在 error（内容读不懂 ⇒ 停手），而不是重订阅成功后回到 live。
  assert.equal(store.getStatus(), "error");
  // ③ 不排退避重订阅 —— 这正是「反复重订阅」那个症状被拿掉的地方。
  assert.equal(fake.subscribes, subscribesAfterConnect);
});

test("对照 B：同一份 fixture 换成**瞬态** reasonCode ⇒ 排一次退避重订阅（证明上一条的判据有牙齿）", async () => {
  const fake = makeTransport();
  const store = new SessionsIndexStore();
  await store.connect(fake.transport as never);
  fake.deliverValidSnapshot(
    SESSIONS_TOPIC,
    {
      topic: SESSIONS_TOPIC,
      subscriptionId: SUBSCRIPTION_ID,
      fromSeq: 0,
      toSeq: 1,
      sentAt: 1,
      payload: {
        kind: "snapshot",
        snapshot: { protocolVersion: 1, workspaceId: "ws-1", logEpoch: "e1", sessions: [] },
      },
    },
    "initial",
  );
  await settle();
  assert.equal(store.getStatus(), "live");

  fake.emitFault({
    topic: SESSIONS_TOPIC,
    subscriptionId: SUBSCRIPTION_ID,
    reasonCode: "proto.frameAssemblyChecksumMismatch",
    deliveryKind: "online",
  });
  await withCompressedTimers([FRAME_DEADLINE_MS, ERROR_RECOVERY_RETRY_DELAY_MS], async () => {
    fake.emitFault({
      topic: SESSIONS_TOPIC,
      subscriptionId: SUBSCRIPTION_ID,
      reasonCode: "proto.frameAssemblyChecksumMismatch",
      deliveryKind: "recovery",
    });
  });

  // ① 瞬态先走 resume 档。
  assert.deepEqual(fake.resyncs, [{ forceSnapshot: false }]);
  // ② 瞬态会排退避重订阅并重新订阅成功 ⇒ 回到 live。
  assert.equal(fake.subscribes, 2);
  assert.equal(store.getStatus(), "live");
});
