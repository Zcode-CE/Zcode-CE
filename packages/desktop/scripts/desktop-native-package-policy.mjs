import {
  KEYRING_PACKAGE_NAME,
  keyringNativeFileName,
  keyringPlatformPackageName,
  resolveKeyringVariantSuffix,
} from "./keyring-package-assets.mjs";

const SUPPORTED_DESKTOP_PLATFORM_KEYS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
];

function assertSupportedTargetPlatformKey(targetPlatformKey) {
  if (!SUPPORTED_DESKTOP_PLATFORM_KEYS.includes(targetPlatformKey)) {
    throw new Error(`不支持的桌面目标平台: ${targetPlatformKey}`);
  }
}

export function createDesktopNativePackagePrunePatterns(targetPlatformKey) {
  assertSupportedTargetPlatformKey(targetPlatformKey);

  return [
    // PDF 预览已经由 Vite 打进 renderer，pdfjs-dist 的 Canvas optional dependency
    // 只服务 Node 渲染；pnpm 跨平台安装的 8 套 Canvas native 不应带进桌面安装包。
    "!node_modules/@napi-rs/canvas/**",
    "!node_modules/@napi-rs/canvas-*/**",
    // @napi-rs/keyring 的 12 个平台变体都是主包 optionalDependencies，安装机按
    // supportedArchitectures 装了其中 6 个；安装包与 agent 树都只允许带目标平台那一个。
    ...SUPPORTED_DESKTOP_PLATFORM_KEYS.filter((key) => key !== targetPlatformKey).map(
      (key) => `!node_modules/@napi-rs/keyring-${resolveKeyringVariantSuffix(key)}/**`,
    ),
    // Linux prebuild 会在 beforePack 复制进 node-pty；源平台包本身不属于桌面运行时。
    "!node_modules/@lydell/node-pty-*/**",
    // 桌面运行时统一使用目标 prebuild，禁止把安装机现场编译物或 ABI bin 缓存带进跨平台包。
    "!node_modules/node-pty/build/**",
    "!node_modules/node-pty/bin/**",
    ...SUPPORTED_DESKTOP_PLATFORM_KEYS.filter((key) => key !== targetPlatformKey).map(
      (key) => `!node_modules/node-pty/prebuilds/${key}/**`,
    ),
  ];
}

function normalizeAsarPath(path) {
  const normalized = path.trim().replaceAll("\\", "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

export function parseAsarListWithPackState(output) {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^(pack|unpack)\s*:\s*(.+)$/.exec(line);
      if (!match) {
        throw new Error(`无法解析 asar pack state: ${line}`);
      }
      return { packState: match[1], path: normalizeAsarPath(match[2]) };
    });
}

function isNativeRuntimeFile(path, targetPlatformKey) {
  if (/\.(?:node|dll|dylib|exe)$/i.test(path)) return true;
  return path === `/node_modules/node-pty/prebuilds/${targetPlatformKey}/spawn-helper`;
}

export function findDesktopNativePackageViolations(entries, targetPlatformKey) {
  assertSupportedTargetPlatformKey(targetPlatformKey);
  const violations = [];
  const keyringVariantSuffix = resolveKeyringVariantSuffix(targetPlatformKey);
  const keyringVariantName = keyringPlatformPackageName(targetPlatformKey);
  const keyringMainRoot = `/node_modules/${KEYRING_PACKAGE_NAME}`;
  const keyringVariantRoot = `/node_modules/${keyringVariantName}`;

  for (const entry of entries) {
    const { packState, path } = entry;

    const keyringVariantMatch = /^\/node_modules\/@napi-rs\/keyring-([^/]+)/.exec(path);
    if (keyringVariantMatch && keyringVariantMatch[1] !== keyringVariantSuffix) {
      violations.push(
        `不应打包非目标平台的 keyring 原生变体（目标 ${keyringVariantSuffix}）: ${path}`,
      );
      continue;
    }

    if (
      path === "/node_modules/@napi-rs/canvas" ||
      path.startsWith("/node_modules/@napi-rs/canvas/") ||
      path.startsWith("/node_modules/@napi-rs/canvas-")
    ) {
      violations.push(`不应打包 renderer 无需的 Canvas native: ${path}`);
      continue;
    }

    if (path.startsWith("/node_modules/@lydell/node-pty-")) {
      violations.push(`不应打包仅用于准备 prebuild 的平台源包: ${path}`);
      continue;
    }

    if (
      path.startsWith("/node_modules/node-pty/build/") ||
      path.startsWith("/node_modules/node-pty/bin/")
    ) {
      violations.push(`不应打包安装机生成的 node-pty 产物: ${path}`);
      continue;
    }

    const nodePtyPrebuildMatch = /^\/node_modules\/node-pty\/prebuilds\/([^/]+)/.exec(path);
    if (nodePtyPrebuildMatch && nodePtyPrebuildMatch[1] !== targetPlatformKey) {
      violations.push(`node-pty 包含非目标平台 prebuild: ${path}`);
      continue;
    }

    if (isNativeRuntimeFile(path, targetPlatformKey) && packState !== "unpack") {
      violations.push(`native 文件仍作为 packed payload 留在 app.asar: ${path}`);
    }
  }

  // 系统凭据库原生模块必须成对出现：主包（惰性 import 的入口）与目标平台变体（含 .node）。
  // 只带主包时 require 会在运行时才失败，表现是静默回退到私有文件 —— 构建全程绿灯；
  // 变体在但 .node 不在，则是 asarUnpack 规则写错，同样只在用户机器上暴露。
  const hasKeyringMain = entries.some(
    (entry) => entry.path === keyringMainRoot || entry.path.startsWith(`${keyringMainRoot}/`),
  );
  const keyringVariantEntries = entries.filter(
    (entry) => entry.path === keyringVariantRoot || entry.path.startsWith(`${keyringVariantRoot}/`),
  );
  if (!hasKeyringMain) {
    violations.push(
      `产物缺少系统凭据库原生模块 ${KEYRING_PACKAGE_NAME}（凭据 v2 将只能回退到私有文件）`,
    );
  } else if (keyringVariantEntries.length === 0) {
    violations.push(`产物缺少 keyring 目标平台变体 ${keyringVariantName}`);
  } else if (
    !keyringVariantEntries.some((entry) =>
      entry.path.endsWith(`/${keyringNativeFileName(targetPlatformKey)}`),
    )
  ) {
    violations.push(
      `产物缺少 keyring 目标平台原生二进制 ${keyringVariantName}/${keyringNativeFileName(targetPlatformKey)}`,
    );
  }

  return violations;
}

/**
 * REQUIRED_ASAR_RUNTIME_MODULES 依赖闭包里，哪些条目不属于目标平台而必须跳过。
 *
 * keyring 的 12 个平台变体都是主包的 optionalDependencies，闭包会把已安装的全部收进来；
 * 而安装包只允许带目标变体（其余由上面的 prune 规则裁掉）。注入与产物校验都先过一遍这个
 * 判定，否则「补齐缺失依赖」这一步会自己把越界变体写回 app.asar，再被策略校验判死。
 */
export function isRuntimeModuleOutsideTargetPlatform(moduleName, targetPlatformKey) {
  const keyringVariantMatch = /^@napi-rs\/keyring-(.+)$/.exec(moduleName);
  if (!keyringVariantMatch) return false;
  return keyringVariantMatch[1] !== resolveKeyringVariantSuffix(targetPlatformKey);
}
