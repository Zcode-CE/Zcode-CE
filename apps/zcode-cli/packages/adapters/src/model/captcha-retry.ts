import type { ProviderRuntimeHeadersRequestReason } from "@zcode/contracts";
import { inspectProviderFailure } from "./failure-classifier.js";
import type { AiSdkModelTextRequest, ResolvedAiSdkModel } from "./runner-runtime.js";

/**
 * start-plan（官方赠送额度）渠道的 3007 验证码挑战单次重试。
 *
 * 背景（docs/development/126-start-plan-3007-root-cause.md §1）：3007 不是鉴权失败，是
 * `zcode.z.ai/api/v1/zcode-plan/anthropic` 网关对 start-plan 启用的阿里云无痕验证挑战。
 * 官方客户端为此建了三段式链路，本模块负责第三段（agent 侧）。
 *
 * 为什么单独成模块（而不是并入 failure-provider-business-codes.ts 或
 * provider-finish-business-error.ts）：
 * - 官方 3.14.3 把 `isCaptchaRejection` 与 `CaptchaRequestRetry` 放在同一个模块
 *   （zcode.cjs @4013800 的 `uOe` / `$0e` 紧邻声明），本模块对齐这一模块边界。
 * - `failure-provider-business-codes.ts` 是「业务码 → reason/retryable」的码表，
 *   与官方开源检出逐字一致；把挑战重试策略塞进码表会让「码表」承担第二职责。
 * - `provider-finish-business-error.ts` 是 finish/error chunk 的业务错误探测器，
 *   它只回答「这是不是业务错误」，不回答「该不该重试」。
 *
 * 拦截点在分类器之前（spec §4.5 r4 订正）：3007 在码表里仍是
 * `AuthFailed + retryable:false`（官方亦如此），本模块不修改分类结果，而是在
 * 「是否重试」的判定处提前认领，命中则 `continue` 重试一次。
 */

/** 网关验证码挑战的业务码（阿里云无痕验证被拒）。与官方常量 `x4s="3007"` 同值。 */
export const CAPTCHA_REJECTION_PROVIDER_CODE = "3007";

/**
 * 该机制只对 start-plan 生效（官方 `claim()` 的 `accountAccess?.mode!=="start-plan"` 短路）。
 * 只有 start-plan 的 baseUrl 指向启用风控的 zcode-plan 网关，其它 account provider
 * （individual / team / off-peak）与自建 provider 都不触发。
 */
const CAPTCHA_RETRY_ACCOUNT_MODE = "start-plan";

/**
 * 该失败是不是「验证码挑战被拒」。
 *
 * 判据与官方 `isCaptchaRejection(e) => iG(e).providerErrorCode === "3007"` 逐字对应：
 * `inspectProviderFailure` 就是 CE 侧的 `iG`（同一函数在 runner 的重试闸门处与官方
 * `iG($).providerErrorCode` 对位），因此 3007 的三种来源都能识别：
 * ① `ProviderBusinessError`（含 SSE error chunk / finish chunk 合成）；
 * ② AI SDK `APICallError.data.error.code`（经码表确认过的业务码）；
 * ③ 非 2xx 响应体里的 `{"code":3007}`（in-body 变体，用户实际命中的形态，见 126 §2.6）。
 */
export function isCaptchaRejection(error: unknown): boolean {
  return inspectProviderFailure(error).providerErrorCode === CAPTCHA_REJECTION_PROVIDER_CODE;
}

/**
 * 3007 重试额度（spec §3：「agent 侧请求作用域对象，每次模型请求新建，不跨请求复用」）。
 *
 * 与官方 `CaptchaRequestRetry`（zcode.cjs @4013648）语义逐条对齐：
 * - `claim()` 命中即置 `used`，因此每个模型请求最多重试一次；
 * - 命中后置 `pending`，下一次 attempt 的 `takeReason()` 才返回 `"captcha-retry"`
 *   （渲染层据此重新求解验证码，而不是复用旧 token）；
 * - `extraAttempts` 并入重试预算（`maxAttempts + extraAttempts`），重试 attempt 不消耗
 *   常规重试预算，因此不会挤掉普通瞬态失败的重试机会。
 */
export class CaptchaRequestRetry {
  private used = false;
  private pending = false;

  constructor(
    private readonly request: AiSdkModelTextRequest,
    private readonly model: ResolvedAiSdkModel,
  ) {}

  /** 额外额度：只可能 0 或 1（`used` 一旦为真就不再变化）。 */
  get extraAttempts(): number {
    return this.used ? 1 : 0;
  }

  /**
   * 本次 attempt 刷新运行时请求头时该用的 reason。
   *
   * 每次 attempt 开头都必须调用（即使不重试）：它同时负责清掉 `pending`，
   * 保证 `captcha-retry` 只被消费一次。
   */
  takeReason(): ProviderRuntimeHeadersRequestReason {
    const reason: ProviderRuntimeHeadersRequestReason = this.pending
      ? "captcha-retry"
      : "model-request";
    this.pending = false;
    return reason;
  }

  /**
   * 认领本次 3007 重试额度。
   *
   * `skip` 的语义是「本次失败形态不允许重试」——由调用方按官方口径传入
   * （generate：请求还没发出去；stream：已发出可见输出 / 已在 compact 的 response_body 阶段，
   * 重放会重复用户可见内容）。
   */
  claim(error: unknown, skip = false): boolean {
    if (
      skip ||
      this.used ||
      this.request.abortSignal?.aborted ||
      // 没有刷新端口时重试也拿不到新 token，认领只会白费一次物理请求。
      !this.request.refreshRuntimeHeadersBeforeAttempt ||
      this.model.accountAccess?.mode !== CAPTCHA_RETRY_ACCOUNT_MODE ||
      !isCaptchaRejection(error)
    ) {
      return false;
    }
    this.used = true;
    this.pending = true;
    return true;
  }
}
