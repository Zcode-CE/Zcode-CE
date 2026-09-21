/**
 * claim 平面 HTTP 客户端：`preview` + `claim`。
 *
 * 与 CE 已有的购买链路（/api/biz/pay/*、/api/pay/*）完全独立：claim 平面走
 * `/api/v1/zcode-plan/billing/*`，头集合也不同。
 *
 * 头集合按官方客户端逐字对齐（.reverse/08-entitlement/01 结论 §3 实测）：
 *   - preview：仅 `Authorization: Bearer {jwt}`（未登录时省略），
 *     外加活动网关硬性要求的 UUID `X-Device-Mid`；
 *   - claim：Authorization、Content-Type、X-Aliyun-Captcha-Verify-Param、
 *     [X-Aliyun-Captcha-Verify-Region]、X-ZCode-App-Version、X-Platform、X-Device-Mid。
 *
 * 为什么 preview 也要 X-Device-Mid：0828 / 0918 两轮周末活动里，网关对缺少该头
 * （或非 UUID 值）的请求一律回 biz 3001 parameter error。该头是硬门槛，不是可选归因。
 * deviceMid 由调用方（provider）通过 CE 已有的 ensureDeviceMid 取得并传入，本文件不生成身份。
 *
 * origin 解析复用 shared 的 buildRuntimeZCodeApiUrl：不硬编码 zcode.z.ai，
 * 这样 ZCODE_BASE_URL / ZCODE_ENDPOINT_ORIGIN 指向测试环境时 claim 平面跟随，
 * 且与 NodeApiClient 的 endpoint 改写保持同一来源。
 */
import {
  ApiError,
  buildRuntimeZCodeApiUrl,
  classifyManualClaimCode,
  parseManualClaimPlanPreviews,
  type ApiClient,
  type ManualClaimPlanClaimOutcome,
  type ManualClaimPlanPreview,
} from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

const BILLING_API_PREFIX = "/api/v1/zcode-plan/billing";
const PREVIEW_PATH = `${BILLING_API_PREFIX}/preview`;
const CLAIM_PATH = `${BILLING_API_PREFIX}/claim`;
const REQUEST_TIMEOUT_MS = 15_000;
const CAPTCHA_PARAM_HEADER = "X-Aliyun-Captcha-Verify-Param";
const CAPTCHA_REGION_HEADER = "X-Aliyun-Captcha-Verify-Region";
const log = createServiceLogger("manualClaimPlan");

interface ClaimApiEnvelope<T> {
  code?: number | string;
  msg?: string;
  message?: string;
  data?: T | null;
}

export interface ManualClaimPlanClientOptions {
  apiClient: ApiClient;
  /** 活动网关硬门槛；缺失时服务端回 3001。 */
  deviceMid: string;
  appVersion: string;
  /** `${process.platform}-${process.arch}`，与官方客户端一致。 */
  platform: string;
}

export interface ManualClaimPlanClient {
  getPreviews(options?: { jwt?: string }): Promise<ManualClaimPlanPreview[]>;
  claim(
    planId: string,
    captcha: { verifyParam: string; region?: string },
    options?: { jwt?: string },
  ): Promise<ManualClaimPlanClaimOutcome>;
}

function buildPreviewUrl(appVersion: string, platform: string): string {
  const url = new URL(buildRuntimeZCodeApiUrl(process.env, PREVIEW_PATH));
  url.searchParams.set("app_version", appVersion);
  url.searchParams.set("platform", platform);
  return url.toString();
}

function readErrorMessage(envelope: ClaimApiEnvelope<unknown> | undefined, status: number): string {
  return envelope?.msg?.trim() || envelope?.message?.trim() || `HTTP ${status}`;
}

function readEnvelopeCode(
  envelope: ClaimApiEnvelope<unknown> | undefined,
  status: number,
): number | string {
  if (envelope?.code !== undefined && envelope.code !== null) {
    return envelope.code;
  }
  return status >= 400 ? status : -1;
}

async function readEnvelope<T>(response: Response): Promise<ClaimApiEnvelope<T> | undefined> {
  const text = await response.text();
  if (!text.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as ClaimApiEnvelope<T>) : undefined;
  } catch {
    // 非 JSON 响应（WAF/HTML 页面）不在这里抛错，交给调用方按 HTTP 状态归类为可读失败。
    return undefined;
  }
}

/** 网络层失败按 HTTP 状态归类，避免把传输错误伪装成业务失败。 */
function classifyTransportFailure(error: unknown, planId: string): ManualClaimPlanClaimOutcome {
  const message = error instanceof Error ? error.message : String(error);
  const status = error instanceof ApiError ? error.status : undefined;
  return {
    ok: false,
    planId,
    failureKind:
      status === 401 ? "login_required" : status === undefined ? "network" : "http_error",
    code: status ?? -1,
    message,
  };
}

export function createManualClaimPlanClient(
  options: ManualClaimPlanClientOptions,
): ManualClaimPlanClient {
  const { apiClient, deviceMid, appVersion, platform } = options;

  function buildAuthHeaders(jwt: string | undefined): Record<string, string> {
    const token = jwt?.trim();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  return {
    async getPreviews({ jwt } = {}): Promise<ManualClaimPlanPreview[]> {
      const url = buildPreviewUrl(appVersion, platform);
      const response = await apiClient.request(url, {
        method: "GET",
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: {
          ...buildAuthHeaders(jwt),
          "X-Device-Mid": deviceMid,
        },
      });
      const envelope = await readEnvelope<{ plans?: unknown }>(response);
      const code = envelope?.code;
      const bizOk = code === undefined || Number(code) === 0;
      if (!response.ok || !bizOk) {
        const message = readErrorMessage(envelope, response.status);
        log.warn(undefined, "claim preview failed", { status: response.status, code });
        throw new ApiError({
          message,
          url,
          method: "GET",
          status: response.status,
        });
      }
      return parseManualClaimPlanPreviews(envelope?.data);
    },

    async claim(planId, captcha, { jwt } = {}): Promise<ManualClaimPlanClaimOutcome> {
      const token = jwt?.trim();
      if (!token) {
        // 与官方客户端一致：claim 必须有 JWT，缺凭据直接给出稳定失败类型，
        // 不发一次注定 401 的请求（未登录时也更快给出可读提示）。
        return {
          ok: false,
          planId,
          failureKind: "login_required",
          code: 401,
          message: "manual_claim_login_required",
        };
      }

      const headers: Record<string, string> = {
        ...buildAuthHeaders(token),
        "Content-Type": "application/json",
        [CAPTCHA_PARAM_HEADER]: captcha.verifyParam,
      };
      const region = captcha.region?.trim();
      if (region) {
        headers[CAPTCHA_REGION_HEADER] = region;
      }
      headers["X-ZCode-App-Version"] = appVersion;
      headers["X-Platform"] = platform;
      headers["X-Device-Mid"] = deviceMid;

      let response: Response;
      try {
        response = await apiClient.request(buildRuntimeZCodeApiUrl(process.env, CLAIM_PATH), {
          method: "POST",
          timeoutMs: REQUEST_TIMEOUT_MS,
          headers,
          body: JSON.stringify({ plan_id: planId }),
        });
      } catch (error) {
        return classifyTransportFailure(error, planId);
      }

      const envelope = await readEnvelope<{ plan?: { starts_at?: unknown; ends_at?: unknown } }>(
        response,
      );
      const code = readEnvelopeCode(envelope, response.status);
      const bizCode = envelope?.code;
      const plan = envelope?.data?.plan;
      const bizOk = bizCode === undefined || Number(bizCode) === 0;
      if (response.ok && bizOk && plan) {
        const outcome: ManualClaimPlanClaimOutcome = { ok: true, planId };
        if (typeof plan.starts_at === "number" && Number.isFinite(plan.starts_at)) {
          outcome.startsAt = plan.starts_at;
        }
        if (typeof plan.ends_at === "number" && Number.isFinite(plan.ends_at)) {
          outcome.endsAt = plan.ends_at;
        }
        return outcome;
      }

      // HTTP 层失败且没有业务码时按 HTTP 状态归类（401 → 登录失效）；
      // 有业务码则一律以业务码为准——服务端会用 200 承载 1005 这类业务失败。
      const failureKind =
        response.status >= 400 && bizCode === undefined
          ? response.status === 401
            ? "login_required"
            : "http_error"
          : classifyManualClaimCode(code);
      const failureEndsAt =
        typeof plan?.ends_at === "number" && Number.isFinite(plan.ends_at)
          ? plan.ends_at
          : undefined;
      log.warn(undefined, "claim failed", { status: response.status, code, failureKind });
      return {
        ok: false,
        planId,
        failureKind,
        code,
        message: readErrorMessage(envelope, response.status),
        ...(failureEndsAt !== undefined ? { failureEndsAt } : {}),
      };
    },
  };
}

export { CLAIM_PATH as MANUAL_CLAIM_PATH, PREVIEW_PATH as MANUAL_CLAIM_PREVIEW_PATH };
