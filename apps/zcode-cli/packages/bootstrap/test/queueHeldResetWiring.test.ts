import assert from "node:assert/strict";
import test from "node:test";
import type { ModelSelection } from "@zcode/contracts";
// 经 handlers 注册表入口导入，而不是各 handler 模块：handler 模块 → v4-gateway →
// executor → handlers/index.js 构成一条既有环，从 handler 模块直接进会在
// NATIVE_HANDLERS 求值前触发 sessionFlowHandlers 的 TDZ。注册表入口是生产路径
// （v4-bridge 经 executor 取用）的同一入口，顺序已被生产验证。
import { NATIVE_HANDLERS } from "../src/zcode-protocol-v4/commands/handlers/index.js";
import { resetHeldQueueForSubmittedModelChange } from "../src/zcode-protocol-v4/commands/handlers/session-flow.js";
import { runSessionModelConfigMutation } from "../src/zcode-protocol-v4/model-config-mutation.js";
import { resumeHeldQueueAfterModelChange } from "../src/zcode-protocol/server-operations.js";
import type { V4CommandCoreHost, V4SessionRecordView } from "../src/zcode-protocol-v4/commands/types.js";

/**
 * 切模型复位队列授权位（spec 130 §4.6）的三条路径接线测试。
 *
 * 判据件本身由 test/queueHeldReset.test.ts 覆盖；这里只回答「三条路径是否真的接上了」——
 * 这是本缺陷的原始形态：机制全都存在，没有任何一条切模型路径调它
 * （docs/development/127 §2.1(c) 坐实）。因此「判据正确但没接线」是最可能的回归，
 * 必须由接线测试钉住，而不能只测判据。
 *
 * 三条路径（Lead 已复核确认互不相同，见 spec §4.6 订正记录）：
 * 1. v4 switchModelConfig —— model-config.ts，消费方 = replayable/automation facade；
 * 2. legacy session/setModel —— server-operations.ts，消费方 = zcodeSessionService（桌面）与 bot /model；
 * 3. v4 sendText 携带 modelSelection —— 桌面 v4 Composer 的真实切模型路径
 *    （Composer 只改 renderer 草稿，真正生效在提交时；core turn-model.ts:40-71）。
 *
 * 运行：cd apps/zcode-cli/packages/bootstrap && node --import tsx --test test/queueHeldResetWiring.test.ts
 * 注意：本地直接跑要装源码解析钩子（CI 上由 pnpm test 统一装）：
 *   node --import tsx --import ../../../../packages/services/test/support/zcodeSourceResolver.mjs --test <file>
 */

const switchModelConfig = NATIVE_HANDLERS.switchModelConfig;
const sessionFlowHandlers = { sendText: NATIVE_HANDLERS.sendText };

const GLM: ModelSelection = { providerId: "glm", modelId: "glm-5" };
const KIMI: ModelSelection = { providerId: "kimi", modelId: "kimi-k2" };

type QueueState = { autoDrain: boolean; pauseReason?: "stopped" | "manual" | "error" };

/** 会话侧桩：记录 setQueueAutoDrain 调用与 afterLegacyStateMutation（ready hook）调用。 */
function createSessionStub(params: {
  currentSelection: ModelSelection | undefined;
  queue: QueueState | null;
  /** setModel 是否抛错（覆盖「切换失败不复位」）。 */
  failSetModel?: boolean;
  /** setModel 成功后 runtime 的选型（缺省 = 目标选型）。 */
  selectionAfterSetModel?: ModelSelection | undefined;
}) {
  const autoDrainCalls: boolean[] = [];
  const mutationReasons: string[] = [];
  let selection = params.currentSelection;
  const app = {
    sessionId: "s1",
    runtime: {
      getSessionModelSelection: () => selection,
      emitModelSelected: async () => {},
    },
    listThoughtLevels: () => [] as string[],
    getThoughtLevel: () => undefined,
    setThoughtLevel: async () => ({ thoughtLevel: "" }),
    setQueueAutoDrain: async (autoDrain: boolean) => {
      autoDrainCalls.push(autoDrain);
    },
    setModel: async () => {
      if (params.failSetModel) throw new Error("setModel failed");
      selection = params.selectionAfterSetModel ?? { providerId: "kimi", modelId: "kimi-k2" };
      return { thoughtLevel: undefined };
    },
  };
  const record = { app, traceContext: { traceId: "t1" } } as unknown as V4SessionRecordView;
  const host = {
    getRecord: () => record,
    getQueueAutoDrainState: () => params.queue,
    getInputRoutingMode: () => null,
    afterLegacyStateMutation: async (_record: unknown, reason: string) => {
      mutationReasons.push(reason);
    },
    ensureProviderAvailable: async () => ({ available: true }),
  } as unknown as V4CommandCoreHost;
  return { app, record, host, autoDrainCalls, mutationReasons, selectionOf: () => selection };
}

/** 构造 switchModelConfig 信封（CAS 命令，payload 三字段全必填）。 */
function switchEnvelope(provider: string, model: string) {
  return {
    commandId: "c1",
    clientId: "test",
    sessionId: "s1",
    type: "switchModelConfig" as const,
    payload: { provider, model, thought: "" },
    issuedAt: Date.now(),
  };
}

// ── 路径 1：v4 switchModelConfig ──────────────────────────────────────────

test("路径1 switchModelConfig：held(error) + 选型变更 → 复位 true 并触发 ready hook", async () => {
  const stub = createSessionStub({
    currentSelection: GLM,
    queue: { autoDrain: false, pauseReason: "error" },
  });
  await switchModelConfig(stub.host, switchEnvelope("kimi", "kimi-k2"));
  assert.deepEqual(stub.autoDrainCalls, [true]);
  // 只翻授权位不够：idle 暂停队列没有 active turn 能替它启动队首（queue.ts:138-142 同义务）。
  assert.deepEqual(stub.mutationReasons, ["queue_auto_drain_resumed"]);
});

test("路径1 switchModelConfig：同选型重复提交（noop ACK）→ 不复位", async () => {
  const stub = createSessionStub({
    currentSelection: GLM,
    queue: { autoDrain: false, pauseReason: "error" },
  });
  // 同 provider/model 且 thought 相同 → V4CommandNoopError，早于任何复位。
  await assert.rejects(() => switchModelConfig(stub.host, switchEnvelope("glm", "glm-5")));
  assert.deepEqual(stub.autoDrainCalls, []);
});

test("路径1 switchModelConfig：pauseReason=stopped → 不复位", async () => {
  const stub = createSessionStub({
    currentSelection: GLM,
    queue: { autoDrain: false, pauseReason: "stopped" },
  });
  await switchModelConfig(stub.host, switchEnvelope("kimi", "kimi-k2"));
  assert.deepEqual(stub.autoDrainCalls, []);
  assert.deepEqual(stub.mutationReasons, []);
});

test("路径1 switchModelConfig：投影不可得(null) → 不复位", async () => {
  const stub = createSessionStub({ currentSelection: GLM, queue: null });
  await switchModelConfig(stub.host, switchEnvelope("kimi", "kimi-k2"));
  assert.deepEqual(stub.autoDrainCalls, []);
});

test("路径1 switchModelConfig：ready hook 不得在模型配置临界区内调用（防自死锁）", async () => {
  // 回归护栏（本修复实现期间实测到的自死锁）：
  // afterLegacyStateMutation 的实现（v4-bridge.ts:1080 → afterStateMutation）在会话空闲时
  // 会走 ensureSessionModelAvailable → runSessionModelConfigMutation，而
  // model-config-mutation.ts 的串行化是非重入的（锁内再进同一把锁直接挂死）。
  // 而「空闲 + 队列 held」正是本修复最主要的使用场景 ⇒ 钩子若留在锁内，生产上必然挂死，
  // 且症状是「切模型后界面卡住」而非报错，只有超时才暴露。
  // 这里用「钩子内部再进一次同一把锁」模拟真实实现，并加超时把挂死变成确定性失败。
  const stub = createSessionStub({
    currentSelection: GLM,
    queue: { autoDrain: false, pauseReason: "error" },
  });
  const host = {
    ...stub.host,
    getRecord: () => stub.record,
    getQueueAutoDrainState: () => ({ autoDrain: false, pauseReason: "error" as const }),
    afterLegacyStateMutation: async () => {
      // 真实钩子会经 ensureSessionModelAvailable 再进同一把锁。
      await runSessionModelConfigMutation(stub.record.app, async () => undefined);
    },
  } as unknown as V4CommandCoreHost;
  const outcome = await Promise.race([
    switchModelConfig(host, switchEnvelope("kimi", "kimi-k2")).then(() => "ok"),
    new Promise((resolve) => setTimeout(() => resolve("DEADLOCK"), 3000)),
  ]);
  assert.equal(outcome, "ok", "ready hook 必须在临界区外调用，否则锁内重入自死锁");
  assert.deepEqual(stub.autoDrainCalls, [true]);
});

test("路径1 switchModelConfig：切换失败 → 不复位（不掩盖失败原因）", async () => {
  const stub = createSessionStub({
    currentSelection: GLM,
    queue: { autoDrain: false, pauseReason: "error" },
    failSetModel: true,
  });
  await assert.rejects(() => switchModelConfig(stub.host, switchEnvelope("kimi", "kimi-k2")));
  assert.deepEqual(stub.autoDrainCalls, []);
});

// ── 路径 2：legacy session/setModel 的接线件 ──────────────────────────────

test("路径2 legacy setModel 接线：held(error) + 选型变更 → 复位并请求重评", async () => {
  const stub = createSessionStub({
    currentSelection: KIMI,
    queue: { autoDrain: false, pauseReason: "error" },
  });
  const reevaluations: string[] = [];
  const context = {
    v4Gateway: {
      getQueueAutoDrainState: () => ({ autoDrain: false, pauseReason: "error" as const }),
      requestQueueDrainReevaluation: (sessionId: string) => reevaluations.push(sessionId),
    },
    logger: undefined,
  };
  const resumed = await resumeHeldQueueAfterModelChange(
    context as never,
    stub.record as never,
    GLM, // previous = glm，runtime 当前 = kimi ⇒ 确实变更
  );
  assert.equal(resumed, true);
  assert.deepEqual(stub.autoDrainCalls, [true]);
  // 本路径没有命令层的 afterLegacyStateMutation，靠 gateway 的 ready hook 入口重评。
  assert.deepEqual(reevaluations, ["s1"]);
});

test("路径2 legacy setModel 接线：同选型（previous === 当前）→ 不复位、不重评", async () => {
  const stub = createSessionStub({ currentSelection: GLM, queue: { autoDrain: false, pauseReason: "error" } });
  const reevaluations: string[] = [];
  const context = {
    v4Gateway: {
      getQueueAutoDrainState: () => ({ autoDrain: false, pauseReason: "error" as const }),
      requestQueueDrainReevaluation: (sessionId: string) => reevaluations.push(sessionId),
    },
  };
  const resumed = await resumeHeldQueueAfterModelChange(context as never, stub.record as never, GLM);
  assert.equal(resumed, false);
  assert.deepEqual(stub.autoDrainCalls, []);
  assert.deepEqual(reevaluations, []);
});

test("路径2 legacy setModel 接线：队列本就 true → no-op（无多余 revision 抖动）", async () => {
  const stub = createSessionStub({ currentSelection: KIMI, queue: { autoDrain: true } });
  const context = {
    v4Gateway: {
      getQueueAutoDrainState: () => ({ autoDrain: true }),
      requestQueueDrainReevaluation: () => {
        throw new Error("must not reevaluate when nothing was resumed");
      },
    },
  };
  const resumed = await resumeHeldQueueAfterModelChange(context as never, stub.record as never, GLM);
  assert.equal(resumed, false);
  assert.deepEqual(stub.autoDrainCalls, []);
});

// ── 路径 3：v4 sendText 携带 modelSelection（桌面 Composer 的真实路径）────

test("路径3 sendText 接线件：held(error) + 提交新选型 → 复位并触发 ready hook", async () => {
  const stub = createSessionStub({ currentSelection: GLM, queue: { autoDrain: false, pauseReason: "error" } });
  const resumed = await resetHeldQueueForSubmittedModelChange(stub.host, stub.record, {
    previousSelection: GLM,
    nextSelection: KIMI,
  });
  assert.equal(resumed, true);
  assert.deepEqual(stub.autoDrainCalls, [true]);
  assert.deepEqual(stub.mutationReasons, ["queue_auto_drain_resumed"]);
});

test("路径3 sendText 接线件：同选型重复提交 → 不复位（防每次发消息抖动 revision）", async () => {
  const stub = createSessionStub({ currentSelection: GLM, queue: { autoDrain: false, pauseReason: "error" } });
  const resumed = await resetHeldQueueForSubmittedModelChange(stub.host, stub.record, {
    previousSelection: GLM,
    nextSelection: GLM,
  });
  assert.equal(resumed, false);
  assert.deepEqual(stub.autoDrainCalls, []);
  assert.deepEqual(stub.mutationReasons, []);
});

test("路径3 sendText 接线件：pauseReason=stopped → 不复位（尊重用户停止意图）", async () => {
  const stub = createSessionStub({ currentSelection: GLM, queue: { autoDrain: false, pauseReason: "stopped" } });
  const resumed = await resetHeldQueueForSubmittedModelChange(stub.host, stub.record, {
    previousSelection: GLM,
    nextSelection: KIMI,
  });
  assert.equal(resumed, false);
  assert.deepEqual(stub.autoDrainCalls, []);
});

test("路径3 sendText 接线件：投影不可得(null) → 不复位", async () => {
  const stub = createSessionStub({ currentSelection: GLM, queue: null });
  const resumed = await resetHeldQueueForSubmittedModelChange(stub.host, stub.record, {
    previousSelection: GLM,
    nextSelection: KIMI,
  });
  assert.equal(resumed, false);
  assert.deepEqual(stub.autoDrainCalls, []);
});

/** 构造 sendText 信封。 */
function sendTextEnvelope(payload: Record<string, unknown>) {
  return {
    commandId: "c2",
    clientId: "test",
    sessionId: "s1",
    type: "sendText" as const,
    payload,
    issuedAt: Date.now(),
  };
}

test("路径3 sendText 真 handler：held(error) + 提交新选型 → 复位（桌面 Composer 的真实路径）", async () => {
  const stub = createSessionStub({
    currentSelection: GLM,
    queue: { autoDrain: false, pauseReason: "error" },
  });
  // sendText 后续会走到 startPromptTurn → app.sendInput；桩不提供它，因此以异常收尾。
  // 复位判据位于 admission 之后，所以这里必须先让 admission 成功。
  let admissionSucceeded = false;
  (stub.record.app as unknown as Record<string, unknown>).sendInput = async () => {
    admissionSucceeded = true;
    return { kind: "started", completion: Promise.resolve() };
  };
  await sessionFlowHandlers
    .sendText(stub.host, sendTextEnvelope({ text: "hi", modelSelection: KIMI }) as never)
    .catch(() => undefined);
  assert.equal(admissionSucceeded, true, "admission 必须先成功，否则测的不是复位路径");
  assert.deepEqual(stub.autoDrainCalls, [true]);
  // 只断言「复位这次 mutation 发生了」：detached 的 turn completion 收尾
  // （prompt-turn.ts:166 的 prompt_completed）也会走同一钩子，两者次序是异步竞态，
  // 不该被这里钉死——钉死会得到一个偶发红的测试。
  assert.ok(
    stub.mutationReasons.includes("queue_auto_drain_resumed"),
    `复位必须触发 ready hook，实际 reason 序列: ${JSON.stringify(stub.mutationReasons)}`,
  );
});

test("路径3 sendText 真 handler：缺省 modelSelection（沿用会话现值）→ 不复位", async () => {
  // 缺省 modelSelection = 旧发送端沿用会话选型，不是用户切模型意图。这条断言挡的是
  // 「把每次普通发送都当成切模型」——那会让每次发消息都翻转授权位、抖动 revision。
  const stub = createSessionStub({
    currentSelection: GLM,
    queue: { autoDrain: false, pauseReason: "error" },
  });
  let admissionSucceeded = false;
  (stub.record.app as unknown as Record<string, unknown>).sendInput = async () => {
    admissionSucceeded = true;
    return { kind: "started", completion: Promise.resolve() };
  };
  await sessionFlowHandlers
    .sendText(stub.host, sendTextEnvelope({ text: "hi" }) as never)
    .catch(() => undefined);
  assert.equal(admissionSucceeded, true);
  assert.deepEqual(stub.autoDrainCalls, []);
});
