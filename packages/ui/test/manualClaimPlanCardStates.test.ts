import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolveManualClaimPlanCardView } from "../src/settings/model-provider-section/ManualClaimPlanCard.js";
import type { ManualClaimPlanPreview } from "@zcode/shared";

/**
 * claim 卡片三态分界的回归测试（task-105）。
 *
 * ## 为什么要钉住
 * 原实现是两处早退（`loading && plans.length === 0` 与 `plans.length === 0`），
 * 而 `error` 的渲染点在它们之后 ⇒ `settings.modelProvider.manualClaim.loadFailed`
 * 永远渲染不到：读取失败与「服务端没有活动」在界面上长得一模一样，都是整块消失。
 * 这是静默降级 —— 用户既不知道失败了，也不知道可以重试。
 *
 * 根因不只是分支顺序：`useManualClaimPlan` 的 `INITIAL_STATE.loading` 初值是 false，
 * 首帧渲染时第一个条件就不成立，直接落到空列表分支。因此单看 loading 与 plans
 * 分不出「首屏还没查」与「查完确实没有活动」，需要 `loaded` 这一位。
 *
 * ## 这条测试与真浏览器证据的关系
 * 这里钉的是三态分界（纯函数）与源码形态（防止把分支写回去）。
 * 真浏览器里的 DOM 证据（失败态可见 + 重试可点 + 无活动时无卡片）见
 * `.reverse/94-account-capability/harness/`（vite build + node probe-render.mjs）。
 */

const CARD_SOURCE = readFileSync(
  new URL("../src/settings/model-provider-section/ManualClaimPlanCard.tsx", import.meta.url),
  "utf8",
);
const HOOK_SOURCE = readFileSync(
  new URL("../src/settings/model-provider-section/useManualClaimPlan.ts", import.meta.url),
  "utf8",
);

const PLAN: ManualClaimPlanPreview = {
  planId: "wk-0918",
  name: "周末体验套餐",
  description: "周末限时可领取",
  priority: 10,
  entitlements: [],
};

test("判据 1：读取失败（loaded 且有 error、列表为空）判为失败态，而不是不显示", () => {
  assert.equal(
    resolveManualClaimPlanCardView({
      plans: [],
      loaded: true,
      error: "network down",
      claimed: false,
    }),
    "load-failed",
  );
});

test("判据 3 的语义面：查完为空且无 error 判为不渲染（不新增空态）", () => {
  assert.equal(
    resolveManualClaimPlanCardView({ plans: [], loaded: true, error: null, claimed: false }),
    "hidden",
  );
});

test("首屏（还没查完）判为不渲染，不占位", () => {
  assert.equal(
    resolveManualClaimPlanCardView({ plans: [], loaded: false, error: null, claimed: false }),
    "hidden",
  );
  // 首帧 INITIAL_STATE.loading 是 false ⇒ 这一态只能靠 loaded 认出来。
  assert.equal(
    resolveManualClaimPlanCardView({ plans: [], loaded: false, error: "stale", claimed: false }),
    "hidden",
  );
});

test("判据 4：有活动判为套餐卡片，不受 loaded 影响", () => {
  assert.equal(
    resolveManualClaimPlanCardView({ plans: [PLAN], loaded: true, error: null, claimed: false }),
    "plan",
  );
  assert.equal(
    resolveManualClaimPlanCardView({
      plans: [PLAN],
      loaded: true,
      error: "claim failed",
      claimed: false,
    }),
    "plan",
  );
});

test("判据 6（task-110）：领取成功后即使列表为空也必须渲染票券，不退回 hidden 或失败态", () => {
  // 成功后 hook 会 refresh()，而活动可能已从列表消失 —— 这是服务端事实，
  // 不是「我们没查到」。退回 hidden 就等于把已经领到的权益从界面上抹掉。
  assert.equal(
    resolveManualClaimPlanCardView({ plans: [], loaded: true, error: null, claimed: true }),
    "ticket",
  );
  assert.equal(
    resolveManualClaimPlanCardView({ plans: [], loaded: true, error: "x", claimed: true }),
    "ticket",
  );
});

test("判据 3 的源码护栏：hidden 分支必须直接 return null（防止顺手加空态）", () => {
  // 有人把这一支改成渲染「当前没有可领取的活动」时，这条会红。
  assert.ok(
    /if \(view === "hidden"\) \{\s*return null;\s*\}/.test(CARD_SOURCE),
    "hidden 分支必须保持 return null：无活动时不占位、不显示空态（用户已确认的产品决策）",
  );
});

test("判据 3 的文案护栏：不得新增空态文案 key", () => {
  for (const locale of ["zh-CN", "en-US"]) {
    const source = readFileSync(
      new URL(`../src/i18n/locales/${locale}.ts`, import.meta.url),
      "utf8",
    );
    const offenders = [
      ...source.matchAll(/"(settings\.modelProvider\.manualClaim\.[A-Za-z0-9.]*)"/g),
    ]
      .map((match) => match[1])
      .filter((key) => /empty|noPlan|noActivity|noneAvailable/i.test(key));
    assert.deepEqual(offenders, [], `${locale} 出现了空态文案 key`);
  }
});

test("hook 护栏：loaded 必须在成功与失败两处置 true，请求开始时不得清掉", () => {
  // 成功路径。
  assert.ok(
    /setState\(\(current\) => \(\{\s*\.\.\.current,\s*plans,\s*captchaConfig,\s*loaded: true,/.test(
      HOOK_SOURCE,
    ),
    "成功分支必须置 loaded: true",
  );
  // 失败路径：漏掉它，失败就会退回「什么都不显示」的静默形态。
  assert.ok(
    /plans: \[\],\s*loaded: true,\s*loading: false,\s*error: message,/.test(HOOK_SOURCE),
    "失败分支必须置 loaded: true",
  );
  // 请求开始：不得把 loaded 或 error 清掉 —— 清了就分不出首屏与查完为空，
  // 且「点重试」会先把失败提示抹掉。
  const start = HOOK_SOURCE.match(
    /setState\(\(current\) => \(\{ \.\.\.current, loading: true \}\)\);/,
  );
  assert.ok(start, "请求开始只应置 loading，不清 error、不动 loaded");
});
