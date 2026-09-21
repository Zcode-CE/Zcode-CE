/**
 * GitHub 加速前缀（国内镜像站）的解析与应用。
 *
 * 背景：部分网络环境直连 github.com 不稳定，用户会配置 ghproxy 一类镜像站。
 * 本模块只做一件事：把**已经构造好的原始 GitHub URL** 改写成 `前缀 + 原始URL`。
 *
 * 为什么只支持「路径前缀」而不是「域名替换」：
 * 主流镜像站（ghproxy 系）都是路径前缀形态；域名替换需要镜像站自己实现 GitHub 的
 * 路由语义，且覆盖不了 api.github.com 这类子域，我们无法据此构造出稳定 URL。
 *
 * 三条安全边界都不能放松：
 * 1. **只接受 https**：否则仓库内容、zipball 会落到明文链路；
 * 2. **只改写 GitHub 自有域名**：用户配了前缀也不能把其它请求导向镜像站；
 * 3. **前缀必须是纯 origin + 路径**：带用户名/口令、查询串或片段的前缀会让拼接结果被劫持。
 *
 * 运行期与保存期的策略不同，这是刻意的：
 * - 保存期（设置页）走 {@link resolveGithubMirrorPrefix}，非法值**拒绝保存**并给出可读原因；
 * - 运行期走 {@link applyGithubMirrorPrefix}，非法值**退化为直连**而不是抛错 ——
 *   配置问题不能让插件安装、更新检查整条链路失败。
 */

/**
 * 允许套加速前缀的 GitHub 域名。
 *
 * 只列当前实现真的会发请求的三个：`github.com`（git clone / 浏览器）、
 * `www.github.com`（用户手输）、`api.github.com`（zipball）。
 * 新增域名必须是有意为之的改动，不能靠通配 `*.github.com` —— 那会把
 * 未来新增的 GitHub 子域也一起导向第三方镜像站。
 */
const MIRRORABLE_GITHUB_HOSTNAMES: ReadonlySet<string> = new Set([
  "github.com",
  "www.github.com",
  "api.github.com",
]);

/** 设置值非法时的稳定错误码；UI 据此映射到本地化文案，不依赖错误文本做判断。 */
export const GITHUB_MIRROR_PREFIX_ERROR_CODES = {
  /** 不是合法 URL（例如漏了 scheme 的 `ghfast.top`）。 */
  invalidUrl: "GITHUB_MIRROR_PREFIX_INVALID_URL",
  /** scheme 不是 https。 */
  insecureProtocol: "GITHUB_MIRROR_PREFIX_INSECURE_PROTOCOL",
  /** URL 里带了用户名或口令。 */
  credentials: "GITHUB_MIRROR_PREFIX_CREDENTIALS",
  /** URL 里带了查询串或片段。 */
  queryOrFragment: "GITHUB_MIRROR_PREFIX_QUERY_OR_FRAGMENT",
} as const;

export type GithubMirrorPrefixErrorCode =
  (typeof GITHUB_MIRROR_PREFIX_ERROR_CODES)[keyof typeof GITHUB_MIRROR_PREFIX_ERROR_CODES];

export interface GithubMirrorPrefixResolution {
  /** 规范化后的前缀（以 `/` 结尾）；未配置或非法时为 undefined。 */
  prefix?: string;
  /** 非法时的稳定错误码；合法或未配置时为 undefined。 */
  errorCode?: GithubMirrorPrefixErrorCode;
}

/**
 * 校验并规范化加速前缀。
 *
 * 空值 = 关闭（返回 `{}`），不是错误：默认关闭是本功能的既定产品语义。
 */
export function resolveGithubMirrorPrefix(
  value: string | undefined | null,
): GithubMirrorPrefixResolution {
  const trimmed = value?.trim();
  if (!trimmed) {
    return {};
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { errorCode: GITHUB_MIRROR_PREFIX_ERROR_CODES.invalidUrl };
  }

  if (parsed.protocol !== "https:") {
    return { errorCode: GITHUB_MIRROR_PREFIX_ERROR_CODES.insecureProtocol };
  }
  if (parsed.username || parsed.password) {
    return { errorCode: GITHUB_MIRROR_PREFIX_ERROR_CODES.credentials };
  }
  if (parsed.search || parsed.hash) {
    return { errorCode: GITHUB_MIRROR_PREFIX_ERROR_CODES.queryOrFragment };
  }

  // 归一化到「以单斜杠结尾」：拼接时不再关心用户是否写了结尾斜杠。
  const pathname = parsed.pathname.endsWith("/") ? parsed.pathname : `${parsed.pathname}/`;
  return { prefix: `${parsed.origin}${pathname}` };
}

/** {@link resolveGithubMirrorPrefix} 的便捷形态：非法或未配置一律返回 undefined。 */
export function normalizeGithubMirrorPrefix(value: string | undefined | null): string | undefined {
  return resolveGithubMirrorPrefix(value).prefix;
}

/** 该 URL 是否属于「允许套前缀」的 GitHub 域名。 */
export function isMirrorableGithubUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" && MIRRORABLE_GITHUB_HOSTNAMES.has(parsed.hostname.toLowerCase())
  );
}

/**
 * 把加速前缀套到 GitHub URL 上。
 *
 * 这是**唯一**的改写入口：调用方在 URL 构造完成后调用一次，避免同一 URL 被套两次前缀
 * （前缀本身不是 GitHub 域名，二次套用会被 {@link isMirrorableGithubUrl} 挡住，这里依赖该性质）。
 *
 * 前缀未配置、非法，或 URL 不属于 GitHub 域名时**原样返回**，调用方无需分支。
 */
export function applyGithubMirrorPrefix(url: string, prefix: string | undefined | null): string {
  const normalized = normalizeGithubMirrorPrefix(prefix);
  if (!normalized) {
    return url;
  }
  if (!isMirrorableGithubUrl(url)) {
    return url;
  }
  return `${normalized}${url}`;
}

/** 读取运行时加速前缀的环境变量名；宿主把它注入 agent 子进程，让插件安装在子进程内也能读到。 */
export const ZCODE_GITHUB_MIRROR_ENV_KEY = "ZCODE_GITHUB_MIRROR";
