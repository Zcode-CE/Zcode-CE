import assert from "node:assert/strict";
import test from "node:test";
import {
  V4PromptRejectedError,
  preflightPromptTurn,
  type StartPromptTurnParams,
} from "../src/zcode-protocol-v4/commands/prompt-turn.js";
import type { V4CommandCoreHost, V4SessionRecordView } from "../src/zcode-protocol-v4/commands/types.js";

/**
 * X2 最小片：模型不可用时必须在 ACK 之前拒绝，不能等后台创建失败后静默丢输入。
 *
 * CE 尚未搬 selectionFallback 子系统，所以 execution Selection 仍延迟到 Core；
 * 普通 Selection 在这里严格预检。
 */

const AVAILABLE_MODELS = [{ ref: { providerId: "p", modelId: "m" } }];

function makeRecord(overrides: Record<string, unknown> = {}) {
  return {
    app: { sessionId: "session-1", listModels: () => AVAILABLE_MODELS },
    persistence: "immediate",
    ...overrides,
  } as unknown as V4SessionRecordView;
}

const host = {
  logger: { info: () => undefined },
  ensureModelReady: async () => undefined,
} as unknown as V4CommandCoreHost;

function params(modelSelection: { providerId: string; modelId: string }, extra = {}) {
  return {
    content: "hi",
    inputId: "input-1",
    intent: { modelSelection },
    ...extra,
  } as unknown as StartPromptTurnParams;
}

test("普通 Selection 不在 Provider Registry：ACK 前拒绝（modelUnavailable）", async () => {
  await assert.rejects(
    () => preflightPromptTurn(host, makeRecord(), params({ providerId: "p", modelId: "missing" })),
    (error: unknown) =>
      error instanceof V4PromptRejectedError && error.reasonCode === "modelUnavailable",
  );
});

test("可用模型与 execution Selection 都放行", async () => {
  await preflightPromptTurn(host, makeRecord(), params({ providerId: "p", modelId: "m" }));
  await preflightPromptTurn(
    host,
    makeRecord(),
    params({ providerId: "p", modelId: "missing" }, { modelExecution: { selectionScope: "execution" } }),
  );
});

test("过期 restoreWarning 在模型目录恢复后清除", async () => {
  const record = makeRecord({
    restoreWarning: { type: "modelUnavailable", message: "stale" },
  });
  const clearingHost = {
    ...host,
    hasUsableRuntimeModelTarget: () => true,
  } as unknown as V4CommandCoreHost;
  await preflightPromptTurn(clearingHost, record, params({ providerId: "p", modelId: "m" }));
  assert.equal(record.restoreWarning, undefined);
});
