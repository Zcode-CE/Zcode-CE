import {
  parseModelCatalogResponse,
  resolveModelCatalogHeaders,
  resolveModelCatalogUrl,
  type ModelCatalogEntry,
} from "@zcode/shared";
import type { ApiClient } from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

const log = createServiceLogger("provider-model-catalog");

/** 拉取 Provider models 端点所需的全部事实；由 Facade 从当前 Settings 快照投影。 */
export interface ProviderModelCatalogRequest {
  readonly baseUrl: string;
  readonly apiFormat: "anthropic-messages" | "openai-chat-completions" | "openai-responses";
  readonly apiKey?: string | null;
  readonly headers?: Readonly<Record<string, string>> | null;
}

export interface ProviderModelCatalogResult {
  readonly entries: readonly ModelCatalogEntry[];
  /** 已归一化的实际请求地址，供错误提示与排障展示。 */
  readonly url: string;
}

/**
 * 从 Provider 的 models 端点拉取候选模型。
 *
 * 为什么必须在 Host 侧而不是 renderer：
 * 1. 浏览器受 CORS 限制，OpenAI 等端点明确不提供浏览器直连；
 * 2. Host 出口走设置页配置的 httpProxy / noProxy / caCertPath，与模型请求同一条链路，
 *    renderer 的 fetch 走 Electron defaultSession，用户配的代理不会生效；
 * 3. 手机远控与远程 workspace 必须由目标 Environment 的 Host 代发。
 *
 * 纯读操作：不发写请求，不修改任何配置。
 */
export type ProviderModelCatalogFetcher = (
  request: ProviderModelCatalogRequest,
) => Promise<ProviderModelCatalogResult>;

export interface CreateProviderModelCatalogFetcherOptions {
  readonly apiClient: Pick<ApiClient, "request">;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export function createProviderModelCatalogFetcher(
  options: CreateProviderModelCatalogFetcherOptions,
): ProviderModelCatalogFetcher {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (request) => {
    const url = resolveModelCatalogUrl({
      baseUrl: request.baseUrl,
      apiFormat: request.apiFormat,
    });
    if (!url) {
      throw new Error("Base URL 无效，无法推导 models 端点");
    }
    const response = await options.apiClient.request(url, {
      method: "GET",
      timeoutMs,
      headers: resolveModelCatalogHeaders({
        apiFormat: request.apiFormat,
        apiKey: request.apiKey,
        headers: request.headers,
      }),
    });
    if (!response.ok) {
      // 401/403 与 404 对用户是两件事：前者要改 Key，后者多半是 baseUrl 少了或多了路径段。
      const hint =
        response.status === 401 || response.status === 403
          ? "鉴权失败，请检查 API Key"
          : response.status === 404
            ? "端点不存在，请检查 Base URL"
            : `服务返回 ${response.status}`;
      throw new Error(`拉取模型失败（${hint}）: ${url}`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      log.warn(undefined, "models 响应不是合法 JSON", { url, error });
      throw new Error(`拉取模型失败（响应不是合法 JSON）: ${url}`);
    }
    const entries = parseModelCatalogResponse(payload);
    return Object.freeze({ entries, url });
  };
}
