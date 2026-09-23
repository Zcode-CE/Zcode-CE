#!/usr/bin/env node

// 桌面打包态的 agent 运行时资产：把 agent 的 JS bundle（zcode.cjs）放进 bundled-agents/<platform>/glm，
// 由 app 内置的 Electron Node runtime（ELECTRON_RUN_AS_NODE）执行，替代以前随包内置的独立 Node 二进制。
//
// 为什么这么做：
// - agent 没有任何原生 NAPI 插件（ripgrep 是 WASM，其余纯 JS），可直接跑在 Electron 的 Node 上；
// - Electron 41 内置 Node 24.x，与 zcode-cli 的目标运行时一致；
// - 单平台体积从 ~180MB 降到 ~16MB，且同一份 JS 跨平台通用；
// - app-server 命令路径不会加载 @zcode/tui，所以这里天然不打包 TUI。
//
// 远端（SSH/WSL/Docker）没有 Electron，仍走 prepare:remote-assets 的原生二进制，互不影响。

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runCommand } from "../../../scripts/spawn-command.mjs";
import { stageCuaDriverIntoBundledAgents } from "./cua-driver-package-assets.mjs";
import { stageOfficeNodePayloads as stageOfficeNodePayloadsIntoGlm } from "./office-node-payload-assets.mjs";
import { stagePdfNodePayloads as stagePdfNodePayloadsIntoGlm } from "./pdf-node-payload-assets.mjs";
import { stageKoffiIntoBundledAgents } from "./koffi-package-assets.mjs";
import { stageAgentBundle } from "./stage-agent-bundle.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const cliBundlePath = resolve(repoRoot, "apps/zcode-cli/packages/cli/dist/zcode.cjs");
const adaptersRoot = resolve(repoRoot, "apps/zcode-cli/packages/adapters");
const pnpmRunEnv = {
  ...process.env,
  // pnpm 11 会在 apps/zcode-cli 子 workspace 执行 run 前触发 install；
  // 子 workspace 不能解析根 workspace 的 @zcode/shared，Docker/web app 打包会因此卡在插件 runtime 构建。
  PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
};
const BROWSER_USE_PLUGIN_PACKAGE_NAME = "@zcode/browser-use-plugin";

// 平台目录命名：darwin/win32/linux + x64/arm64，
// 支持 ZCODE_TARGET_OS / ZCODE_TARGET_ARCH 覆盖（交叉打包时由 CI 注入）。
function normalizePlatform(raw) {
  switch (raw) {
    case "mac":
    case "macos":
    case "darwin":
    case "osx":
      return "darwin";
    case "win":
    case "windows":
    case "win32":
      return "win32";
    case "linux":
      return "linux";
    default:
      return raw;
  }
}

function normalizeArch(raw) {
  switch (raw) {
    case "x86_64":
    case "x64":
    case "amd64":
      return "x64";
    case "aarch64":
    case "arm64":
      return "arm64";
    default:
      return raw;
  }
}

const platform = normalizePlatform(process.env.ZCODE_TARGET_OS || "") || process.platform;
const arch = normalizeArch(process.env.ZCODE_TARGET_ARCH || "") || process.arch;
const platformKey = `${platform}-${arch}`;

const glmDir = resolve(desktopRoot, "bundled-agents", platformKey, "glm");
// zcode.cjs / .node-bundle-meta.json 的落点由 stage-agent-bundle.mjs 自己解析（同源）。
// node_repl 宿主抽成独立包
// @zcode/node-repl-host 之后，browser-use 不再产出 dist/mcp/server.js，CUA 资产
// （docs/computer-use.md、scripts/computer-use-client.mjs）也已归 @zcode/zcode-cua-plugin。
// 这份清单当时漏改，打包准备阶段照旧去 browser-use 要那三个文件，直接 missing runtime 挂掉。
// dev 链路走的是 scripts/build-desktop-agent-cli.mjs 的 requiredDevPluginRuntimeBuilds（那份改对了），
// 两份平行清单各自维护，所以 dev 测不出来 —— 权威归属见 bootstrap/official-plugin-definitions.ts。
const browserUseRequiredRuntimePaths = [
  "scripts/browser-client.mjs",
  "docs/api.json",
  "docs/documents.json",
  "docs/overview.md",
  // documents.json 已暴露 recording lookup，桌面安装包不能复用缺少正文的 runtime。
  "docs/recording.md",
  "docs/workflow.md",
  "skills/control-browser/SKILL.md",
  "skills/web-gui-tester/SKILL.md",
];
// Office 三个插件：纯资源包（skills/*/SKILL.md + scripts/check_office.py + agents/visual-judge.md），
// 没有任何构建产物，所以 requiresRuntime 为 false，且**不设** runtimeBuildScript
// —— 设了会让 buildOfficialPluginRuntimes() 去跑一个不存在的构建脚本。
//
// 为什么必须在这里出现：这三个插件此前完全没进任何 staging 清单，打包后
// resources/glm/packages 下不存在对应目录，filesystem seed 的三处 candidate 全部落空，
// 发行版用户拿不到 Office 能力（症状是「官方市场里有 Documents 插件、点进去却是空的」）。
// 权威归属见 bootstrap/official-plugin-definitions.ts（那里早已标了 defaultEnabled: true
// 和 requiredSeedPaths，只是没人把它反查到 staging 清单上）。
// 单列成表而不是复制三份字面量：三份平行清单各自手写正是本次漏加的同型根因
// （见上方常量注释里踩过的先例）；配套回归测试见 documents-plugin/test/。
const officePluginPackages = [
  { name: "documents", skill: "docx" },
  { name: "presentations", skill: "pptx" },
  { name: "spreadsheets", skill: "xlsx" },
];
// 纯内容型官方插件：只有 commands/skills，无 MCP server、无编译产物。
//
// 为什么必须有这四条：仓库早就按「它们存在」写好了装配，包却从未被搬进来 ——
//   · startup-marks.ts 的注释点名 skill-creator 是 defaultEnabled 的官方插件。
// 缺包时这些装配全部静默落空（症状：技能/命令在会话里找不到）。
// 注意：`/workflow` 与 dynamic-workflows 技能自官方 3.14.3 起**不再由 zcode-guide 提供** ——
// 命令成了内置命令、技能进了 bundled-skills（见下面的 stageBundledSkills）。
// requiredSeedPaths 与 bootstrap/official-plugin-definitions.ts 的同名常量逐条一致；
// 缺失时 stageOfficialPlugins() 抛 missing staged official plugin seed asset。
const contentPluginPackages = [
  {
    name: "zcode-guide",
    // 0.3.0 起该插件只剩自诊断 + 配置指南六份正文（workflow 命令与 dynamic-workflows 技能已迁出）。
    requiredSeedPaths: [
      "skills/diagnosing-commands/SKILL.md",
      "skills/diagnosing-hooks/SKILL.md",
      "skills/diagnosing-mcp/SKILL.md",
      "skills/diagnosing-plugins/SKILL.md",
      "skills/diagnosing-skills/SKILL.md",
      "skills/zcode-configuration-guide/SKILL.md",
    ],
  },
  { name: "skill-creator", requiredSeedPaths: ["skills/skill-creator/SKILL.md"] },
  {
    name: "plugin-creator",
    requiredSeedPaths: [
      "skills/plugin-creator/SKILL.md",
      "skills/plugin-creator/scripts/create-basic-plugin.mjs",
      "skills/plugin-creator/scripts/marketplace-files.mjs",
      "skills/plugin-creator/scripts/upsert-dev-marketplace.mjs",
      "skills/plugin-creator/scripts/scaffold-files.mjs",
      "skills/plugin-creator/scripts/validate-plugin.mjs",
      "skills/plugin-creator/references/plugin-json-spec.md",
      "skills/plugin-creator/references/installing-and-updating.md",
    ],
  },
  {
    name: "restore-legacy-sessions",
    requiredSeedPaths: [
      "commands/restore-legacy-sessions.md",
      "skills/restore-legacy-sessions/SKILL.md",
      "skills/restore-legacy-sessions/scripts/restore-conversation.mjs",
      "skills/restore-legacy-sessions/scripts/scan-legacy-sessions.mjs",
    ],
  },
];
// pdf 插件：内容（技能/生成器/校验器/字体助手）+ 单独的 Node 载荷（pdfkit/fontkit bundle）。
// 载荷由 stagePdfNodePayloads() 在 stageOfficialPlugins() **之后**落盘，所以这里只钉源码树里
// 已存在的资产；载荷路径钉在 bootstrap/official-plugin-definitions.ts 的 requiredSeedPaths 上
// —— 那一条是运行期闸门（缺载荷就不注册，见 .reverse/38-pdf/COMMIT-SHAPE.md）。
const pdfPluginPackages = [
  {
    name: "pdf",
    requiredSeedPaths: ["agents/visual-judge.md", "scripts/pdf-build.mjs", "skills/pdf/SKILL.md"],
  },
];
const officialPluginPackages = [
  {
    // browser-use 只携带自己的 client script 与 skill/docs；node_repl MCP runtime 归
    // @zcode/node-repl-host（见上方常量注释）。
    packageName: "@zcode/browser-use-plugin",
    relativePath: "apps/zcode-cli/packages/browser-use-plugin",
    requiresRuntime: true,
    requiredRuntimePaths: browserUseRequiredRuntimePaths,
    runtimeBuildScript: "scripts/build.mjs",
    stagedPath: "packages/browser-use-plugin",
  },

  {
    // node_repl 宿主：Browser Use 与 Computer Use 共用的 MCP runtime，本轮抽成独立包。
    // 它没有 listing（不进插件市场展示面），但生产包首启 seed 必须拿到它的 dist runtime，
    // 否则 bua/cua 任一开启时都会连不上 node_repl。
    packageName: "@zcode/node-repl-host",
    relativePath: "apps/zcode-cli/packages/node-repl-host",
    requiresRuntime: true,
    requiredRuntimePaths: ["dist/mcp/server.js"],
    runtimeBuildScript: "scripts/build.mjs",
    stagedPath: "packages/node-repl-host",
  },

  {
    // Computer Use 壳：官方发行包里的 MIT 资产（author Z.ai），只携带 skill/docs/SDK 三件套。
    // 它**没有**构建产物，MCP 运行时复用宿主注入的 node_repl（见上一条）——插件 manifest
    // 不声明 mcpServers，只把 node_repl 记在 hostMcpServerNames 上。
    // 这三件资产此前完全没进任何 staging 清单，打包产物里因此没有 packages/zcode-cua-plugin，
    // filesystem seed 的四个 rootCandidate 全部落空，设置页「启用电脑控制」直接报
    // Plugin not found: computer-use@zcode-plugins-official。
    packageName: "@zcode/zcode-cua-plugin",
    relativePath: "apps/zcode-cli/packages/zcode-cua-plugin",
    requiresRuntime: false,
    // 与 bootstrap/official-plugin-definitions.ts 的 OFFICIAL_CUA_REQUIRED_SEED_PATHS 一一对应：
    // 缺任一件时 stageOfficialPlugins() 抛 missing staged official plugin seed asset，
    // 而不是静默产出一个没有 skill 正文的残缺插件。
    requiredSeedPaths: [
      "docs/computer-use.md",
      "scripts/computer-use-client.mjs",
      "skills/computer-use/SKILL.md",
    ],
    stagedPath: "packages/zcode-cua-plugin",
  },

  ...officePluginPackages.map(({ name, skill }) => ({
    packageName: `@zcode/${name}-plugin`,
    relativePath: `apps/zcode-cli/packages/${name}-plugin`,
    requiresRuntime: false,
    // 与 official-plugin-definitions.ts 的 requiredSeedPaths 一致：缺失时 stageOfficialPlugins()
    // 直接抛错，而不是静默产出一个没有 skill 正文的残缺插件。
    requiredSeedPaths: ["agents/visual-judge.md", `skills/${skill}/SKILL.md`],
    stagedPath: `packages/${name}-plugin`,
  })),

  ...contentPluginPackages.map(({ name, requiredSeedPaths }) => ({
    packageName: `@zcode/${name}-plugin`,
    relativePath: `apps/zcode-cli/packages/${name}-plugin`,
    requiresRuntime: false,
    requiredSeedPaths,
    stagedPath: `packages/${name}-plugin`,
  })),

  ...pdfPluginPackages.map(({ name, requiredSeedPaths }) => ({
    packageName: `@zcode/${name}-plugin`,
    relativePath: `apps/zcode-cli/packages/${name}-plugin`,
    requiresRuntime: false,
    requiredSeedPaths,
    stagedPath: `packages/${name}-plugin`,
  })),
];
const includedOfficialPluginTopLevelPaths = new Set([
  ".mcp.json",
  ".zcode-plugin",
  "README.md",
  // Electron 生产资源复制有独立白名单，遗漏 agents 会让首启 filesystem seed 永久缺少子代理。
  "agents",
  "commands",
  "dist",
  "docs",
  "hooks",
  "output-styles",
  "package.json",
  "scripts",
  "skills",
  "templates",
]);
const excludedOfficialPluginAssetNames = new Set([
  ".DS_Store",
  ".venv",
  "__pycache__",
  "node_modules",
]);

function shouldCopyOfficialPluginAsset(sourcePath) {
  const name = basename(sourcePath);
  return !excludedOfficialPluginAssetNames.has(name) && !name.endsWith(".pyc");
}
const isBootstrapWithRemote = process.env.ZCODE_BOOTSTRAP_WITH_REMOTE === "1";

function buildCliBundle() {
  console.log("[prepare:agent-bundle] building zcode-cli app-server bundle ...");
  // 复用仓库根脚本（turbo build:desktop-agent --filter=@zcode/cli），命中缓存时几乎瞬时。
  runCommand(process.execPath, [resolve(repoRoot, "scripts/build-desktop-agent-cli.mjs")], {
    cwd: repoRoot,
    env: pnpmRunEnv,
  });
  if (!existsSync(cliBundlePath)) {
    throw new Error(
      `[prepare:agent-bundle] expected cli bundle missing after build: ${cliBundlePath}`,
    );
  }
}

function buildOfficialPluginRuntimes() {
  for (const plugin of officialPluginPackages) {
    if (!plugin.requiresRuntime) continue;
    console.log(`[prepare:agent-bundle] building ${plugin.packageName} runtime ...`);
    if (isBootstrapWithRemote) {
      buildOfficialPluginRuntimeForBootstrap(plugin);
      assertOfficialPluginRuntime(plugin);
      continue;
    }

    runCommand(
      "pnpm",
      ["--dir", resolve(repoRoot, "apps/zcode-cli"), "--filter", plugin.packageName, "build"],
      {
        cwd: repoRoot,
        env: pnpmRunEnv,
      },
    );
    assertOfficialPluginRuntime(plugin);
  }
}

function buildOfficialPluginRuntimeForBootstrap(plugin) {
  const pluginRoot = resolve(repoRoot, plugin.relativePath);
  const hasCompleteRuntime = plugin.requiredRuntimePaths.every((relativePath) =>
    existsSync(resolve(pluginRoot, ...relativePath.split("/"))),
  );
  if (plugin.packageName !== BROWSER_USE_PLUGIN_PACKAGE_NAME && hasCompleteRuntime) {
    console.log(
      `[prepare:agent-bundle] reuse existing official plugin runtime: ${plugin.packageName}`,
    );
    return;
  }

  // bootstrap:with-remote 会连续构建 remote assets 和桌面 agent bundle。
  // 通过 pnpm/filter 进入插件 build 时，tsc shim 在本地低内存环境中容易被 SIGKILL；
  // 这里仅在 bootstrap 开关下用当前 Node 直接执行等价 tsc + build-mcp，不改变插件自身 build 脚本。
  // browser-use 的 server 与 browser-client 是同一发布对；即使旧 server.js 存在也必须重建，
  // 否则会把旧 server 与当前 client（或缺失 client）一起 stage 到桌面安装包。
  runCommand(process.execPath, ["../../node_modules/typescript/bin/tsc"], {
    cwd: pluginRoot,
    env: process.env,
  });
  runCommand(process.execPath, [plugin.runtimeBuildScript], {
    cwd: pluginRoot,
    env: process.env,
  });
}

function assertOfficialPluginRuntime(plugin) {
  const pluginRoot = resolve(repoRoot, plugin.relativePath);
  for (const relativePath of plugin.requiredRuntimePaths) {
    const runtimePath = resolve(pluginRoot, ...relativePath.split("/"));
    if (!existsSync(runtimePath)) {
      throw new Error(`[prepare:agent-bundle] missing official plugin runtime: ${runtimePath}`);
    }
  }
}

function stageBundle() {
  // 实现已抽到 stage-agent-bundle.mjs：dev 链（scripts/build-desktop-agent-cli.mjs）
  // 必须用同一份，否则 dev 会继续跑上一次打包留下的陈旧 agent。
  stageAgentBundle({ repoRoot, platformKey });
}

/**
 * 把 Computer Use 驱动及其平台原生依赖 stage 进 glm/node_modules。
 *
 * 为什么必须在 stageBundle() 之后：stageAgentBundle 会**清空并重建** glm 目录
 * （刻意的，避免上次构建的残留原生二进制被打进包），所以 staging 顺序反了会被删掉。
 *
 * 为什么需要：node-repl-host 的 bundle 用运行时 import() 加载原生驱动，
 * 而 staged 树默认没有 node_modules —— 正式包里那一跳会 ERR_MODULE_NOT_FOUND。
 * 详见 cua-driver-package-assets.mjs 的模块注释。
 */
function stageCuaDriver() {
  const { staged, triple } = stageCuaDriverIntoBundledAgents({
    // 查找根与 electron-builder 的 runtimeModuleLookupRoots 同口径：根 node_modules
    // 是 pnpm hoisted 布局下的主落点，desktop 自己的 node_modules 兜底。
    lookupRoots: [repoRoot, desktopRoot],
    glmDir,
    // 与上面 platformKey 同源：支持 ZCODE_TARGET_OS/ARCH 交叉准备。
    targetPlatform: {
      os: platform,
      arch,
      key: platformKey,
      npmLibc: platform === "linux" ? "glibc" : undefined,
    },
  });
  const bytes = staged.reduce((sum, item) => sum + item.size, 0);
  console.log(
    `[prepare:agent-bundle] staged Computer Use driver (${triple}): ` +
      `${staged.length} packages, ${(bytes / 1024 / 1024).toFixed(1)} MiB`,
  );
}

/**
 * 把 koffi 的原生 addon stage 进 node-repl-host/node_modules/koffi。
 *
 * 为什么需要：koffi 是 CLI bundle 的 external（apps/zcode-cli/packages/cli/scripts/build.mjs
 * 的 resolveBuildExternal），因为 esbuild 无法 bundle 它按平台动态 require 的 .node。
 * 它只被 Windows 的 Job Object 路径使用（adapters/src/mcp/windows-job-object.ts），
 * 而安装后的 agent 没有 hoisted node_modules —— 不 stage 就永远拿不到。
 *
 * 现状说明（**既有缺陷，非本次引入**）：`stageKoffiIntoBundledAgents` 此前**没有任何
 * 调用点**（koffi-package-assets.mjs 只有定义；electron-builder.config.js 只 import 了
 * verifyStagedKoffi 也没调用）。这里补上调用点，让它真正生效。
 * 影响面很小：koffi 只在 win32 分支加载，加载失败时 windows-job-object.ts 会
 * return undefined 并退回 taskkill，所以此前是"功能降级"而非崩溃。
 *
 * 落点与 Computer Use 驱动一致（node-repl-host/node_modules）：electron-builder 会
 * 硬编码丢弃**源根直属**的 node_modules，放 glm/node_modules 打不进包。
 */
function stageKoffiRuntime() {
  try {
    const nativePath = stageKoffiIntoBundledAgents({
      koffiPackageRoot: repoRoot,
      glmDir: resolve(glmDir, "packages/node-repl-host"),
      targetPlatform: {
        os: platform,
        arch,
        key: platformKey,
        npmLibc: platform === "linux" ? "glibc" : undefined,
      },
    });
    console.log(`[prepare:agent-bundle] staged koffi runtime: ${nativePath}`);
  } catch (error) {
    // koffi 缺失只影响 Windows 的 Job Object 清理（有 taskkill 回退），
    // 不应该让 Linux/macOS 的打包整体失败。
    console.warn(
      `[prepare:agent-bundle] koffi runtime 未 stage（Windows Job Object 将退回 taskkill）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

// 内置技能包（bundled-skills）：官方 3.14.3 起 dynamic-workflows 住在这里。
//
// 它不是插件（没有 `.zcode-plugin/plugin.json`），所以不能走 stageOfficialPlugins；
// 但落点与官方插件同级（`packages/bundled-skills`），因为运行时用的是同一套候选基目录
// （bootstrap/src/app/entrypoint-candidates.ts）。
// 缺任一必需资产时运行时**整包拒收**并 warn（bundled-skills.ts），所以这里做同样的硬校验，
// 让问题在构建期就暴露，而不是等用户发现技能没了。
const bundledSkillsRequiredPaths = [
  "skills/dynamic-workflows/SKILL.md",
  "skills/dynamic-workflows/patterns.md",
  "skills/dynamic-workflows/examples.md",
];
const bundledSkillsTopLevelPaths = ["README.md", "skills"];

function stageBundledSkills() {
  const sourceRoot = resolve(repoRoot, "apps/zcode-cli/packages/bundled-skills");
  const targetRoot = resolve(glmDir, "packages/bundled-skills");
  mkdirSync(targetRoot, { recursive: true });
  for (const entryName of bundledSkillsTopLevelPaths) {
    const sourcePath = resolve(sourceRoot, entryName);
    if (!existsSync(sourcePath)) continue;
    cpSync(sourcePath, resolve(targetRoot, entryName), { recursive: true });
  }
  for (const relativePath of bundledSkillsRequiredPaths) {
    const stagedAssetPath = resolve(targetRoot, ...relativePath.split("/"));
    if (!existsSync(stagedAssetPath)) {
      throw new Error(
        `[prepare:agent-bundle] missing staged bundled skill asset: ${stagedAssetPath}`,
      );
    }
  }
  console.log("[prepare:agent-bundle] staged bundled skills (packages/bundled-skills)");
}

/**
 * 办公插件的 Node 运行时载荷（docx / pptxgenjs / exceljs）—— esbuild 自包含 bundle。
 *
 * 为什么必须在 stageBundle() **之后**：glm 目录会被清空重建。
 * 为什么必须在 stageOfficialPlugins() **之后**：那一步会 cpSync 插件的 `scripts` 目录，
 * 顺序反了会把刚写进去的 bundle 覆盖掉（落点就在 `<plugin>/scripts/office-node/`）。
 *
 * 落点选 `scripts/office-node/` 而不是 node_modules：seed 阶段
 * `bundled-plugins.ts:642` 的 `shouldSkipDirectory` 只在「插件根直属 + 顶层白名单含 node_modules」
 * 时保留 node_modules，**任何嵌套层一律丢弃**；bundle 没有 node_modules 目录，从根上不受该规则
 * 与 electron-builder `util/filter.js` 同款特判的影响。打包口径与 unzipper 排除的完整理由见
 * office-node-payload-assets.mjs 的模块注释。
 */
async function stageOfficeNodePayloads() {
  const staged = await stageOfficeNodePayloadsIntoGlm({
    lookupRoots: [repoRoot, desktopRoot],
    glmDir,
  });
  const bytes = staged.reduce((sum, item) => sum + item.bytes, 0);
  for (const item of staged) {
    // 落盘存在性校验：这一步是「stage 出的文件在磁盘上」的构建期护栏。它与运行期的
    // requiredSeedPaths 校验是**两层**（后者才覆盖「seed 后还在不在」），两层都要有。
    if (!existsSync(item.target)) {
      throw new Error(`[prepare:agent-bundle] missing staged office node bundle: ${item.target}`);
    }
    console.log(
      `[prepare:agent-bundle] staged office node bundle ${item.plugin}: ` +
        `${item.library}@${item.version} (${item.packages.length} packages inlined, ` +
        `${(item.bytes / 1024 / 1024).toFixed(2)} MiB)`,
    );
  }
  console.log(
    `[prepare:agent-bundle] staged office node bundles total: ${(bytes / 1024 / 1024).toFixed(2)} MiB`,
  );
}

/**
 * pdf 插件的 Node 运行时载荷（pdfkit / fontkit）—— esbuild 自包含 bundle。
 *
 * 为什么必须在 stageOfficialPlugins() **之后**：那一步会 cpSync 插件的 `scripts` 目录，
 * 顺序反了会把刚写进去的 bundle 覆盖掉（落点就在 `<plugin>/scripts/pdf-node/`）。
 * 打包口径与"为什么不放 node_modules"见 pdf-node-payload-assets.mjs 的模块注释。
 */
async function stagePdfNodePayloads() {
  const staged = await stagePdfNodePayloadsIntoGlm({
    lookupRoots: [repoRoot, desktopRoot],
    glmDir,
  });
  const bytes = staged.reduce((sum, item) => sum + item.bytes, 0);
  for (const item of staged) {
    // 落盘存在性校验：构建期护栏。与运行期的 requiredSeedPaths 校验是两层
    // （后者才覆盖「seed 后还在不在」），两层都要有。
    if (!existsSync(item.target)) {
      throw new Error(`[prepare:agent-bundle] missing staged pdf node bundle: ${item.target}`);
    }
    console.log(
      `[prepare:agent-bundle] staged pdf node bundle ${item.plugin}: ` +
        `${item.library}@${item.version} (${item.packages.length} packages inlined, ` +
        `${(item.bytes / 1024 / 1024).toFixed(2)} MiB)`,
    );
  }
  console.log(
    `[prepare:agent-bundle] staged pdf node bundles total: ${(bytes / 1024 / 1024).toFixed(2)} MiB`,
  );
}

function stageOfficialPlugins() {
  for (const plugin of officialPluginPackages) {
    const sourceRoot = resolve(repoRoot, plugin.relativePath);
    const manifestPath = resolve(sourceRoot, ".zcode-plugin", "plugin.json");
    if (!existsSync(manifestPath)) {
      throw new Error(`[prepare:agent-bundle] missing official plugin manifest: ${manifestPath}`);
    }

    const targetRoot = resolve(glmDir, plugin.stagedPath);
    mkdirSync(targetRoot, { recursive: true });
    for (const entryName of includedOfficialPluginTopLevelPaths) {
      const sourcePath = resolve(sourceRoot, entryName);
      if (!existsSync(sourcePath)) continue;
      cpSync(sourcePath, resolve(targetRoot, entryName), {
        recursive: true,
        filter: shouldCopyOfficialPluginAsset,
      });
    }
    for (const relativePath of plugin.requiredSeedPaths ?? []) {
      const stagedAssetPath = resolve(targetRoot, ...relativePath.split("/"));
      if (!existsSync(stagedAssetPath)) {
        throw new Error(
          `[prepare:agent-bundle] missing staged official plugin seed asset: ${stagedAssetPath}`,
        );
      }
    }
    console.log(`[prepare:agent-bundle] staged official plugin ${plugin.stagedPath}`);
  }
}

// Electron 生产包只带 resources/glm/zcode.cjs 时，app-server 进程的
// __dirname 附近没有官方插件目录，启动时 seed 找不到 source，用户侧不会自动得到内置插件。
// 这里把官方插件按 bootstrap 的 rootCandidates 期望放到 glm/packages/*-plugin，
// 让 Electron Node 运行 zcode.cjs 时复用同一套 filesystem seed 逻辑。
// browser-use runtime 的声明生成依赖 @zcode/core/dist。CI 干净检出没有该产物，
// 必须先构建 CLI 依赖，再构建官方插件；开发机残留的 dist 曾掩盖这个顺序问题。
buildCliBundle();
buildOfficialPluginRuntimes();
stageBundle();
stageCuaDriver();
stageKoffiRuntime();
stageOfficialPlugins();
stageBundledSkills();
// 必须排在 stageOfficialPlugins() 之后：后者 cpSync 插件的 scripts/ 目录，
// 会把落点在同一目录下的 bundle 覆盖掉（bundle 落点见该函数注释）。
await stageOfficeNodePayloads();
// 同样是"必须在 stageOfficialPlugins() 之后"的载荷，落点 <plugin>/scripts/pdf-node/。
await stagePdfNodePayloads();
