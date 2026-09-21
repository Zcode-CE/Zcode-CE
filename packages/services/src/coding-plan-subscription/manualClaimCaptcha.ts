/**
 * 阿里云验证码（V3 无痕验证）凭据获取：claim 平面所需 `X-Aliyun-Captcha-Verify-Param`。
 *
 * 与 zcode-api 参考实现的差异（刻意为之，见任务书）：
 *   参考实现内置 happy-dom + pe-VM 补丁的完整自动求解器（约 99KB，强依赖 happy-dom
 *   内部结构 WindowBrowserContext 与同步 XHR worker 补丁），CE 侧先做**最小可用版**：
 *   只负责「配置拉取 + 凭据注入 + 可读错误」，真正的求解通过 `solve` 注入，
 *   后续可接内嵌验证码 WebView 或外部求解器，而不必引入 happy-dom。
 *
 * 数据流：
 *   /api/v1/client/configs → configs.captcha {enabled,prefix,sceneId,region}
 *   → solve(config) 产出 verifyParam → 随 claim 请求作为 X-Aliyun-Captcha-Verify-Param 发送
 *
 * 失败一律抛稳定错误码（见 shared 的 MANUAL_CLAIM_CAPTCHA_*）：UI 需要区分
 * 「活动未开验证码」「配置拉取失败」「本端未接入求解器」三类，不能靠文案匹配。
 */
import {
  buildRuntimeZCodeApiUrl,
  MANUAL_CLAIM_CAPTCHA_CONFIG_UNAVAILABLE,
  MANUAL_CLAIM_CAPTCHA_DISABLED,
  MANUAL_CLAIM_CAPTCHA_SOLVER_UNAVAILABLE,
  ZCODE_VERSION,
  type ApiClient,
  type ManualClaimCaptchaConfig,
  type ManualClaimCaptchaSolution,
} from "@zcode/shared";
import { readApiJson } from "../providers/api/apiJson.js";
import { createServiceLogger } from "../logger/serviceLogger.js";

const CAPTCHA_CONFIGS_PATH = "/api/v1/client/configs";
const REQUEST_TIMEOUT_MS = 15_000;
/** 配置快照 TTL：与 zcode-api 参考实现一致（60s），活动开关翻转后 1 分钟内可见。 */
const CONFIG_CACHE_TTL_MS = 60_000;

/** 注入点：把 verifyParam 的产生方式与网络/渲染环境解耦，便于测试与后续替换实现。 */
export type ManualClaimCaptchaSolver = (
  config: ManualClaimCaptchaConfig,
) => Promise<ManualClaimCaptchaSolution>;

interface ClientConfigEnvelope {
  code?: number;
  msg?: string;
  data?: { configs?: { captcha?: Partial<ManualClaimCaptchaConfig> | null } | null } | null;
}

export interface ManualClaimCaptchaOptions {
  apiClient: ApiClient;
  /** 未注入时 getCaptchaCredential 抛 MANUAL_CLAIM_CAPTCHA_SOLVER_UNAVAILABLE。 */
  solve?: ManualClaimCaptchaSolver;
  /** 供测试注入时间源。 */
  now?: () => number;
}

export interface ManualClaimCaptcha {
  getConfig(options?: { forceRefresh?: boolean }): Promise<ManualClaimCaptchaConfig | null>;
  getCaptchaCredential(options?: { forceRefresh?: boolean }): Promise<ManualClaimCaptchaSolution>;
}

const log = createServiceLogger("manualClaimCaptcha");

function normalizeConfig(
  raw: Partial<ManualClaimCaptchaConfig> | null | undefined,
): ManualClaimCaptchaConfig | null {
  if (!raw) {
    return null;
  }
  const prefix = raw.prefix?.trim() ?? "";
  const sceneId = raw.sceneId?.trim() ?? "";
  const region = raw.region?.trim() ?? "";
  // 三项缺一不可：没有 sceneId/prefix 无法初始化验证码，没有 region 请求会被拒。
  if (!prefix || !sceneId || !region) {
    return null;
  }
  return { enabled: raw.enabled === true, prefix, sceneId, region };
}

export function createManualClaimCaptcha(options: ManualClaimCaptchaOptions): ManualClaimCaptcha {
  const now = options.now ?? Date.now;
  const solver = options.solve;
  let cached: { value: ManualClaimCaptchaConfig | null; expiresAt: number } | null = null;
  let inFlight: Promise<ManualClaimCaptchaConfig | null> | null = null;

  async function fetchConfig(): Promise<ManualClaimCaptchaConfig | null> {
    const url = new URL(buildRuntimeZCodeApiUrl(process.env, CAPTCHA_CONFIGS_PATH));
    url.searchParams.set("app_version", ZCODE_VERSION);
    url.searchParams.set("platform", `${process.platform}-${process.arch}`);
    const payload = await readApiJson<ClientConfigEnvelope>(options.apiClient, url, {
      method: "GET",
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    return normalizeConfig(payload.data?.configs?.captcha);
  }

  async function loadConfig(forceRefresh: boolean): Promise<ManualClaimCaptchaConfig | null> {
    if (!forceRefresh && cached && cached.expiresAt > now()) {
      return cached.value;
    }
    if (inFlight) {
      return await inFlight;
    }
    inFlight = fetchConfig()
      .then((value) => {
        cached = { value, expiresAt: now() + CONFIG_CACHE_TTL_MS };
        return value;
      })
      .catch((error: unknown) => {
        // 配置读取失败不写缓存：缓存 null 等于把一次网络抖动放大成整个活动窗口不可用。
        log.warn(undefined, "captcha config fetch failed", {
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        throw new Error(MANUAL_CLAIM_CAPTCHA_CONFIG_UNAVAILABLE);
      })
      .finally(() => {
        inFlight = null;
      });
    return await inFlight;
  }

  return {
    /** 拉取（带 60s 快照）验证码配置；供 UI 判断当前活动是否需要验证码。 */
    async getConfig({ forceRefresh = false } = {}): Promise<ManualClaimCaptchaConfig | null> {
      return await loadConfig(forceRefresh);
    },

    /** 取得 claim 请求所需的验证码凭据；失败抛稳定错误码。 */
    async getCaptchaCredential({ forceRefresh = false } = {}): Promise<ManualClaimCaptchaSolution> {
      const config = await loadConfig(forceRefresh);
      if (!config) {
        throw new Error(MANUAL_CLAIM_CAPTCHA_CONFIG_UNAVAILABLE);
      }
      if (!config.enabled) {
        // 活动未开验证码时不能静默发空凭据：服务端会回 3007，
        // 这里先给出明确原因，避免把「活动没开」误报成「验证失败」。
        throw new Error(MANUAL_CLAIM_CAPTCHA_DISABLED);
      }
      if (!solver) {
        throw new Error(MANUAL_CLAIM_CAPTCHA_SOLVER_UNAVAILABLE);
      }
      const solution = await solver(config);
      const verifyParam = solution.verifyParam?.trim();
      if (!verifyParam) {
        throw new Error(MANUAL_CLAIM_CAPTCHA_SOLVER_UNAVAILABLE);
      }
      return {
        verifyParam,
        region: solution.region?.trim() || config.region,
      };
    },
  };
}
