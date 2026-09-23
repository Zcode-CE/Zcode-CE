/**
 * 远程资产 CDN 基址（用户可见的旋钮）的**唯一**归一化与校验实现。
 *
 * 产品规则与优先级见 `docs/development/remote-workspace.md` 的「3.1 让客户端指向它：四个旋钮的优先级」。
 *
 * 为什么归一化必须只有一份：这个值有三个入口（设置页保存、`setting.json` 手改、运行期 env），
 * 而**消费点只有一处**（desktop main 把它当 `overrideBaseUrl` 传给 `remoteCdn.ts`）。
 * 任一处各写一份，就会出现「设置页显示 A、实际请求 B」这种最难查的形态。
 */

/**
 * 允许的基址形态：**必须**是 http/https 的绝对 URL；空串表示「用默认」（各层自行回落）。
 *
 * **刻意宽松**：这里只判协议前缀，host/端口/IDN 的严格解析交给下面的 `new URL()`，避免同一件事两处实现。
 */
export const REMOTE_ASSET_CDN_BASE_URL_PATTERN = /^https?:\/\//iu;

/** 手工改 `setting.json` 或旧版本写回时的兜底上限（真实基址远短于此）。 */
export const MAX_REMOTE_ASSET_CDN_BASE_URL_LENGTH = 2048;

/**
 * 归一化结果。
 *
 * `kind` 区分三件事，调用方**必须分开处理**，不能一律当"非法"：
 * - `empty`：未设置 ⇒ 该层回落（**不是错误**，UI 上就是"留空 = 用默认"）
 * - `valid`：可用的基址
 * - `invalid`：明确非法 ⇒ **报错，绝不静默降级**
 */
export type RemoteAssetCdnBaseUrlNormalization =
  | { kind: "empty"; value: undefined }
  | { kind: "valid"; value: string }
  | { kind: "invalid"; code: RemoteAssetCdnBaseUrlErrorCode };

/**
 * 非法原因用**稳定的错误码**表达，调用方按码分支 —— 不解析错误文本做流程判断
 * （见 AGENTS.md「错误处理」）。UI 把码映射成可操作的文案。
 */
export const REMOTE_ASSET_CDN_BASE_URL_ERROR_CODES = {
  /** 值不是字符串（手改 JSON 写成了对象/数组）。 */
  notString: "notString",
  /** 超过长度上限。 */
  tooLong: "tooLong",
  /** 不是 http/https 绝对地址。 */
  protocol: "protocol",
  /** 过不了 `new URL()` 或没有 host。 */
  unparsable: "unparsable",
  /** 带查询串或片段（从浏览器地址栏复制时的典型误贴）。 */
  queryOrFragment: "queryOrFragment",
} as const;

export type RemoteAssetCdnBaseUrlErrorCode =
  (typeof REMOTE_ASSET_CDN_BASE_URL_ERROR_CODES)[keyof typeof REMOTE_ASSET_CDN_BASE_URL_ERROR_CODES];

const ERROR_CODES = REMOTE_ASSET_CDN_BASE_URL_ERROR_CODES;

/**
 * 归一化一个候选基址：去首尾空白、去尾部斜杠、校验协议与可解析性。
 *
 * **不静默降级**：非法输入返回 `invalid` + 错误码，由调用方决定怎么报错；
 * 返回 `undefined` 之类的"空值"会让用户以为设置生效了，实际走的是默认 CDN。
 */
export function normalizeRemoteAssetCdnBaseUrl(value: unknown): RemoteAssetCdnBaseUrlNormalization {
  if (value === undefined || value === null) return { kind: "empty", value: undefined };
  if (typeof value !== "string") return { kind: "invalid", code: ERROR_CODES.notString };

  const trimmed = value.trim();
  if (trimmed.length === 0) return { kind: "empty", value: undefined };
  if (trimmed.length > MAX_REMOTE_ASSET_CDN_BASE_URL_LENGTH) {
    return { kind: "invalid", code: ERROR_CODES.tooLong };
  }
  if (!REMOTE_ASSET_CDN_BASE_URL_PATTERN.test(trimmed)) {
    return { kind: "invalid", code: ERROR_CODES.protocol };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { kind: "invalid", code: ERROR_CODES.unparsable };
  }
  if (parsed.hostname.length === 0) return { kind: "invalid", code: ERROR_CODES.unparsable };
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    // 带查询串/片段的基址无法与相对路径正确拼接（`<base>/<版本>/manifest-*.json` 会把查询串甩到中间），
    // 这种配置一定是误贴，当场拒绝比让它 404 更容易排查。
    return { kind: "invalid", code: ERROR_CODES.queryOrFragment };
  }

  // 只去掉尾部斜杠：**保留**路径段（自建发布点常挂在子路径下，如 `https://host/assets`），
  // 也**不**追加任何路径段 —— 这个值就是"发布根"，版本目录由资产布局自己决定。
  const withoutTrailingSlashes = trimmed.replace(/\/+$/u, "");
  return {
    kind: "valid",
    value: withoutTrailingSlashes.length > 0 ? withoutTrailingSlashes : trimmed,
  };
}

/** 便捷取值：合法的给字符串，空给 `undefined`，非法给 `undefined`（非法应先用上面的函数判错并报给用户）。 */
export function readValidRemoteAssetCdnBaseUrl(value: unknown): string | undefined {
  const normalized = normalizeRemoteAssetCdnBaseUrl(value);
  return normalized.kind === "valid" ? normalized.value : undefined;
}
