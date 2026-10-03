/**
 * 左下角领取入口可见性 + 额度计划名称无关识别的回归测试（spec 131）。
 *
 * ## 为什么要钉住
 *
 * 用户反馈两条：
 * 1. 领取入口在聊天工作区"看不见"——claim 卡片此前只挂在设置页套餐详情，
 *    聊天 context 面板（左下角）没有任何领取/刷新入口，且触发器外层门控不含
 *    领取信号（有可领取活动但无其他额度数据时整块不渲染）。
 * 2. 官方把活动改名为 "ZCode Trust Build" 后，表示层按展示名匹配的分支
 *    （endsWith(" start plan") / /^start\s+plan$/i）立即失效。
 *
 * 本测试钉的是表示层契约：入口可见性只由 plans 是否非空决定；套餐身份只按
 * productId 的 start-plan 类型段判定；展示名是渲染数据、从不参与判据。
 * 真实浏览器里的 DOM 证据（触发器出现 + 领取卡片 + Trust Build 名称原样展示）
 * 见 harness（spec §6）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolveManualClaimPlanCardView } from "../src/settings/model-provider-section/ManualClaimPlanCard.js";
import { isStartPlanEntitlementProductId } from "../src/settings/model-provider-section/StatusCards.js";
import { resolveStartPlanPurchaseChoiceBannerTitle } from "../src/settings/model-provider-section/codingPlanProductPresentation.js";
import type { ManualClaimPlanPreview } from "@zcode/shared";

const CONTEXT_USAGE_SOURCE = readFileSync(
  new URL("../src/chat-input-toolbar/contextUsage.tsx", import.meta.url),
  "utf8",
);
const CARD_SOURCE = readFileSync(
  new URL("../src/settings/model-provider-section/ManualClaimPlanCard.tsx", import.meta.url),
  "utf8",
);
const HOOK_SOURCE = readFileSync(
  new URL("../src/settings/model-provider-section/useManualClaimPlan.ts", import.meta.url),
  "utf8",
);
const BALANCE_SOURCE = readFileSync(
  new URL("../src/chat-input-toolbar/StartPlanContextBalance.tsx", import.meta.url),
  "utf8",
);
const STATUS_CARDS_SOURCE = readFileSync(
  new URL("../src/settings/model-provider-section/StatusCards.tsx", import.meta.url),
  "utf8",
);

/** 官方本次活动的命名（服务端可随时再改）。 */
const TRUST_BUILD_PLAN: ManualClaimPlanPreview = {
  planId: "zcode-v3-start-plan-trust-build-0926",
  name: "ZCode Trust Build",
  description: "限时可领取",
  priority: 100,
  entitlements: [],
};

/** 中文名变体：判据里不得出现任何对展示名的匹配。 */
const CHINESE_NAMED_PLAN: ManualClaimPlanPreview = {
  ...TRUST_BUILD_PLAN,
  planId: "zcode-v3-start-plan-1020",
  name: "ZCode 信任构建",
};

test("入口可见性：有可领取活动即渲染入口，与展示名无关（Trust Build / 中文名同样命中）", () => {
  assert.equal(
    resolveManualClaimPlanCardView({
      plans: [TRUST_BUILD_PLAN],
      loaded: true,
      error: null,
      claimed: false,
    }),
    "plan",
  );
  assert.equal(
    resolveManualClaimPlanCardView({
      plans: [CHINESE_NAMED_PLAN],
      loaded: true,
      error: null,
      claimed: false,
    }),
    "plan",
  );
});

test("入口可见性：仅有领取活动时触发器也要出现（外层门控必须包含领取信号）", () => {
  // 无 context usage、无 Coding Plan、无 Start Plan 余额，但有可领取活动：
  // 面板不能整块消失，否则左下角没有任何入口。
  const gate = CONTEXT_USAGE_SOURCE.match(
    /!hasCodingPlanUsageRemaining &&\s*!hasStartPlanBalance &&\s*(\/\/[^\n]*\n\s*)?!hasStartPlanClaimEntry/,
  );
  assert.ok(gate, "外层门控必须包含领取信号 hasStartPlanClaimEntry");
  assert.ok(
    CONTEXT_USAGE_SOURCE.includes("useManualClaimPlan()"),
    "面板必须持有领取状态（门控与卡片共用一份）",
  );
  assert.ok(
    CONTEXT_USAGE_SOURCE.includes("<ManualClaimPlanCard"),
    "面板必须渲染领取卡片（复用设置页同一组件，不另造渲染路径）",
  );
});

test("刷新按钮：Start Plan 余额段必须提供显式刷新入口", () => {
  // 用户反馈"看不见刷新按钮"：此前余额只能 hover 隐式刷新。
  assert.ok(
    BALANCE_SOURCE.includes('id: "common.refresh"') && BALANCE_SOURCE.includes("onAccess"),
    "余额段标题栏需要显式刷新按钮并复用 onAccess 静默刷新链路",
  );
});

test("共享缓存：多消费者只发一次请求（in-flight 去重 + TTL），显式刷新绕过缓存", () => {
  assert.ok(
    HOOK_SOURCE.includes("loadManualClaimPreviewSnapshot"),
    "hook 必须有模块级共享快照加载函数",
  );
  assert.ok(
    HOOK_SOURCE.includes("MANUAL_CLAIM_PREVIEW_CACHE_TTL_MS"),
    "必须有显式 TTL 常量（60s）",
  );
  assert.ok(
    /const refresh = useCallback\(async \(\) => \{\s*await loadPreview\(\{ force: true \}\);/.test(
      HOOK_SOURCE,
    ),
    "refresh 必须强制绕过缓存（用户重试 / 领取成功后必须重取）",
  );
  assert.ok(
    /useEffect\(\(\) => \{\s*void loadPreview\(\);/.test(HOOK_SOURCE),
    "挂载时允许命中共享缓存（两个消费者不重复请求）",
  );
});

test("类型段识别：isStartPlanEntitlementProductId 按 plan_id 的类型段判定，不按展示名", () => {
  // 实测历史载荷（.reverse/08-entitlement/evidence）与本次改名后的形态。
  assert.equal(isStartPlanEntitlementProductId("zcode-v3-start-plan-0924-wk"), true);
  assert.equal(isStartPlanEntitlementProductId("zcode-v3-start-plan-wk-0918"), true);
  assert.equal(isStartPlanEntitlementProductId("zcode-v3-start-plan-trust-build-0926"), true);
  assert.equal(isStartPlanEntitlementProductId("start-plan"), true);
  // 同 provider 承载的付费 Coding Plan 无此类型段。
  assert.equal(isStartPlanEntitlementProductId("individual-coding-plan-pro"), false);
  assert.equal(isStartPlanEntitlementProductId(""), false);
});

test("名称无关护栏：StatusCards 不得再出现按展示名判定套餐身份的分支", () => {
  assert.ok(
    !STATUS_CARDS_SOURCE.includes("isStartPlanEntitlementName"),
    "isStartPlanEntitlementName 已被类型段判定 isStartPlanEntitlementProductId 取代",
  );
  assert.ok(
    !STATUS_CARDS_SOURCE.includes('endsWith(" start plan")'),
    "不得保留按展示名后缀匹配 Start Plan 的分支",
  );
});

test("banner 标题：远端名原样展示（名称无关），缺失才回落本地化文案", () => {
  const fallback = "体验套餐";
  assert.equal(
    resolveStartPlanPurchaseChoiceBannerTitle({
      fallbackTitle: fallback,
      remoteTitle: "ZCode Trust Build",
    }),
    "ZCode Trust Build",
  );
  assert.equal(
    resolveStartPlanPurchaseChoiceBannerTitle({ fallbackTitle: fallback, remoteTitle: "  " }),
    fallback,
  );
  assert.equal(resolveStartPlanPurchaseChoiceBannerTitle({ fallbackTitle: fallback }), fallback);
});

test("卡片渲染面护栏：领取卡片不得出现任何具体活动展示名（识别只走 planId/priority）", () => {
  // 注释里也不允许留具体活动名：展示名是服务端数据，源码任何位置出现它都是潜在耦合点。
  for (const token of ["Weekend", "Trust Build", "周末", "信任构建"]) {
    assert.ok(
      !CARD_SOURCE.includes(token),
      `ManualClaimPlanCard 源码不得出现展示名 \"${token}\"（识别与展示须名称无关）`,
    );
  }
  // 展示名是数据：卡片必须原样渲染 plan.name。
  assert.ok(CARD_SOURCE.includes("{plan.name}"), "套餐名必须原样渲染 plan.name");
});
