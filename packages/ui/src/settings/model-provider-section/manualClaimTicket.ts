/**
 * 领取成功票券的视图模型（纯函数，无 IO、无 React）。
 *
 * ## 为什么单独一个文件
 *
 * 票券上的「大数字 / 单位 / 权益行 / 有效期」不是服务端下发的字符串，而是客户端算出来的。
 * 官方那两张渲染物里各有一份同名实现，语义不同：
 *
 * - 横幅版（归档件 weekend-banner-bundle/47e73311.../quota.js）：按 unit_type 分组，
 *   组内一次性优先，不同单位不相加，credits 在中文下显示为「积分」；
 * - 票券版（同目录 d5f34e2c.../quota.js）：忽略 unit_type 硬编码 Tokens，且把不同单位相加。
 *
 * 本实现抄的是横幅版。票券版在混合单位下会把 3 亿 token 与 500 credits 加成
 * 300,000,500 Tokens，是退化行为，不采用。依据与实测对照见
 * .reverse/94-account-capability/BANNER-BUNDLE-ANALYSIS.md 第 3.3 节、
 * 规格 .reverse/94-account-capability/C-SUCCESS-TICKET.md 第 4、6 节。
 *
 * ## 状态所有者
 *
 * 本文件不持有状态：输入是 claim 前的套餐快照加 claim 结果里的 endsAt，
 * 输出是一次性的视图模型，由组件按 plan/endsAt/locale 派生。
 */
import type { ManualClaimPlanEntitlement, ManualClaimPlanPreview } from "@zcode/shared";

/** 一组同单位权益的合计，以及它在票券上的显示形态。 */
export interface ManualClaimQuota {
  /** 大数字。混合单位时是各组「缩写数量 + 单位」用 + 拼起来的结果。 */
  amountValue: string;
  /** 单位。混合单位时为空串，与官方横幅版一致（单位已经并进 amountValue）。 */
  amountUnit: string;
  /** 权益行：名称 · 缩写数量 单位。 */
  benefits: string[];
  mixed: boolean;
}

/** 生效时间行：只在权益尚未生效时才有内容。label 已按 locale 格式化。 */
export interface ManualClaimTicketEffectiveEntry {
  entitlementId: string;
  showName: string;
  label: string;
}

export interface ManualClaimTicketView {
  planName: string;
  amountValue: string;
  amountUnit: string;
  benefits: string[];
  effectiveAtEntries: ManualClaimTicketEffectiveEntry[];
  /** 有效期值。没有 endsAt 时为空串（调用方据此不渲染该行）。 */
  endsAtLabel: string;
}

/**
 * 单条权益是否计入合计。
 *
 * 协议层对 entitlements 没有结构约束（hero.args 是 unknown 透传），官方两份实现都是
 * 运行期防御式读取，这里保持一致：meter 必须是 model_usage、grant_units 必须是有限非负数、
 * period 必须在白名单内。不满足的一律丢弃，不猜测语义。
 */
function isCountableEntitlement(entitlement: ManualClaimPlanEntitlement): boolean {
  if (entitlement.meter !== "model_usage") {
    return false;
  }
  if (!Number.isFinite(entitlement.grantUnits) || entitlement.grantUnits < 0) {
    return false;
  }
  return entitlement.period === "one_time" || entitlement.period === "daily";
}

/**
 * unit_type 归一化。空值与非字符串回落 tokens；token/tokens、credit/credits 各自归并；
 * 其余原样保留（官方横幅版同样原样保留，未知单位因此不会被静默改成 tokens）。
 */
function normalizeUnit(unitType: string): string {
  const unit = unitType.trim();
  if (!unit) {
    return "tokens";
  }
  const lower = unit.toLowerCase();
  if (lower === "token" || lower === "tokens") {
    return "tokens";
  }
  if (lower === "credit" || lower === "credits") {
    return "credits";
  }
  return unit;
}

/** 单位标签：credits 在中文下是「积分」；按天计费的组追加「 / 天」或「 / day」。 */
function labelUnit(unit: string, daily: boolean, zh: boolean): string {
  const base = unit === "credits" && zh ? "积分" : unit;
  if (!daily) {
    return base;
  }
  return base + (zh ? " / 天" : " / day");
}

/**
 * 按官方横幅版算法算出票券上的数量与权益行。
 *
 * 分组语义：先按归一化后的 unit 分组（Map 保持首次出现顺序），组内一次性权益优先；
 * 组内没有任何一次性权益时才取按天权益，并给该组打上按天后缀。组内求和，组间不相加。
 */
export function resolveManualClaimQuota(
  entitlements: readonly ManualClaimPlanEntitlement[],
  locale: string,
): ManualClaimQuota {
  const zh = locale.toLowerCase().startsWith("zh");
  const compact = new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: 2,
  });
  const byUnit = new Map<string, ManualClaimPlanEntitlement[]>();
  for (const entitlement of entitlements) {
    if (!isCountableEntitlement(entitlement)) {
      continue;
    }
    const unit = normalizeUnit(entitlement.unitType);
    const values = byUnit.get(unit);
    if (values) {
      values.push(entitlement);
    } else {
      byUnit.set(unit, [entitlement]);
    }
  }
  const groups = [...byUnit].map(([unit, values]) => {
    const once = values.filter((entry) => entry.period === "one_time");
    const entries = once.length > 0 ? once : values.filter((entry) => entry.period === "daily");
    return {
      entries,
      total: entries.reduce((sum, entry) => sum + entry.grantUnits, 0),
      unit: labelUnit(unit, once.length === 0, zh),
    };
  });
  const mixed = groups.length > 1;
  return {
    amountValue: mixed
      ? groups.map((group) => compact.format(group.total) + " " + group.unit).join(" + ")
      : new Intl.NumberFormat(locale).format(groups[0]?.total ?? 0),
    amountUnit: mixed ? "" : (groups[0]?.unit ?? "tokens"),
    benefits: groups.flatMap((group) =>
      group.entries.map(
        (entry) => entry.showName + " · " + compact.format(entry.grantUnits) + " " + group.unit,
      ),
    ),
    mixed,
  };
}

/**
 * 组装票券视图模型。
 *
 * endsAt 的取值次序：claim 响应里的 endsAt 优先（那是服务端对这一次领取的确认），
 * 缺省回落到快照的 endsAt（preview 已经给了活动窗口）。
 *
 * nowMs 是毫秒时间戳（Date.now()）。生效时间行只在权益尚未生效时给出：
 * 已经生效还写「将于 X 生效」是假话，而标题行已经说了权益已生效。
 */
export function buildManualClaimTicket(input: {
  plan: ManualClaimPlanPreview;
  endsAt?: number;
  locale: string;
  nowMs: number;
}): ManualClaimTicketView {
  const quota = resolveManualClaimQuota(input.plan.entitlements, input.locale);
  const endsAt = input.endsAt ?? input.plan.endsAt;
  return {
    planName: input.plan.name,
    amountValue: quota.amountValue,
    amountUnit: quota.amountUnit,
    benefits: quota.benefits,
    effectiveAtEntries: input.plan.entitlements.flatMap((entitlement) => {
      const effectiveAt = entitlement.effectiveAt;
      if (typeof effectiveAt !== "number" || !Number.isFinite(effectiveAt)) {
        return [];
      }
      if (effectiveAt * 1000 <= input.nowMs) {
        return [];
      }
      return [
        {
          entitlementId: entitlement.entitlementId,
          showName: entitlement.showName,
          label: new Date(effectiveAt * 1000).toLocaleString(input.locale),
        },
      ];
    }),
    endsAtLabel:
      typeof endsAt === "number" && Number.isFinite(endsAt)
        ? new Date(endsAt * 1000).toLocaleString(input.locale)
        : "",
  };
}
