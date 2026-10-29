import assert from "node:assert/strict";
import test from "node:test";
import {
  modelExecutionSchema,
  modelExecutionSelectionFallbackReasonSchema,
} from "../src/model-execution.js";

/**
 * 上游 3.16.2 的 modelExecution 增量（X6 / off-peak / 后台子代理允许）。
 *
 * 这些字段都由发起方（UI / 服务端）构造后进入 CLI：strict schema 漏声明 = 整条执行被拒。
 * 本测试钉住「新形态可接受、旧形态不回归、非法形态仍拒绝」。
 */

test("判据 1：selectionFallback 接受 highspeed_selection_unavailable", () => {
  const parsed = modelExecutionSchema.safeParse({
    selectionScope: "execution",
    selectionFallback: {
      providerId: "zai",
      rules: [{ reason: "highspeed_selection_unavailable" }],
    },
  });
  assert.equal(parsed.success, true);
  assert.equal(
    modelExecutionSelectionFallbackReasonSchema.safeParse("highspeed_card_expired").success,
    true,
  );
});

test("判据 2：offPeak 票据按 strict 对象透传，未知键被拒", () => {
  const ok = modelExecutionSchema.safeParse({
    selectionScope: "execution",
    offPeak: { executionId: "e1", ticketId: "t1", providerErrorCode: "429" },
  });
  assert.equal(ok.success, true);
  const extra = modelExecutionSchema.safeParse({
    selectionScope: "execution",
    offPeak: { executionId: "e1", ticketId: "t1", providerErrorCode: "429", extra: 1 },
  });
  assert.equal(extra.success, false);
});

test("判据 3：后台子代理 allow 可接受，未知取值仍拒绝", () => {
  const allow = modelExecutionSchema.safeParse({
    selectionScope: "execution",
    subagents: { foregroundModel: "submission", background: "allow" },
  });
  assert.equal(allow.success, true);
  const deny = modelExecutionSchema.safeParse({
    selectionScope: "execution",
    subagents: { foregroundModel: "submission", background: "deny" },
  });
  assert.equal(deny.success, true);
  const invalid = modelExecutionSchema.safeParse({
    selectionScope: "execution",
    subagents: { foregroundModel: "submission", background: "maybe" },
  });
  assert.equal(invalid.success, false);
});
