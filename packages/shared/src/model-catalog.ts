import { z } from "zod";

/**
 * 模型目录（Model Catalog）拉取规则。
 *
 * 用户诉求：不再手工逐个输入模型 ID，而是从 Provider 自己的 `models` 端点拉取候选列表，勾选后批量添加。
 * 本模块只包含**纯函数**：端点推导与响应解析，不做任何网络 IO。
 * 发请求由 Host 侧完成（见 packages/services 的 provider model catalog fetcher），
 * 因为浏览器环境受 CORS 限制且无法复用设置页配置的 HTTP 代理。
 */

/** Provider API 格式，与 `providerApiTypeDataSchema` 的取值保持一致。 */
export const modelCatalogApiFormatSchema = z.enum([
  "anthropic-messages",
  "openai-chat-completions",
  "openai-responses",
]);
export type ModelCatalogApiFormat = z.infer<typeof modelCatalogApiFormatSchema>;

/** 从 Provider 的 `api.baseUrl` 推导 models 端点；baseUrl 非法时返回 null。 */
export function resolveModelCatalogUrl(input: {
  readonly baseUrl: string;
  readonly apiFormat: ModelCatalogApiFormat;
}): string | null {
  const baseUrl = input.baseUrl.trim();
  if (!baseUrl) return null;

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  // 用户可能直接粘贴了完整请求地址（.../v1/messages、.../chat/completions、.../responses）。
  // 这些后缀不是 API 根，必须先剥掉再拼 models，否则会得到 .../v1/messages/models。
  const path = stripKnownEndpointSuffix(parsed.pathname, input.apiFormat);
  parsed.pathname = `${path}/models`.replace(/\/{2,}/gu, "/");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

/** models 端点的鉴权头；与 Provider 自身的请求头保持同一套约定。 */
export function resolveModelCatalogHeaders(input: {
  readonly apiFormat: ModelCatalogApiFormat;
  readonly apiKey?: string | null;
  readonly headers?: Readonly<Record<string, string>> | null;
}): Record<string, string> {
  const headers: Record<string, string> = {};
  const apiKey = input.apiKey?.trim();
  if (apiKey) {
    if (input.apiFormat === "anthropic-messages") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
      // Anthropic 兼容网关（如 Z.ai / BigModel 的 anthropic 出口）只认 Bearer，
      // 与 apps/zcode-cli 的 withAnthropicAuthorizationHeader 保持同一行为。
      headers.Authorization = `Bearer ${apiKey}`;
    } else {
      headers.Authorization = `Bearer ${apiKey}`;
    }
  }
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    // 用户显式配置的头优先；否则自定义网关的鉴权方式会被默认头覆盖。
    headers[key] = value;
  }
  return headers;
}

/** 解析 models 响应。兼容 OpenAI / Anthropic / 通用 `models` 数组 / 裸数组四种形状。 */
export function parseModelCatalogResponse(input: unknown): readonly ModelCatalogEntry[] {
  const records = extractCandidateRecords(input);
  const entries: ModelCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const id = readModelId(record);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const displayName = readDisplayName(record);
    const createdAt = readCreatedAt(record);
    entries.push(
      Object.freeze({
        id,
        ...(displayName ? { displayName } : {}),
        ...(createdAt === undefined ? {} : { createdAt }),
      }),
    );
  }
  return Object.freeze(entries);
}

export interface ModelCatalogEntry {
  readonly id: string;
  readonly displayName?: string;
  readonly createdAt?: number;
}

function extractCandidateRecords(input: unknown): readonly unknown[] {
  if (Array.isArray(input)) return input;
  if (!isRecord(input)) return [];
  for (const key of ["data", "models", "items", "result"]) {
    const value = input[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function readModelId(record: unknown): string | undefined {
  if (typeof record === "string") return record.trim() || undefined;
  if (!isRecord(record)) return undefined;
  for (const key of ["id", "model", "name", "model_id", "modelId"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function readDisplayName(record: unknown): string | undefined {
  if (!isRecord(record)) return undefined;
  for (const key of ["display_name", "displayName", "label", "title"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function readCreatedAt(record: unknown): number | undefined {
  if (!isRecord(record)) return undefined;
  const value = record.created ?? record.created_at;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

/**
 * 剥离已知的「完整请求地址」后缀。
 *
 * - anthropic-messages：`/v1/messages`、`/messages`；同时补 `/v1`，与
 *   apps/zcode-cli 的 normalizeAnthropicBaseURL 追加 /v1 的行为一致
 *   （Anthropic SDK 自行追加 /messages，所以配置里的 baseUrl 通常不含 /v1）。
 * - openai-chat-completions：`/chat/completions`
 * - openai-responses：`/responses`（保留 /v1，因为 OpenAI 的 models 端点在 /v1 下）
 */
function stripKnownEndpointSuffix(pathname: string, apiFormat: ModelCatalogApiFormat): string {
  const withoutTrailingSlash = pathname.replace(/\/+$/u, "");
  switch (apiFormat) {
    case "anthropic-messages": {
      const stripped = stripSuffix(withoutTrailingSlash, ["/v1/messages", "/messages"]);
      // 兼容网关的 baseUrl 形如 https://api.z.ai/api/anthropic，没有版本段；
      // Anthropic 协议要求 /v1，因此这里补齐，与执行链 normalizeAnthropicBaseURL 对齐。
      return stripped.endsWith("/v1") ? stripped : `${stripped}/v1`;
    }
    case "openai-chat-completions":
      return stripSuffix(withoutTrailingSlash, ["/chat/completions"]);
    case "openai-responses":
      return stripSuffix(withoutTrailingSlash, ["/responses"]);
  }
}

function stripSuffix(value: string, suffixes: readonly string[]): string {
  const lower = value.toLowerCase();
  for (const suffix of suffixes) {
    if (lower.endsWith(suffix)) return value.slice(0, value.length - suffix.length);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
