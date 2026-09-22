// dev 运行链的载荷 staging：让 `pnpm dev:desktop` 下的 office 与 Computer Use 与打包态**同能力**。
//
// ## 为什么需要这个模块（缺陷的完整因果）
//
// dev 的 agent 入口由 `zcodeAgentProcessManager.resolveBundledWorkspaceZCodeAgentCommand()`
// 以 findUpward 解析到 `apps/zcode-cli/packages/cli/dist/zcode.cjs`（**刻意**优先源码 dist，
// 让 dev 改源码立刻生效，见该函数注释）。于是 seed 的候选基目录
// （bootstrap/src/app/entrypoint-candidates.ts）是 `[cli/dist, cli/dist, cwd]`，
// 官方插件的 rootCandidates 里 `packages/<name>` 命中 cli/dist 同级的 `packages/`，
// `../../<name>-plugin` 命中**源树**。
//
// 源树里没有两类**构建期**载荷：
//   · office 三库的自包含 bundle（`scripts/office-node/*.cjs`，由 esbuild 产出）；
//   · Computer Use 驱动的原生包（`node-repl-host/node_modules/@trycua/**`，46 MB）。
//
// ⇒ dev 下 office 技能 require 失败；第一次调 CUA 拿到与用户报错**逐字相同**的
// `Cannot find package '@trycua/cua-driver'`。打包链（prepare-agent-node-bundle.mjs）
// 一直有这两步 stage，但**只 stage 到 `bundled-agents/<key>/glm`** —— 而 dev 根本不读 glm
// （候选基目录里没有它），所以那一步对 dev 完全无效。
//
// ## 解法：复用打包链同一份 stage 实现，只换落点
//
// 落点 = `apps/zcode-cli/packages/cli/dist/packages/<plugin>`（打包链是
// `bundled-agents/<key>/glm/packages/<plugin>`）。两者调用的是**同一对**函数
// （stageOfficeNodePayloads / stageCuaDriverIntoBundledAgents），所以不可能再各自漂移。
//
// ## 为什么落 cli/dist，而不是源树（三个实测理由）
//
// 1. **不可能被误提交**：`apps/zcode-cli/.gitignore` 已有 `dist/`，整个落点被忽略；
//    落源树则要在三个 office 插件各新建 .gitignore。
// 2. **许可门禁不会崩、也不会持续漂移**：三个 office 插件是
//    `third-party/copied-components.json` 的**整目录 root**，生成物放进源树会进
//    `inventory.inputs`（实测：放一个 PROBE.cjs 进 `scripts/office-node/`，重跑 notices
//    后它确实进了 inputs）。而生成物被 .gitignore 排除、**不进版本库**，于是有两条失败路径：
//      · 路径 A（**新克隆** / clean 后）：`inventory.inputs` 记着它、但文件不存在 ⇒
//        `third-party-notices.mjs` 第 22 行的 readFile **先于**第 23 行的 hash 比对执行 ⇒
//        `licenses:check` 直接 **ENOENT 崩溃**（不是「输入已变」那条友好报错）。实测报错：
//        `Error: ENOENT: no such file or directory, open '…/scripts/office-node/docx.cjs'`。
//      · 路径 B（本地构建过、产物内容变了）：每次重建字节不同 ⇒ 每次都报
//        `Third-party input changed: …` ⇒ 需要反复重跑 notices。
//    落 `cli/dist` 两条都不存在：它不在任何 copied root 下。
// 3. **不搬源树 devDeps**：落 cli/dist 时 node-repl-host 的 `node_modules` 由
//    stageCuaDriverIntoBundledAgents **新建**，只含驱动闭包；落源树则会把源树那 84 MiB
//    devDeps（@esbuild/esbuild/typescript/undici-types）一起 seed 进用户 cache
//    —— AUDIT-2 §2.3 实测 83.3 MiB，纯浪费。
//
// ## 只 stage「带载荷」的插件
//
// 清单**从载荷模块自身派生**（office 用 OFFICE_NODE_BUNDLES、CUA 用
// CUA_DRIVER_PLUGIN_DIR_NAME），不手写第二份 —— 平行清单各自漂移正是本类缺陷的根因。
// 其余六个官方插件不含构建期载荷，继续由源树直接提供，dev「改源码立刻生效」的语义不受影响。
//
// koffi **不需要**在 dev stage：它只在 win32 分支被 adapters 用 `await import("koffi")`
// 加载，而 dev 的 CLI bundle 在 `cli/dist` 下能沿祖先链命中仓库根 `node_modules/koffi`
// （hoisted 布局）。打包态没有祖先链，才需要 prepare-agent-node-bundle 的 stageKoffiRuntime。
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CUA_DRIVER_PLUGIN_DIR_NAME,
  stageCuaDriverIntoBundledAgents,
} from "./cua-driver-package-assets.mjs";
import { OFFICE_NODE_BUNDLES, stageOfficeNodePayloads } from "./office-node-payload-assets.mjs";
import { getTargetPlatform } from "./target-platform.mjs";

/** dev 的 agent 入口相对仓库根的路径。与 stage-agent-bundle.mjs 的源产物同源。 */
const DEV_AGENT_ENTRY_RELATIVE = "apps/zcode-cli/packages/cli/dist/zcode.cjs";

/** 源树插件目录的父目录。 */
const DEV_PLUGIN_SOURCE_RELATIVE = "apps/zcode-cli/packages";

/**
 * 拷贝插件树时要排除的条目名。
 *
 * `node_modules` **必须**排除：它是「不搬源树 devDeps」那条的落点 —— 排除后
 * stageCuaDriverIntoBundledAgents 会在目标位置新建一个只含驱动闭包的 node_modules。
 * 其余三项与 seed 的 `shouldSkipDirectory` 同口径（不随包发、且平台无关的构建垃圾）。
 */
const DEV_PLUGIN_COPY_EXCLUDED_NAMES = new Set([
  ".DS_Store",
  ".turbo",
  "__pycache__",
  "coverage",
  "node_modules",
]);

/**
 * dev 的 staged 资产根：与 agent 入口**同目录**，即 seed 候选基目录的第一顺位。
 *
 * 与 agent 入口同目录不是巧合而是必要条件：`entrypoint-candidates.ts` 的第一顺位是
 * `dirname(process.argv[1])`，而 dev 的 argv[1] 就是这个 `zcode.cjs`。
 */
export function resolveDevAgentAssetRoot({ repoRoot }) {
  return resolve(repoRoot, DEV_AGENT_ENTRY_RELATIVE, "..");
}

/** dev 需要 stage 的插件目录名（从载荷模块派生，不手写第二份清单）。 */
export function listDevPayloadPluginDirNames() {
  return [
    ...new Set([...OFFICE_NODE_BUNDLES.map((bundle) => bundle.plugin), CUA_DRIVER_PLUGIN_DIR_NAME]),
  ].sort();
}

/**
 * 把源树插件目录拷成 staged 插件根。
 *
 * 为什么整目录拷而不是按打包链的 `includedOfficialPluginTopLevelPaths` 白名单挑：
 * 真正决定「什么进运行时」的是 **seed 自己的白名单**（bundled-plugins.ts 的
 * includedTopLevelPaths ∪ 该插件的 runtimeTopLevelPaths），这里多拷的文件不会进 cache。
 * 反之，如果这里再维护一份顶层白名单，打包链那份改了、这份没改时 dev 会静默少文件 ——
 * 正是本类缺陷的复发形态。所以这里只做「忠实拷贝 + 排除构建垃圾」。
 */
function copyPluginTree({ sourceDir, targetDir }) {
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (DEV_PLUGIN_COPY_EXCLUDED_NAMES.has(entry.name)) continue;
    if (entry.name.endsWith(".pyc")) continue;
    cpSync(join(sourceDir, entry.name), join(targetDir, entry.name), { recursive: true });
  }
}

/**
 * 把 dev 运行链需要的构建期载荷 stage 到 `cli/dist/packages/<plugin>`。
 *
 * 顺序与打包链一致且不可颠倒：
 *   1. 先拷插件树（stageOfficeNodePayloads 要求插件目录已存在，否则抛错）；
 *   2. 再 stage office bundle（落点是 `<plugin>/scripts/office-node/`，会被插件树拷贝覆盖）；
 *   3. 最后 stage CUA 驱动（落点是 `<plugin>/node_modules/`，与插件树拷贝互不重叠）。
 *
 * @param {{ repoRoot: string, assetRoot?: string, log?: (message: string) => void }} input
 *   `assetRoot` 仅供测试注入临时目录；生产调用一律走 {@link resolveDevAgentAssetRoot}。
 */
export async function stageDevAgentPayloads({ repoRoot, assetRoot, log = console.log }) {
  const resolvedAssetRoot = assetRoot ?? resolveDevAgentAssetRoot({ repoRoot });
  const sourcePackagesRoot = resolve(repoRoot, DEV_PLUGIN_SOURCE_RELATIVE);
  const pluginDirNames = listDevPayloadPluginDirNames();

  for (const pluginDirName of pluginDirNames) {
    const sourceDir = resolve(sourcePackagesRoot, pluginDirName);
    if (!existsSync(join(sourceDir, ".zcode-plugin", "plugin.json"))) {
      throw new Error(
        `[dev-agent-payloads] 插件源目录不存在或缺 manifest：${sourceDir}；` +
          "载荷清单与源树目录名已不一致（见 listDevPayloadPluginDirNames 的派生来源）",
      );
    }
    copyPluginTree({ sourceDir, targetDir: resolve(resolvedAssetRoot, "packages", pluginDirName) });
  }

  const officeStaged = await stageOfficeNodePayloads({
    // 查找根与打包链同口径：根 node_modules 是 pnpm hoisted 布局下的主落点。
    lookupRoots: [repoRoot, resolve(repoRoot, "packages", "desktop")],
    glmDir: resolvedAssetRoot,
  });
  for (const item of officeStaged) {
    if (!existsSync(item.target)) {
      throw new Error(`[dev-agent-payloads] office bundle 未落盘：${item.target}`);
    }
    log(
      `[dev-agent-payloads] staged office node bundle ${item.plugin}: ` +
        `${item.library}@${item.version} (${(item.bytes / 1024 / 1024).toFixed(2)} MiB)`,
    );
  }

  const cua = stageCuaDriverIntoBundledAgents({
    lookupRoots: [repoRoot, resolve(repoRoot, "packages", "desktop")],
    glmDir: resolvedAssetRoot,
    // dev 只跑宿主平台；getTargetPlatform 与打包链共用同一份 ZCODE_TARGET_* 口径。
    targetPlatform: getTargetPlatform(),
  });
  const driverPresent = existsSync(
    join(cua.nodeModulesDir, "@trycua", "cua-driver", "package.json"),
  );
  if (!driverPresent) {
    throw new Error(`[dev-agent-payloads] CUA 驱动未落盘：${cua.nodeModulesDir}`);
  }
  const bytes = cua.staged.reduce((sum, item) => sum + item.size, 0);
  log(
    `[dev-agent-payloads] staged Computer Use driver (${cua.triple}): ` +
      `${cua.staged.length} packages, ${(bytes / 1024 / 1024).toFixed(1)} MiB`,
  );

  return { assetRoot: resolvedAssetRoot, officeStaged, cua };
}
