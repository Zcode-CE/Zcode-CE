// Agent bundle 的暂存动作：把 apps/zcode-cli/packages/cli/dist/zcode.cjs 放进
// bundled-agents/<平台>/glm，并写 meta。
//
// dev 与打包**必须**用同一份暂存实现。
// 只有打包链（prepare-agent-node-bundle.mjs）会暂存是不够的，dev 链
// （scripts/build-desktop-agent-cli.mjs）不会；而 dev 未打包时的 agent 二进制由
// desktopRuntimeEnv.ts 的 resolveBundledZCodeAgentBinaryPath() 解析，候选**只有**
// bundled-agents/，没有 cli/dist/。于是 dev 一直跑着上一次打包时留下的那份 ——
// 实测陈旧 3 天，任何 agent CLI 侧改动在 dev 里静默不生效，排查时会把「改动没生效」
// 误判成「代码没起作用」。两边共用这一份，dev 与打包不可能再各自漂移。
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { stageKeyringIntoBundledAgents } from "./keyring-package-assets.mjs";

export const AGENT_BUNDLE_SOURCE_RELATIVE = "apps/zcode-cli/packages/cli/dist/zcode.cjs";

export function resolveAgentBundlePaths({ repoRoot, platformKey }) {
  const glmDir = resolve(repoRoot, "packages", "desktop", "bundled-agents", platformKey, "glm");
  return {
    cliBundlePath: resolve(repoRoot, AGENT_BUNDLE_SOURCE_RELATIVE),
    glmDir,
    stagedBundlePath: resolve(glmDir, "zcode.cjs"),
    stagedMetaPath: resolve(glmDir, ".node-bundle-meta.json"),
  };
}

/**
 * 干净重建 glm 目录再拷贝。清空是刻意的：electron-builder 整目录拷贝
 * bundled-agents/<平台>/glm → resources/glm，本地工作树里上一次构建残留的原生二进制
 * （zcode-agent / zcode-acp 等）和旧 meta 会被一并打进安装包（CI 干净检出不会有，本地会）。
 *
 * 系统凭据库原生模块（@napi-rs/keyring）也在这里随 agent 树一起落盘：
 * 它是 zcode.cjs 里的外部依赖（esbuild 无法 bundle 原生 .node），必须能从 bundle 所在目录
 * 解析到。放在这一份共享实现里，dev 与打包两边不会各自漂移 —— 与上面同理。
 */
export function stageAgentBundle({ repoRoot, platformKey, log = console.log }) {
  const { cliBundlePath, glmDir, stagedBundlePath, stagedMetaPath } = resolveAgentBundlePaths({
    repoRoot,
    platformKey,
  });
  if (!existsSync(cliBundlePath)) {
    throw new Error(`[stage:agent-bundle] agent bundle 源产物不存在：${cliBundlePath}`);
  }
  rmSync(glmDir, { recursive: true, force: true });
  mkdirSync(glmDir, { recursive: true });
  copyFileSync(cliBundlePath, stagedBundlePath);
  // 查找根与 electron-builder 的 runtimeModuleLookupRoots 同口径：pnpm hoisted 布局下
  // 依赖装在仓库根 node_modules，desktop 自己的 node_modules 兜底。
  const keyring = stageKeyringIntoBundledAgents({
    lookupRoots: [repoRoot, resolve(repoRoot, "packages", "desktop")],
    glmDir,
    targetPlatformKey: platformKey,
  });
  const meta = {
    runtime: "electron-node",
    entry: "zcode.cjs",
    platform: platformKey,
    source: AGENT_BUNDLE_SOURCE_RELATIVE,
    // 随 agent 树落盘的原生模块清单（相对 glm 目录的 node_modules）。无头分发包不经过本函数，
    // 其 agent 树里没有 keyring（import 失败归到 stage=load）；无头形态本来就只接受显式配置的
    // 密钥，缺失时拒绝就绪而不是自动生成（见 docs/operations/data-layout.md 的凭据一节）。
    nativeModules: {
      "@napi-rs/keyring": {
        version: keyring.version,
        platformVariant: keyring.platformVariant,
      },
    },
  };
  writeFileSync(stagedMetaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  log(`[stage:agent-bundle] staged ${stagedBundlePath}`);
  log(`[stage:agent-bundle] staged keyring ${keyring.version} (${keyring.platformVariant})`);
  return { stagedBundlePath, stagedMetaPath, keyring };
}
