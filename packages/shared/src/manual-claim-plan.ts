/**
 * 手动领取（周末 / 体验套餐）协议类型。
 *
 * 背景：官方 3.12+ 客户端有一条独立于「购买」的 claim 平面：
 *   - GET  /api/v1/zcode-plan/billing/preview?app_version=&platform=  列出当前可领取套餐
 *   - POST /api/v1/zcode-plan/billing/claim   body {plan_id}          领取指定套餐
 * CE 原先完全没有这条链路（全仓 0 命中），导致周末/体验套餐在 CE 侧不可见、不可领。
 * 本文件只承载协议类型与纯函数（失败分类、响应归一化），保持与运行时无关，
 * 便于 UI / services / RPC 共用同一份契约。
 *
 * 失败分类与服务端 biz code 的对应关系来自官方客户端的失败码映射表：
 * 1001 notFound / 1002 unavailable / 1003 alreadyClaimed / 1004 ineligible /
 * 1005 quotaExhausted / 3001 invalidRequest / 3007 captcha / 401 loginRequired。
 */

/** 可领取套餐内的一项权益（服务端 snake_case 归一化后的形态）。 */
export interface ManualClaimPlanEntitlement {
  entitlementId: string;
  showName: string;
  meter: string;
  unitType: string;
  capabilities: string[];
  grantUnits: number;
  period: string;
  priority: number;
  /** Unix 秒；周末套餐常在窗口开启后才生效，因此会晚于领取时刻。 */
  effectiveAt?: number;
}

/** `GET /api/v1/zcode-plan/billing/preview` 返回的一个可领取套餐。 */
export interface ManualClaimPlanPreview {
  planId: string;
  name: string;
  description: string;
  priority: number;
  entitlements: ManualClaimPlanEntitlement[];
  /** Unix 秒。 */
  startsAt?: number;
  /** Unix 秒。 */
  endsAt?: number;
}

/**
 * 领取失败类型。用稳定枚举而不是错误文案做流程判断：
 * UI 需要按类型给不同文案与不同后续动作（重新验证码 / 提示已领取 / 提示登录）。
 */
export type ManualClaimFailureKind =
  | "not_found"
  | "unavailable"
  | "already_claimed"
  | "ineligible"
  | "quota_exhausted"
  | "invalid_request"
  | "captcha"
  | "captcha_unavailable"
  | "login_required"
  | "http_error"
  | "network"
  | "unknown";

/** 领取结果：成功带生效窗口，失败带可归因的失败类型与重试窗口。 */
export type ManualClaimPlanClaimOutcome =
  | { ok: true; planId: string; startsAt?: number; endsAt?: number }
  | {
      ok: false;
      planId: string;
      failureKind: ManualClaimFailureKind;
      code: number | string;
      message: string;
      /** Unix 秒：下次可尝试的时间点（服务端下发时才有）。 */
      failureEndsAt?: number;
    };

/** 阿里云验证码配置：UI 用它初始化验证码组件，服务层用它校验凭据。 */
export interface ManualClaimCaptchaConfig {
  /** 活动是否开启验证码。false 时 claim 不校验验证码头。 */
  enabled: boolean;
  /** 阿里云验证码 prefix（initAliyunCaptcha 的 prefix 参数）。 */
  prefix: string;
  /** 阿里云验证码 sceneId。 */
  sceneId: string;
  /** 阿里云验证码 region（如 `sgp`），必须随凭据一起发送。 */
  region: string;
}

/** 一次求解得到的验证码凭据：verifyParam 必需，region 缺省时回落到配置。 */
export interface ManualClaimCaptchaSolution {
  verifyParam: string;
  region?: string;
}

/**
 * 领取请求。
 *
 * `captcha` 可选：桌面端把官方验证码 JS 跑在内嵌 WebView 里，由 UI 直接把
 * verifyParam 传进来（主路径）；缺省时服务层退回本端求解器（当前 CE 未接入，
 * 会返回可读的 `manual_claim_captcha_solver_unavailable` 失败）。
 */
export interface ManualClaimPlanClaimRequest {
  planId: string;
  captcha?: {
    verifyParam: string;
    region?: string;
  };
}

/**
 * 验证码相关失败码。
 *
 * 为什么用字符串码而不是抛异常：claim 的返回类型已经用
 * `ManualClaimPlanClaimOutcome` 表达失败，验证码不可用属于「本次领取没做成」的
 * 一种，复用同一返回通道可以让 UI 只处理一条分支；异常只留给真正的编程错误。
 */
export const MANUAL_CLAIM_CAPTCHA_SOLVER_UNAVAILABLE =
  "manual_claim_captcha_solver_unavailable" as const;
export const MANUAL_CLAIM_CAPTCHA_DISABLED = "manual_claim_captcha_disabled" as const;
export const MANUAL_CLAIM_CAPTCHA_CONFIG_UNAVAILABLE =
  "manual_claim_captcha_config_unavailable" as const;
export const MANUAL_CLAIM_CAPTCHA_REQUIRED = "manual_claim_captcha_required" as const;

/** 服务端 biz code → 客户端失败类型。 */
export function classifyManualClaimCode(code: number | string | undefined): ManualClaimFailureKind {
  const numeric =
    typeof code === "string"
      ? Number.parseInt(code, 10)
      : typeof code === "number"
        ? code
        : Number.NaN;
  switch (numeric) {
    case 1001:
      return "not_found";
    case 1002:
      return "unavailable";
    case 1003:
      return "already_claimed";
    case 1004:
      return "ineligible";
    case 1005:
      return "quota_exhausted";
    case 3001:
      return "invalid_request";
    case 3007:
      return "captcha";
    case 401:
      return "login_required";
    default:
      return "unknown";
  }
}

/**
 * 领取失败的统一文案 key。UI 侧按 key 做本地化，避免把服务端中文/英文原文
 * 直接透传到界面（服务端文案会变，且不保证与 CE 语言一致）。
 */
export const MANUAL_CLAIM_FAILURE_MESSAGE_KEYS: Record<ManualClaimFailureKind, string> = {
  not_found: "manual_claim_failure_not_found",
  unavailable: "manual_claim_failure_unavailable",
  already_claimed: "manual_claim_failure_already_claimed",
  ineligible: "manual_claim_failure_ineligible",
  quota_exhausted: "manual_claim_failure_quota_exhausted",
  invalid_request: "manual_claim_failure_invalid_request",
  captcha: "manual_claim_failure_captcha",
  captcha_unavailable: "manual_claim_failure_captcha_unavailable",
  login_required: "manual_claim_failure_login_required",
  http_error: "manual_claim_failure_http_error",
  network: "manual_claim_failure_network",
  unknown: "manual_claim_failure_unknown",
};

interface RawManualClaimEntitlement {
  entitlement_id?: unknown;
  show_name?: unknown;
  meter?: unknown;
  unit_type?: unknown;
  capabilities?: unknown;
  grant_units?: unknown;
  period?: unknown;
  priority?: unknown;
  effective_at?: unknown;
}

interface RawManualClaimPlan {
  plan_id?: unknown;
  name?: unknown;
  description?: unknown;
  priority?: unknown;
  entitlements?: unknown;
  starts_at?: unknown;
  ends_at?: unknown;
}

function readTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function parseManualClaimEntitlement(raw: unknown): ManualClaimPlanEntitlement | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const source = raw as RawManualClaimEntitlement;
  const entitlementId = readTrimmedString(source.entitlement_id);
  if (!entitlementId) {
    return null;
  }
  const entitlement: ManualClaimPlanEntitlement = {
    entitlementId,
    showName: readTrimmedString(source.show_name),
    meter: readTrimmedString(source.meter),
    unitType: readTrimmedString(source.unit_type),
    capabilities: readStringArray(source.capabilities),
    grantUnits: readFiniteNumber(source.grant_units) ?? 0,
    period: readTrimmedString(source.period),
    priority: readFiniteNumber(source.priority) ?? 0,
  };
  const effectiveAt = readFiniteNumber(source.effective_at);
  if (effectiveAt !== undefined) {
    entitlement.effectiveAt = effectiveAt;
  }
  return entitlement;
}

/**
 * 归一化单个可领取套餐。缺少 plan_id 视为脏数据丢弃（返回 null）：
 * 没有 planId 就无法调用 claim，保留只会让 UI 渲染出一个点了必然失败的空卡片。
 */
export function parseManualClaimPlanPreview(raw: unknown): ManualClaimPlanPreview | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const source = raw as RawManualClaimPlan;
  const planId = readTrimmedString(source.plan_id);
  if (!planId) {
    return null;
  }
  const entitlements = Array.isArray(source.entitlements)
    ? source.entitlements.flatMap((entry) => {
        const parsed = parseManualClaimEntitlement(entry);
        return parsed ? [parsed] : [];
      })
    : [];
  const plan: ManualClaimPlanPreview = {
    planId,
    name: readTrimmedString(source.name) || planId,
    description: readTrimmedString(source.description),
    priority: readFiniteNumber(source.priority) ?? 0,
    entitlements,
  };
  const startsAt = readFiniteNumber(source.starts_at);
  if (startsAt !== undefined) {
    plan.startsAt = startsAt;
  }
  const endsAt = readFiniteNumber(source.ends_at);
  if (endsAt !== undefined) {
    plan.endsAt = endsAt;
  }
  return plan;
}

/** 归一化 preview 响应里的 plans 数组；脏条目逐条丢弃，不影响其余套餐。 */
export function parseManualClaimPlanPreviews(data: unknown): ManualClaimPlanPreview[] {
  if (!data || typeof data !== "object") {
    return [];
  }
  const plans = (data as { plans?: unknown }).plans;
  if (!Array.isArray(plans)) {
    return [];
  }
  return plans.flatMap((plan) => {
    const parsed = parseManualClaimPlanPreview(plan);
    return parsed ? [parsed] : [];
  });
}

/**
 * 选取默认领取目标：planId 命中则优先，否则取 priority 最高者。
 * 与官方客户端一致——服务端可能一次下发多个套餐，priority 是唯一排序依据。
 */
export function pickManualClaimPlan(
  plans: ManualClaimPlanPreview[],
  planId?: string,
): ManualClaimPlanPreview | null {
  const wanted = planId?.trim();
  if (wanted) {
    return plans.find((plan) => plan.planId === wanted) ?? null;
  }
  return [...plans].sort((a, b) => b.priority - a.priority)[0] ?? null;
}
