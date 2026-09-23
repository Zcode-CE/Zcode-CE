import { ZCODE_VERSION, type ZCodeEnv } from "@zcode/shared";

declare const __ZCODE_CDN_BASE_URL__: string | undefined;
const DEFAULT_CDN_BASE_URL = "https://cdn-zcode.z.ai";

export interface ResolveRemoteCdnOptions {
  env?: ZCodeEnv;
  locale?: string;
  timeZone?: string;
  overrideBaseUrl?: string;
  version?: string;
  now?: Date;
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("CDN URL must use http or https");
  return value.replace(/\/+$/, "");
}

/**
 * 解析远程运行时资产的基址。优先级：
 *   1. `overrideBaseUrl`（运行期 `ZCODE_REMOTE_ASSET_CDN_BASE_URL`）
 *   2. `ZCODE_CDN_BASE_URL`（运行期 env 或构建期 define `__ZCODE_CDN_BASE_URL__`）
 *   3. 官方 CDN 默认值
 *
 * 语义（2026-09-23 修正）：**前两者的值都是"发布根"，按字面值使用** —— 即客户端会在
 * `<发布根>/<版本>/manifest-<平台>.json` 与 `<发布根>/components/...` 取资源。
 * 修正前构建期旋钮被当成父目录并追加 `/zcode/electron/releases/<版本>`，与
 * docs/development/remote-workspace.md 的契约矛盾（自建发布根会 404）。
 * **只有官方默认值**保留它自己的路径前缀（官方 CDN 的资源确实挂在那个前缀下）。
 */
export function resolveRemoteCdnBaseUrls(options: ResolveRemoteCdnOptions = {}): string[] {
  const override = options.overrideBaseUrl?.trim();
  if (override) return [normalizeBaseUrl(override)];
  const customBaseUrl =
    process.env.ZCODE_CDN_BASE_URL?.trim() ||
    (typeof __ZCODE_CDN_BASE_URL__ === "undefined" ? "" : __ZCODE_CDN_BASE_URL__);
  if (customBaseUrl) return [normalizeBaseUrl(customBaseUrl)];
  return [
    `${normalizeBaseUrl(DEFAULT_CDN_BASE_URL)}/zcode/electron/releases/${options.version ?? ZCODE_VERSION}`,
  ];
}
