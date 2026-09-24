import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ManualClaimPlanEntitlement, ManualClaimPlanPreview } from "@zcode/shared";
import {
  buildManualClaimTicket,
  resolveManualClaimQuota,
} from "../src/settings/model-provider-section/manualClaimTicket.js";
import { resolveManualClaimPlanCardView } from "../src/settings/model-provider-section/ManualClaimPlanCard.js";

/**
 * 领取成功票券的判据（task-110）。
 *
 * ## 为什么这些断言必须有牙齿
 *
 * 票券上的数字、单位与权益行是客户端算出来的，官方两份渲染物各有一版语义不同的实现：
 * 横幅版按 unit_type 分组、不同单位不相加；票券版硬编码 Tokens 且把不同单位相加。
 * 抄错一版的后果是用户看到 300,000,500 Tokens 这种把积分当 token 加出来的数字 ——
 * 类型检查、lint 与手测都发现不了，只能靠断言钉住。
 *
 * ## 与真浏览器证据的关系
 *
 * 这里钉的是纯函数输出、四态分界与源码形态。真浏览器里渲染产品组件本身、
 * 读票券实际 DOM 文本的证据见 .reverse/94-account-capability/harness/
 * （vite build + node probe-ticket.mjs），规格见 .reverse/94-account-capability/C-SUCCESS-TICKET.md。
 */

const here = fileURLToPath(new URL("../", import.meta.url));

function readSource(relativePath: string): string {
  return readFileSync(resolve(here, relativePath), "utf8");
}

/** 真实载荷（~/.zcode/v2/logs/2026-09-24.log:4172-4173，用户 claim 当时）的归一化形态。 */
const WEEKEND_PLAN: ManualClaimPlanPreview = {
  planId: "zcode-v3-start-plan-0924-wk",
  name: "ZCode Weekend Build",
  description: "ZCode 周末活动",
  priority: 100,
  startsAt: 1790261749,
  endsAt: 1790557200,
  entitlements: [
    {
      entitlementId: "ent-zcode-v3-start-plan-0924-wk-1",
      showName: "GLM-5.3-Flash",
      meter: "model_usage",
      unitType: "token",
      capabilities: ["model:glm-5.3-flash"],
      grantUnits: 300000000,
      period: "one_time",
      priority: 110,
      effectiveAt: 1790262000,
    },
  ],
};

function entitlement(
  overrides: Partial<ManualClaimPlanEntitlement> & { entitlementId: string },
): ManualClaimPlanEntitlement {
  return {
    showName: "GLM-5.3-Flash",
    meter: "model_usage",
    unitType: "token",
    capabilities: [],
    grantUnits: 100,
    period: "one_time",
    priority: 0,
    ...overrides,
  };
}

const MIXED_UNITS: ManualClaimPlanEntitlement[] = [
  entitlement({ entitlementId: "e-token", grantUnits: 300000000 }),
  entitlement({
    entitlementId: "e-credit",
    showName: "Bonus Credits",
    unitType: "credits",
    grantUnits: 500,
  }),
];

test("判据 1：真实周末载荷的数量与权益行与官方横幅版一致（中英各一遍）", () => {
  assert.deepEqual(resolveManualClaimQuota(WEEKEND_PLAN.entitlements, "zh-CN"), {
    amountValue: "300,000,000",
    amountUnit: "tokens",
    benefits: ["GLM-5.3-Flash · 3亿 tokens"],
    mixed: false,
  });
  assert.deepEqual(resolveManualClaimQuota(WEEKEND_PLAN.entitlements, "en-US"), {
    amountValue: "300,000,000",
    amountUnit: "tokens",
    benefits: ["GLM-5.3-Flash · 300M tokens"],
    mixed: false,
  });
});

test("判据 2：混合单位按单位分组、不相加，credits 在中文下是积分", () => {
  // 票券版算法在这里会给出 300,000,500 Tokens（把 500 积分当 token 加），是退化行为。
  assert.deepEqual(resolveManualClaimQuota(MIXED_UNITS, "zh-CN"), {
    amountValue: "3亿 tokens + 500 积分",
    amountUnit: "",
    benefits: ["GLM-5.3-Flash · 3亿 tokens", "Bonus Credits · 500 积分"],
    mixed: true,
  });
  assert.deepEqual(resolveManualClaimQuota(MIXED_UNITS, "en-US"), {
    amountValue: "300M tokens + 500 credits",
    amountUnit: "",
    benefits: ["GLM-5.3-Flash · 300M tokens", "Bonus Credits · 500 credits"],
    mixed: true,
  });
  // 反面判据：不得出现把两组数字相加的结果。
  for (const locale of ["zh-CN", "en-US"]) {
    const quota = resolveManualClaimQuota(MIXED_UNITS, locale);
    assert.equal(
      quota.amountValue.includes("300,000,500"),
      false,
      "混合单位被相加了 —— 这是票券版算法的退化行为，不是官方横幅版",
    );
  }
});

test("判据 3：credits 单组在中文下是积分、英文下是 credits", () => {
  const credits = [
    entitlement({ entitlementId: "e-credit", unitType: "credits", grantUnits: 1200 }),
  ];
  assert.equal(resolveManualClaimQuota(credits, "zh-CN").amountUnit, "积分");
  assert.equal(resolveManualClaimQuota(credits, "zh-CN").amountValue, "1,200");
  assert.equal(resolveManualClaimQuota(credits, "en-US").amountUnit, "credits");
});

test("判据 4：按天权益求和并带「 / 天」后缀；组内一次性优先于按天", () => {
  const daily = [
    entitlement({ entitlementId: "d1", showName: "GLM-5.3", grantUnits: 3000000, period: "daily" }),
    entitlement({ entitlementId: "d2", grantUnits: 5000000, period: "daily" }),
  ];
  assert.deepEqual(resolveManualClaimQuota(daily, "zh-CN"), {
    amountValue: "8,000,000",
    amountUnit: "tokens / 天",
    benefits: ["GLM-5.3 · 300万 tokens / 天", "GLM-5.3-Flash · 500万 tokens / 天"],
    mixed: false,
  });
  assert.equal(resolveManualClaimQuota(daily, "en-US").amountUnit, "tokens / day");

  // 同一单位里既有一次性又有按天：组内只算一次性（官方横幅版口径）。
  const both = [
    entitlement({ entitlementId: "o1", grantUnits: 100 }),
    entitlement({ entitlementId: "d3", grantUnits: 999, period: "daily" }),
  ];
  const quota = resolveManualClaimQuota(both, "en-US");
  assert.equal(quota.amountValue, "100");
  assert.equal(quota.amountUnit, "tokens");
  assert.deepEqual(quota.benefits, ["GLM-5.3-Flash · 100 tokens"]);
});

test("判据 5：脏权益被丢弃（meter / period / grant_units 三道白名单）", () => {
  const dirty = [
    entitlement({ entitlementId: "keep", grantUnits: 7 }),
    entitlement({ entitlementId: "meter", meter: "mcp_usage", grantUnits: 100 }),
    entitlement({ entitlementId: "period", period: "weekly", grantUnits: 100 }),
    entitlement({ entitlementId: "negative", grantUnits: -5 }),
    entitlement({ entitlementId: "nan", grantUnits: Number.NaN }),
  ];
  const quota = resolveManualClaimQuota(dirty, "en-US");
  assert.equal(quota.amountValue, "7");
  assert.deepEqual(quota.benefits, ["GLM-5.3-Flash · 7 tokens"]);
});

test("判据 6：空权益给 0 + tokens、无权益行（与官方横幅版一致）", () => {
  assert.deepEqual(resolveManualClaimQuota([], "zh-CN"), {
    amountValue: "0",
    amountUnit: "tokens",
    benefits: [],
    mixed: false,
  });
});

test("判据 7：视图模型取 claim 响应的 endsAt 优先、回落快照；有效期按 locale 格式化", () => {
  const zh = buildManualClaimTicket({
    plan: WEEKEND_PLAN,
    endsAt: 1790557200,
    locale: "zh-CN",
    nowMs: 1790262000 * 1000,
  });
  assert.equal(zh.planName, "ZCode Weekend Build");
  assert.equal(zh.endsAtLabel, new Date(1790557200 * 1000).toLocaleString("zh-CN"));
  const en = buildManualClaimTicket({
    plan: WEEKEND_PLAN,
    endsAt: 1790557200,
    locale: "en-US",
    nowMs: 1790262000 * 1000,
  });
  assert.equal(en.endsAtLabel, new Date(1790557200 * 1000).toLocaleString("en-US"));

  // claim 响应没给 endsAt 时回落到快照的 endsAt，而不是显示空。
  const fallback = buildManualClaimTicket({
    plan: WEEKEND_PLAN,
    locale: "en-US",
    nowMs: 0,
  });
  assert.equal(fallback.endsAtLabel, new Date(1790557200 * 1000).toLocaleString("en-US"));

  // 两处都没有时不编造占位符（官方会画破折号，我们不引入这个字符）。
  const noWindow = buildManualClaimTicket({
    plan: { ...WEEKEND_PLAN, endsAt: undefined },
    locale: "en-US",
    nowMs: 0,
  });
  assert.equal(noWindow.endsAtLabel, "");
});

test("判据 8：生效时间行只在权益尚未生效时给出", () => {
  const before = buildManualClaimTicket({
    plan: WEEKEND_PLAN,
    locale: "zh-CN",
    // effective_at = 1790262000，此刻还没到。
    nowMs: 1790262000 * 1000 - 1,
  });
  assert.deepEqual(
    before.effectiveAtEntries.map((entry) => entry.entitlementId),
    ["ent-zcode-v3-start-plan-0924-wk-1"],
  );
  const after = buildManualClaimTicket({
    plan: WEEKEND_PLAN,
    locale: "zh-CN",
    nowMs: 1790262000 * 1000,
  });
  assert.deepEqual(after.effectiveAtEntries, [], "已经生效还写「将于 X 生效」是假话");
});

test("判据 9：四态分界 —— 领取成功优先于其余三态（活动消失/刷新失败都不许退回）", () => {
  // 成功之后活动从列表消失（plans 为空、无 error）：必须是票券，不能是 hidden。
  assert.equal(
    resolveManualClaimPlanCardView({ plans: [], loaded: true, error: null, claimed: true }),
    "ticket",
  );
  // 成功之后刷新失败（plans 为空且有 error）：必须是票券，不能把成功说成加载失败。
  assert.equal(
    resolveManualClaimPlanCardView({
      plans: [],
      loaded: true,
      error: "network down",
      claimed: true,
    }),
    "ticket",
  );
  // 未成功时三态判据不变。
  assert.equal(
    resolveManualClaimPlanCardView({ plans: [], loaded: true, error: null, claimed: false }),
    "hidden",
  );
  assert.equal(
    resolveManualClaimPlanCardView({ plans: [], loaded: true, error: "x", claimed: false }),
    "load-failed",
  );
  assert.equal(
    resolveManualClaimPlanCardView({
      plans: [WEEKEND_PLAN],
      loaded: true,
      error: null,
      claimed: false,
    }),
    "plan",
  );
});

test("判据 10 的源码护栏：票券快照必须在 refresh() 之前取（否则活动消失后没数据）", () => {
  const hook = readSource("src/settings/model-provider-section/useManualClaimPlan.ts");
  const claimBody = hook.slice(hook.indexOf("const claim = useCallback"));
  const snapshotIndex = claimBody.indexOf("pickManualClaimPlan(plans, request.planId)");
  const refreshIndex = claimBody.indexOf("await refresh();");
  assert.ok(snapshotIndex >= 0, "claim 里必须按 planId 取快照（pickManualClaimPlan）");
  assert.ok(refreshIndex >= 0, "成功分支必须仍然 refresh()");
  assert.ok(
    snapshotIndex < refreshIndex,
    "快照必须在 refresh() 之前取：领取成功后活动可能已从列表消失，那时再取就是空的",
  );
  // 快照不得从刷新后的 plans 现取：它必须是 hook 持有的状态字段。
  assert.match(hook, /claimedPlan: ManualClaimPlanPreview \| null;/);
  assert.match(hook, /resetOutcome[\s\S]{0,200}claimedPlan: null/);
});

test("判据 11 的文案护栏：票券四条文案中英齐备，且沿用既有成功文案作为标题", () => {
  const zhCN = readSource("src/i18n/locales/zh-CN.ts");
  const enUS = readSource("src/i18n/locales/en-US.ts");
  for (const key of [
    "settings.modelProvider.manualClaim.ticket.validUntil",
    "settings.modelProvider.manualClaim.ticket.replay",
    "settings.modelProvider.manualClaim.ticket.dismiss",
    "settings.modelProvider.manualClaim.ticket.effectiveAt",
  ]) {
    assert.ok(zhCN.includes('"' + key + '"'), "zh-CN 缺少文案：" + key);
    assert.ok(enUS.includes('"' + key + '"'), "en-US 缺少文案：" + key);
  }
  // 前缀与重播标签与官方横幅渲染物的口径一致。
  assert.ok(zhCN.includes('"settings.modelProvider.manualClaim.ticket.validUntil": "有效期至"'));
  assert.ok(enUS.includes('"settings.modelProvider.manualClaim.ticket.validUntil": "Valid until"'));
  assert.ok(zhCN.includes('"settings.modelProvider.manualClaim.ticket.replay": "重播"'));
  assert.ok(enUS.includes('"settings.modelProvider.manualClaim.ticket.replay": "Replay"'));
  // 不带占位符的三条不得残留 {name}/{time}。
  const ticket = readSource("src/settings/model-provider-section/ManualClaimTicketCard.tsx");
  assert.match(
    ticket,
    /id: "settings.modelProvider.manualClaim.success"/,
    "票券标题复用既有成功文案，不新增第二条同义 key",
  );
});

/**
 * 与官方归档件的逐条对照。
 *
 * 为什么在测试里直接跑官方那份 quota.js：只对照「我抄下来的期望值」证明不了等价 ——
 * 期望值本身可能抄错。这里读归档原文求值，比的是同一批载荷下的两份真实输出。
 *
 * 归档件在 .reverse/ 下（该目录不进 CI 的 git 索引），因此缺失时显式 skip，
 * 不静默通过：上面判据 1 到 6 的期望值就是这条对照的固化结果，CI 上仍然有牙齿。
 */
const OFFICIAL_QUOTA = resolve(
  here,
  "../../.reverse/94-account-capability/weekend-banner-bundle/47e733112e863678220ea40e211823a1b88e322b8efd6e9c6a1451d746b7245d/quota.js",
);

test(
  "判据 12：与官方横幅版 quota.js 在同一批载荷上逐条一致",
  { skip: !existsSync(OFFICIAL_QUOTA) },
  () => {
    const source = readFileSync(OFFICIAL_QUOTA, "utf8");
    const official = new Function(source + "; return resolveMarketingQuota;")() as (
      data: unknown,
      locale: string,
    ) => { amountValue: string; amountUnit: string; benefits: string[]; mixed: boolean };
    const payloads: { name: string; entitlements: ManualClaimPlanEntitlement[] }[] = [
      { name: "weekend", entitlements: WEEKEND_PLAN.entitlements },
      { name: "mixed", entitlements: MIXED_UNITS },
      {
        name: "credits",
        entitlements: [entitlement({ entitlementId: "c", unitType: "credits", grantUnits: 1200 })],
      },
      {
        name: "daily",
        entitlements: [
          entitlement({
            entitlementId: "d1",
            showName: "GLM-5.3",
            grantUnits: 3000000,
            period: "daily",
          }),
          entitlement({ entitlementId: "d2", grantUnits: 5000000, period: "daily" }),
        ],
      },
      { name: "empty", entitlements: [] },
      {
        name: "dirty",
        entitlements: [
          entitlement({ entitlementId: "keep", grantUnits: 7 }),
          entitlement({ entitlementId: "meter", meter: "mcp_usage", grantUnits: 100 }),
          entitlement({ entitlementId: "period", period: "weekly", grantUnits: 100 }),
          entitlement({ entitlementId: "negative", grantUnits: -5 }),
        ],
      },
    ];
    for (const locale of ["zh-CN", "en-US"]) {
      for (const payload of payloads) {
        // 官方读的是服务端原始 snake_case 载荷；这里按同形还原，保证比的是同一份输入。
        const raw = {
          zcode_plan: {
            entitlements: payload.entitlements.map((entry) => ({
              show_name: entry.showName,
              meter: entry.meter,
              unit_type: entry.unitType,
              grant_units: entry.grantUnits,
              period: entry.period,
            })),
          },
        };
        const expected = official(raw, locale);
        const actual = resolveManualClaimQuota(payload.entitlements, locale);
        assert.deepEqual(
          {
            amountValue: actual.amountValue,
            amountUnit: actual.amountUnit,
            benefits: actual.benefits,
            mixed: actual.mixed,
          },
          {
            amountValue: expected.amountValue,
            amountUnit: expected.amountUnit,
            benefits: expected.benefits,
            mixed: expected.mixed,
          },
          locale + " / " + payload.name + " 与官方横幅版输出不一致",
        );
      }
    }
  },
);
