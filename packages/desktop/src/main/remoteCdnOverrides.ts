import { normalizeRemoteAssetCdnBaseUrl, type ZCodeEnv } from "@zcode/shared";
import {
  resolveRemoteCdnBaseUrls as resolveOrderedRemoteCdnBaseUrls,
  type ResolveRemoteCdnOptions,
} from "./remoteCdn.js";

/**
 * 自定义远程资产 CDN 基址的**优先级组合**（纯函数，不 import electron）。
 *
 * 为什么单独成文件而不是留在 `desktopRuntimeEnv.ts`：那个模块为了解析 Electron 路径与
 * 运行时目录，会把 `electron` 拉进模块图 —— 在 `node:test` 里导入它必然失败，
 * 于是"优先级对不对"这条最容易错的逻辑就**没有可执行测试**。这里只依赖 `remoteCdn.ts`
 * （纯函数、无 I/O），因此可以真跑。
 *
 * 产品规则见 `docs/development/remote-workspace.md` §3.1。优先级（高 → 低）：
 *   1. 运行期 env `ZCODE_REMOTE_ASSET_CDN_BASE_URL`（运维/调试）
 *   2. 用户设置 `AppSettings.remoteAssetCdnBaseUrl`（设置页；唯一所有者）
 *   3. 构建期 `ZCODE_CDN_BASE_URL` / `__ZCODE_CDN_BASE_URL__`（由 remoteCdn.ts 处理）
 *   4. 官方默认（同样由 remoteCdn.ts 处理）
 */

export interface RemoteCdnEnvironmentOverrides {
  /** 运行期 env 值；未设置时给 `undefined`（**不要**给空串冒充"未设置"，那会走同一个分支但语义混淆）。 */
  envBaseUrl?: string | undefined;
  /** 用户设置值（可能是空串或手改出的非法值）。 */
  settingsBaseUrl?: string | undefined;
}

/**
 * **接线陷阱（务必保留 `??` 合并）**：`remoteCdn.ts` 的 `overrideBaseUrl` 是"按字面值当发布根"
 * 的高优先槽位，而它**必须**同时承载 env 与设置两个来源。若写成
 * `{ ...options, overrideBaseUrl: envBaseUrl }`（直接覆盖），env 未设置时 `undefined` 会把
 * 调用方传进来的设置值**悄悄吃掉** —— 设置页填了也完全不生效，且不报错。
 */
function resolveEffectiveOverrideBaseUrl(
  options: { overrideBaseUrl?: string },
  overrides: RemoteCdnEnvironmentOverrides,
): string | undefined {
  const envBaseUrl = overrides.envBaseUrl?.trim();
  if (envBaseUrl) return envBaseUrl;
  // 设置值可能是空串（= 用默认）或手改出的非法值：归一化都会把它们收敛成 undefined，
  // 于是这里回到"没有用户设置"的行为，而不是把非法串塞进 overrideBaseUrl 变成一个 404 基址。
  const normalized = normalizeRemoteAssetCdnBaseUrl(overrides.settingsBaseUrl);
  return normalized.kind === "valid" ? normalized.value : options.overrideBaseUrl;
}

export function resolveRemoteCdnBaseUrlsWithOverrides(
  options: ResolveRemoteCdnOptions = {},
  overrides: RemoteCdnEnvironmentOverrides = {},
  env: ZCodeEnv,
): string[] {
  return resolveOrderedRemoteCdnBaseUrls({
    ...options,
    env,
    overrideBaseUrl: resolveEffectiveOverrideBaseUrl(options, overrides),
  });
}
