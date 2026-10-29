import assert from "node:assert/strict";
import test from "node:test";
import type { TurnInputIntentMetadata } from "@zcode/contracts";
import { admitPrompt } from "../src/runtime/methods/prompt-admission.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";

/**
 * X1（加速回合编辑丢失）core 侧回归：admitPrompt 的 requireQueue 分支。
 *
 * Bug 根因（上游 aac47556，Apache-2.0；见 .local/reports/engineering/x1-accelerated-edit-loss.md §3）：
 * 编辑重发不能依据 Bootstrap 的 busy 快照决定是否直接启动——状态在跨层 await 期间转为空闲时，
 * 高速临时 provider 会按普通模型启动（Highspeed 临时 provider 只能在独立 turn 的提升边界安装）。
 * requireQueue 让 edit 重发无条件入队成未来独立 turn。
 *
 * 运行：cd apps/zcode-cli/packages/core && node --import tsx --test test/x1-require-queue-admission.test.ts
 */

interface Captured {
  input?: string;
  delivery?: string;
  intent?: TurnInputIntentMetadata | undefined;
}

function makeStub(captured: Captured, extra?: Partial<AgentRuntimeInternal>) {
  return {
    // 只实现 requireQueue 分支会触到的方法：该分支必须不看 busy 状态。
    hasActiveOrQueuedTurnWork: () => true,
    activeTurn: { turnId: "running", steerable: true },
    enqueueDeferredInput: async (request: {
      input: string;
      delivery?: string;
      intent?: TurnInputIntentMetadata;
    }) => {
      captured.input = request.input;
      captured.delivery = request.delivery;
      captured.intent = request.intent;
      return { kind: "queued" as const, pendingInputId: "pending-1", queueLength: 1, turnId: "queued-turn" };
    },
    ...extra,
  } as unknown as AgentRuntimeInternal;
}

const INTENT: TurnInputIntentMetadata = {
  kind: "sendText",
  text: "edited",
  admissionSeq: 3,
  admittedAt: Date.now(),
  requestedDelivery: "startNow",
  admittedDelivery: "startNow",
  sourceCommandId: "cmd-1",
  highspeed: {
    schemaVersion: 1,
    cardId: "card-1",
    taskId: "task-1",
    provider: "provider-highspeed",
    model: "model-x",
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  },
};

test("requireQueue：无条件入队，delivery=queue，intent 的 admittedDelivery 落 queue", async () => {
  const captured: Captured = {};
  const receipt = await admitPrompt.call(
    makeStub(captured),
    "edited text",
    undefined,
    { requireQueue: true, inputId: "in-1", queryId: "q-1" as never, intent: INTENT, commandKind: "sendText" },
  );
  assert.equal(receipt.kind, "queued");
  assert.equal(captured.input, "edited text");
  assert.equal(captured.delivery, "queue");
  // admissionIntent(intent, "queue")：intent 复制并改 admittedDelivery，不改 requestedDelivery。
  assert.equal(captured.intent?.admittedDelivery, "queue");
  assert.equal(captured.intent?.requestedDelivery, "startNow");
  // 高速卡元数据随 intent 原样流入队列（凭据不在此层）。
  assert.equal(captured.intent?.highspeed?.cardId, "card-1");
});

test("requireQueue：会话正处于 busy 且有 steerable turn，仍只入队、不 steer、不启动", async () => {
  const captured: Captured = {};
  const receipt = await admitPrompt.call(
    makeStub(captured),
    "edited text",
    undefined,
    { requireQueue: true, inputId: "in-2", commandKind: "sendText" },
  );
  // stub 的 hasActiveOrQueuedTurnWork 恒真、activeTurn 恒在：若分支去参考 busy，就会走 steer/reject。
  assert.equal(receipt.kind, "queued");
  assert.equal(captured.delivery, "queue");
  assert.equal(captured.intent, undefined);
});

test("非 requireQueue 的普通发送仍走 busy 判定路径（queueDelivery 缺省时入队）", async () => {
  const captured: Captured = {};
  const receipt = await admitPrompt.call(
    makeStub(captured),
    "plain text",
    undefined,
    { inputId: "in-3", commandKind: "sendText" },
  );
  assert.equal(receipt.kind, "queued");
  // 普通路径的 delivery 由 busy 分支决定（queueDelivery 无值 → queue）。
  assert.equal(captured.delivery, "queue");
  assert.equal(captured.input, "plain text");
});
