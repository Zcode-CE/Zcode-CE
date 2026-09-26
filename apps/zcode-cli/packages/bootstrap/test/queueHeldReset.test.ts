import assert from "node:assert/strict";
import test from "node:test";
import type { ModelSelection } from "@zcode/contracts";
import {
  resetHeldQueueAfterModelSelectionChange,
  type QueueAutoDrainState,
} from "../src/zcode-protocol-v4/queue-held-reset.js";

/**
 * 切模型复位队列授权位（spec 130 §4.6）的判据测试。
 *
 * 缺陷背景（docs/development/127 §5.2 方案 A）：turn.failed 后若队列非空，v4 投影把
 * queue.autoDrain 置 false + pauseReason="error"（product-projection.ts:2279-2286），
 * 而任何切模型路径都不复位它 ⇒ 用户观感是「切其他渠道的模型依旧报错，只能单开一个新会话」。
 *
 * 这一层为什么必须单测：四条门（选型变更 / 投影可读 / 确实 held / 原因可复位）各自都有
 * 静默的错误方向 —— 少一道就是「用户点了恢复却仍卡住」或「用户主动 Stop 的队列被误清」，
 * 两者都不会报错，只会在真实使用里表现为「切了模型还是不行」。
 *
 * 运行：cd apps/zcode-cli/packages/bootstrap && node --import tsx --test test/queueHeldReset.test.ts
 * 注意：本地直接跑要装源码解析钩子（CI 上由 pnpm test 统一装）：
 *   node --import tsx --import ../../../../packages/services/test/support/zcodeSourceResolver.mjs --test <file>
 */

const GLM: ModelSelection = { providerId: "glm", modelId: "glm-5" };
const KIMI: ModelSelection = { providerId: "kimi", modelId: "kimi-k2" };

/** 记录 setQueueAutoDrain 调用的最小 app 桩（只取判据件实际用到的能力）。 */
function createAppSpy() {
  const calls: boolean[] = [];
  return {
    calls,
    app: {
      setQueueAutoDrain: async (autoDrain: boolean) => {
        calls.push(autoDrain);
      },
    },
  };
}

function heldQueue(pauseReason: QueueAutoDrainState["pauseReason"]): QueueAutoDrainState {
  return { autoDrain: false, ...(pauseReason ? { pauseReason } : {}) };
}

async function run(params: {
  previous?: ModelSelection;
  next: ModelSelection;
  queue: QueueAutoDrainState | null;
}): Promise<{ calls: boolean[]; resumed: boolean }> {
  const spy = createAppSpy();
  const resumed = await resetHeldQueueAfterModelSelectionChange({
    app: spy.app,
    sessionId: "s1",
    previousSelection: params.previous,
    nextSelection: params.next,
    readQueueState: () => params.queue,
  });
  return { calls: spy.calls, resumed };
}

test("turn 失败导致 held（pauseReason=error）+ 选型变更 → 复位为 true", async () => {
  const { calls, resumed } = await run({ previous: GLM, next: KIMI, queue: heldQueue("error") });
  assert.equal(resumed, true);
  assert.deepEqual(calls, [true]);
});

test("pauseReason=manual 造成的 held 同样复位（spec §4.6 列入可复位集合）", async () => {
  const { calls } = await run({ previous: GLM, next: KIMI, queue: heldQueue("manual") });
  assert.deepEqual(calls, [true]);
});

test("pauseReason=stopped（用户主动停止）→ 不复位（尊重用户停止意图）", async () => {
  const { calls, resumed } = await run({ previous: GLM, next: KIMI, queue: heldQueue("stopped") });
  assert.equal(resumed, false);
  assert.deepEqual(calls, []);
});

test("pauseReason 缺省（旧快照）→ 不复位（fail-closed，宁可漏不误清）", async () => {
  const { calls } = await run({ previous: GLM, next: KIMI, queue: { autoDrain: false } });
  assert.deepEqual(calls, []);
});

test("同选型重复提交 → 不复位（防每次发消息抖动 revision）", async () => {
  const { calls, resumed } = await run({ previous: GLM, next: GLM, queue: heldQueue("error") });
  assert.equal(resumed, false);
  assert.deepEqual(calls, []);
});

test("reasoningLevel 不同视为选型变更（档位也是 Selection 的一部分）", async () => {
  const { calls } = await run({
    previous: { ...GLM, options: { reasoningLevel: "low" } },
    next: { ...GLM, options: { reasoningLevel: "high" } },
    queue: heldQueue("error"),
  });
  assert.deepEqual(calls, [true]);
});

test("队列本就 autoDrain=true → no-op（不产生多余事件/revision）", async () => {
  const { calls, resumed } = await run({
    previous: GLM,
    next: KIMI,
    queue: { autoDrain: true },
  });
  assert.equal(resumed, false);
  assert.deepEqual(calls, []);
});

test("投影不可得（无 publisher / 冷恢复未水合）→ 不复位", async () => {
  const { calls, resumed } = await run({ previous: GLM, next: KIMI, queue: null });
  assert.equal(resumed, false);
  assert.deepEqual(calls, []);
});

test("会话首次选型（previous 为空）→ 按变更处理，held 时复位", async () => {
  const { calls } = await run({ next: GLM, queue: heldQueue("error") });
  assert.deepEqual(calls, [true]);
});

test("resumed=true 时才写日志（no-op 路径不产生噪音行）", async () => {
  const logs: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  const spy = createAppSpy();
  await resetHeldQueueAfterModelSelectionChange({
    app: spy.app,
    sessionId: "s1",
    previousSelection: GLM,
    nextSelection: KIMI,
    readQueueState: () => ({ autoDrain: true }),
    logger: { info: (message, fields) => logs.push({ message, fields }) },
  });
  assert.deepEqual(logs, []);
});
