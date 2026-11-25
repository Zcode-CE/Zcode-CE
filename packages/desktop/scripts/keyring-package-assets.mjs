// @napi-rs/keyring 的打包资产：平台变体命名、agent 树暂存与出包校验。
//
// 为什么单独成一个模块：原生变体的目录名不是平台 key 的直接拼接（linux 带 -gnu、Windows 带
// -msvc），而策略（prune 与产物校验）、暂存（dev 与打包共用的 stage-agent-bundle.mjs）和
// 出包校验三处都要用同一个映射。任何一处各自拼字符串，跨平台打包时就会静默取到别的变体：
// 模块仍然 require 得动，却读不出该平台已有的条目，只能回退到私有文件，而没人会看到警告。
//
// 落点为什么是 glm/node_modules：Node 从 glm/zcode.cjs 出发向上找 node_modules，这一站正好命中，
// 与无头分发包的 agent/node_modules 布局同构。但 electron-builder 会硬编码丢掉 extraResources
// 源根直属的 node_modules（见 electron-builder.config.js 里 glm 条目的说明），所以打包时另有一条
// extraResources 条目以 glm/node_modules/@napi-rs 为源根，把它单独拷进 resources/glm/node_modules。
//
// 为什么 agent 也要带：凭据 v2 的密钥来源在 Desktop Host 与内置 agent 之间必须一致
//（见 packages/shared/src/credential-security/CONTRACT.md 的密钥来源优先级）。Host 用系统凭据库
// 生成并钉住来源后，agent 若加载不到同一个原生模块，就只能报 CREDENTIAL_SECURE_STORAGE_UNAVAILABLE，
// 用户侧表现为 MCP OAuth 等凭据读写整个不可用。
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

export const KEYRING_PACKAGE_NAME = "@napi-rs/keyring";

// 主包随包的运行时文件。README 与 .d.ts 是文档/类型，不进产物。
const KEYRING_RUNTIME_FILES = ["index.js", "keytar.js", "package.json", "LICENSE"];

// 平台变体包里随包的文件。LICENSE.third-party.md 是 MIT 之外的 crates 许可声明，
// 分发二进制就有随附义务，缺了它等于把许可材料留在仓库里。
const KEYRING_VARIANT_RUNTIME_FILES = ["package.json", "LICENSE.third-party.md"];

/**
 * npm 平台变体后缀：linux 走 glibc、Windows 带 -msvc、darwin 直接 platform-arch。
 * 与 packages/desktop/scripts/target-platform.mjs 的 npmLibc 同口径（桌面 Linux 只发 glibc）。
 * 只接受桌面支持的 6 个平台 key —— 变体清单由 pnpm supportedArchitectures 决定，两边必须一致。
 */
export function resolveKeyringVariantSuffix(targetPlatformKey) {
  const match = /^(darwin|linux|win32)-(x64|arm64)$/.exec(targetPlatformKey);
  if (!match) {
    throw new Error(`不支持的 keyring 目标平台: ${targetPlatformKey}`);
  }
  const [, platform, arch] = match;
  if (platform === "linux") return `${platform}-${arch}-gnu`;
  if (platform === "win32") return `${platform}-${arch}-msvc`;
  return `${platform}-${arch}`;
}

/** 目标平台变体在 @napi-rs/ 作用域下的目录名，例如 keyring-linux-x64-gnu。 */
export function keyringPlatformPackageDirName(targetPlatformKey) {
  return `keyring-${resolveKeyringVariantSuffix(targetPlatformKey)}`;
}

/** 目标平台对应的 npm 变体包名，例如 @napi-rs/keyring-linux-x64-gnu。 */
export function keyringPlatformPackageName(targetPlatformKey) {
  return `@napi-rs/${keyringPlatformPackageDirName(targetPlatformKey)}`;
}

/** 目标平台变体包里的原生二进制文件名，例如 keyring.linux-x64-gnu.node。 */
export function keyringNativeFileName(targetPlatformKey) {
  return `keyring.${resolveKeyringVariantSuffix(targetPlatformKey)}.node`;
}

function readInstalledPackage({ lookupRoots, moduleName }) {
  const searched = [];
  for (const lookupRoot of lookupRoots) {
    const packageRoot = resolve(lookupRoot, "node_modules", ...moduleName.split("/"));
    const manifestPath = resolve(packageRoot, "package.json");
    searched.push(packageRoot);
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    // 同名目录被别的包占用时继续向上找：pnpm hoisted 布局下这只可能是布局异常，
    // 但静默接受会让我们把错误的二进制拷进产物。
    if (manifest.name !== moduleName) continue;
    return { packageRoot, manifest };
  }
  throw new Error(
    `[keyring-package-assets] 找不到已安装的 ${moduleName}；先运行 pnpm install。已搜索：${searched.join(", ")}`,
  );
}

/**
 * 把目标平台的 keyring 运行时拷进 agent 树（glm/node_modules/@napi-rs）。
 *
 * 只拷主包与目标平台变体：安装机按 supportedArchitectures 装了 6 个变体（合计约 12 MiB），
 * 全部带进产物既无意义，又会让运行时解析到与目标平台不匹配的二进制。
 */
export function stageKeyringIntoBundledAgents({ lookupRoots, glmDir, targetPlatformKey }) {
  if (!Array.isArray(lookupRoots) || lookupRoots.length === 0) {
    throw new Error("[keyring-package-assets] lookupRoots 不能为空");
  }
  if (!glmDir) {
    throw new Error("[keyring-package-assets] glmDir 不能为空");
  }

  const variantName = keyringPlatformPackageName(targetPlatformKey);
  const variantDirName = keyringPlatformPackageDirName(targetPlatformKey);
  const nativeFileName = keyringNativeFileName(targetPlatformKey);
  const main = readInstalledPackage({ lookupRoots, moduleName: KEYRING_PACKAGE_NAME });
  const variant = readInstalledPackage({ lookupRoots, moduleName: variantName });
  const sourceNativePath = resolve(variant.packageRoot, nativeFileName);
  if (!existsSync(sourceNativePath)) {
    throw new Error(`[keyring-package-assets] 平台变体包缺少原生二进制：${sourceNativePath}`);
  }

  const scopeDir = resolve(glmDir, "node_modules", "@napi-rs");
  const targetMainDir = resolve(scopeDir, "keyring");
  const targetVariantDir = resolve(scopeDir, variantDirName);
  // 逐目录删除而不是清空 @napi-rs：换目标平台打包时旧变体必须消失，
  // 否则两个变体并排躺着，加载哪一个取决于解析顺序而不是构建目标。
  rmSync(targetMainDir, { recursive: true, force: true });
  rmSync(targetVariantDir, { recursive: true, force: true });
  mkdirSync(targetMainDir, { recursive: true });
  mkdirSync(targetVariantDir, { recursive: true });

  for (const fileName of KEYRING_RUNTIME_FILES) {
    const sourcePath = resolve(main.packageRoot, fileName);
    if (!existsSync(sourcePath)) {
      throw new Error(`[keyring-package-assets] 主包缺少运行时文件：${sourcePath}`);
    }
    cpSync(sourcePath, resolve(targetMainDir, fileName));
  }
  for (const fileName of [...KEYRING_VARIANT_RUNTIME_FILES, nativeFileName]) {
    const sourcePath = resolve(variant.packageRoot, fileName);
    if (!existsSync(sourcePath)) {
      throw new Error(`[keyring-package-assets] 平台变体包缺少文件：${sourcePath}`);
    }
    cpSync(sourcePath, resolve(targetVariantDir, fileName));
  }

  return {
    mainDir: targetMainDir,
    variantDir: targetVariantDir,
    nativePath: resolve(targetVariantDir, nativeFileName),
    version: main.manifest.version,
    platformVariant: variantName,
  };
}

/**
 * 出包期校验：agent 树里必须真的有主包、平台变体包与目标二进制。
 *
 * 为什么必须单独看一遍产物：stage 出文件不等于文件在包里 —— extraResources 的 glob 与
 * electron-builder 的 node_modules 丢弃规则都能把它静默吞掉（glm 那条已踩过）。
 * 缺失时的表现不是崩，而是静默回退到私有文件，构建全程绿灯。
 */
export function verifyStagedKeyring({ resourcesDir, targetPlatformKey, glmDirName = "glm" }) {
  const variantDirName = keyringPlatformPackageDirName(targetPlatformKey);
  const nativeFileName = keyringNativeFileName(targetPlatformKey);
  const scopeDir = resolve(resourcesDir, glmDirName, "node_modules", "@napi-rs");
  const requiredPaths = [
    resolve(scopeDir, "keyring", "index.js"),
    resolve(scopeDir, "keyring", "package.json"),
    resolve(scopeDir, variantDirName, "package.json"),
    resolve(scopeDir, variantDirName, nativeFileName),
  ];
  return requiredPaths
    .filter((requiredPath) => !existsSync(requiredPath))
    .map((requiredPath) => `缺少随包 keyring 运行时文件: ${requiredPath}`);
}
