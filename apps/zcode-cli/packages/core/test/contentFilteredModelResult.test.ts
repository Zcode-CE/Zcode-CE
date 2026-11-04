import assert from "node:assert/strict";
import test from "node:test";
import {
  createContentFilteredModelResultError,
  isContentFilteredEmptyModelResult,
} from "../src/runtime/helpers/model-errors.js";

/**
 * X6（3.17.2 移植）：回复被 provider 内容安全策略拦截时快速报错，不再反复重试。
 *
 * 为什么必须钉住：改前这类空回复落进 suspicious empty，被当成可重试的空结果，先白跑一轮恢复重试
 * 才报错。同一上下文重发会被同样拦截，所以正确行为是立刻以 `retryable: false` 结束这一轮。
 * 另需覆盖 GLM（MaaS）的输出侧安全审核终止值 `sensitive`——AI SDK 只认 `content-filter`。
 *
 * 运行：cd apps/zcode-cli/packages/core && node --import tsx --test test/contentFilteredModelResult.test.ts
 */

test("三种内容过滤终止值都识别（含 GLM 的 sensitive）", () => {
  for (const finishReason of ["content-filter", "content_filter", "sensitive", "Sensitive"]) {
    assert.equal(isContentFilteredEmptyModelResult(finishReason, undefined, 0, 0), true, finishReason);
  }
  // rawFinishReason 单独命中同样算：provider 可能只把它放在 metadata 里。
  assert.equal(isContentFilteredEmptyModelResult(undefined, "sensitive", 0, 0), true);
});

test("有正文、有工具调用或非内容过滤终止值时不算（不能吞掉正常空回复的诊断）", () => {
  assert.equal(isContentFilteredEmptyModelResult("content-filter", undefined, 5, 0), false);
  assert.equal(isContentFilteredEmptyModelResult("content-filter", undefined, 0, 1), false);
  assert.equal(isContentFilteredEmptyModelResult("stop", undefined, 0, 0), false);
  assert.equal(isContentFilteredEmptyModelResult(undefined, undefined, 0, 0), false);
});

test("拦截错误标记 retryable=false 且带可定位的结构化上下文", () => {
  const error = createContentFilteredModelResultError({
    finishReason: "sensitive",
    model: { modelId: "glm-fixture", providerId: "zai" },
    rawFinishReason: "sensitive",
  });
  assert.equal(error.retryable, false);
  assert.match(error.message, /content safety filter/);
  const context = (error as unknown as { context?: Record<string, unknown> }).context;
  assert.equal(context?.reason, "content_filter");
  assert.equal(context?.source, "provider");
  assert.equal(context?.modelId, "glm-fixture");
  assert.equal(context?.providerId, "zai");
});
