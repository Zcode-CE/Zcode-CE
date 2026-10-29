/**
 * 请求验证（阿里云无痕验证码）在 UI 侧的判别与动作口径。
 *
 * 这个模块原先是一个空桩：CE 从 3.14.3 起没有「请求安全版」实现，3007 只当作普通业务错误，
 * 文案写成「网关安全校验拒绝」，也没有重试入口。3.16.3 官方把它接成三件套：
 * ① 3007 → 验证码语义；② 失败文案「验证码校验失败，请重试」；③ 重试动作。
 *
 * 本文件只做 ① 的结构化判别（按业务码，不按错误文案——AGENTS「不依赖错误文本做流程判断」），
 * 文案与按钮在 i18n 与 ChatErrorBanner 侧。真实求解链在 providerRuntimeHeaders*（start-plan 自动
 * 重试一次）；这里的动作只覆盖「自动重试后仍失败」的手动入口。
 */

export const REQUEST_VERIFICATION_REJECTED_MESSAGE = "验证码校验失败，请重试。";

/** 3007 = 阿里云无痕验证被拒（官方常量 x4s="3007"）。 */
const REQUEST_VERIFICATION_BUSINESS_CODE = "3007" as const;

export function resolveRequestVerificationBusinessCode(
  code: string | undefined,
  _message: string | undefined,
): "3007" | undefined {
  // 只认结构化业务码：UI 层拿到的 code 已经由 normalizeZCodeUiError 从 provider_code=xxxx 归一提炼。
  return code === REQUEST_VERIFICATION_BUSINESS_CODE
    ? REQUEST_VERIFICATION_BUSINESS_CODE
    : undefined;
}

export function isRequestVerificationTerminalError(
  error: { code?: string; message?: string } | null | undefined,
): boolean {
  return resolveRequestVerificationBusinessCode(error?.code, error?.message) !== undefined;
}

/**
 * 文案判定保持关闭：官方在 3.16.3 用「请完成安全验证 / security verification」兜底，
 * 但本项目要求按稳定码分流；没有样本证明存在「只有文案、没有 3007」的形态。
 */
export function isRequestVerificationRejectedMessage(_message: string | undefined): boolean {
  return false;
}

/** 手动重试动作：让宿主重新发起该轮（会走新的验证码求解）。 */
export const requestVerificationRecoveryAction = "retry-captcha" as const;
export type RequestVerificationRecoveryAction = typeof requestVerificationRecoveryAction;

export const requestVerificationActionMessages: Record<RequestVerificationRecoveryAction, string> =
  {
    "retry-captcha": "chat.error.action.retryCaptcha",
  };

export const requestVerificationErrorAttribution = {};

export const requestVerificationClaimFailureMessageId = "manual_claim_failure_captcha";

export const additionalRequestModalSelectors: readonly string[] = [];
