// Koffi native runtime staging for the bundled CUA MCP server.
//
// The CUA server externalizes koffi because esbuild cannot bundle its
// platform-dispatching `.node` requires. The installed agent has no hoisted
// node_modules, so keep only the target binary beside the plugin.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

function resolveKoffiRoot(koffiPackageRoot) {
  const candidates = [
    resolve(koffiPackageRoot),
    resolve(koffiPackageRoot, "node_modules", "koffi"),
  ];
  const virtualStore = resolve(koffiPackageRoot, "..", "..", "..", "..", "node_modules", ".pnpm");
  candidates.push(resolve(virtualStore, "..", "koffi"));
  if (existsSync(virtualStore)) {
    for (const entry of readdirSync(virtualStore)) {
      if (entry.startsWith("koffi@"))
        candidates.push(resolve(virtualStore, entry, "node_modules", "koffi"));
    }
  }
  for (const candidate of candidates) {
    const packageJson = resolve(candidate, "package.json");
    if (!existsSync(packageJson)) continue;
    try {
      if (JSON.parse(readFileSync(packageJson, "utf8")).name === "koffi") return candidate;
    } catch {
      // Continue searching other installation locations.
    }
  }
  throw new Error(
    `[koffi-package-assets] cannot resolve installed koffi package from ${koffiPackageRoot}`,
  );
}

function koffiPlatformKey(targetPlatform) {
  return `${targetPlatform.os}_${targetPlatform.arch}`;
}

export function stageKoffiIntoBundledAgents({ koffiPackageRoot, glmDir, targetPlatform }) {
  if (!koffiPackageRoot || !glmDir || !targetPlatform?.os || !targetPlatform?.arch) {
    throw new Error(
      "[koffi-package-assets] koffiPackageRoot, glmDir and targetPlatform are required",
    );
  }
  const sourceRoot = resolveKoffiRoot(koffiPackageRoot);
  const platformKey = koffiPlatformKey(targetPlatform);
  const sourceNativeDir = resolve(sourceRoot, "build", "koffi", platformKey);
  if (!existsSync(resolve(sourceNativeDir, "koffi.node"))) {
    throw new Error(
      `[koffi-package-assets] missing target native addon: ${sourceNativeDir}/koffi.node`,
    );
  }

  const targetRoot = resolve(glmDir, "node_modules", "koffi");
  rmSync(targetRoot, { recursive: true, force: true });
  mkdirSync(resolve(targetRoot, "build", "koffi", platformKey), { recursive: true });
  for (const file of ["index.js", "package.json", "index.d.ts"]) {
    cpSync(resolve(sourceRoot, file), resolve(targetRoot, file));
  }
  cpSync(
    resolve(sourceNativeDir, "koffi.node"),
    resolve(targetRoot, "build", "koffi", platformKey, "koffi.node"),
  );
  return resolve(targetRoot, "build", "koffi", platformKey, "koffi.node");
}

export function verifyStagedKoffi({
  resourcesDir,
  targetPlatform,
  // 驱动的原生依赖（koffi）stage 到 node-repl-host 的 node_modules —— 见
  // cua-driver-package-assets.mjs 与 electron-builder.config.js 中关于「源根直属
  // node_modules 会被 electron-builder 硬编码丢弃」的说明。此默认值原先指向
  // packages/zcode-cua-plugin，那个目录当前不存在，会让校验必然失败；已修正为实际位置。
  //
  // 遗留缺口（本函数自身即证据）：koffi 的 **stage 有调用点**（prepare-agent-node-bundle.mjs
  // 调用 stageKoffiIntoBundledAgents），但 koffi 的 **打包期校验没有调用点** ——
  // electron-builder.config.js:24 只 import 了本函数却从未调用，平台测试也记了这一点
  // （services/test/platformVariantAndCuaDriverStaging.test.ts:236）。后果：随包缺 koffi
  // 时构建不会失败，要到运行时第一次用电脑控制才暴露。接线本函数即可补上这道校验。
  pluginRelativePath = "packages/node-repl-host",
}) {
  const platformKey = koffiPlatformKey(targetPlatform);
  const koffiRoot = resolve(resourcesDir, "glm", pluginRelativePath, "node_modules", "koffi");
  const nativePath = resolve(koffiRoot, "build", "koffi", platformKey, "koffi.node");
  return existsSync(nativePath) && existsSync(resolve(koffiRoot, "index.js"))
    ? []
    : [`missing staged koffi runtime for ${platformKey}: ${nativePath}`];
}
