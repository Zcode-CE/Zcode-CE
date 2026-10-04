import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export const seaOfficialPluginAssetPrefix = "zcode-official-plugins/";
export const seaOfficialPluginManifestAssetKey = `${seaOfficialPluginAssetPrefix}manifest.json`;
const browserUseRequiredRuntimePaths = [
  "scripts/browser-client.mjs",
  "docs/api.json",
  "docs/documents.json",
  "docs/overview.md",
  // recording lookup 是录屏 API 的模型入口，SEA 不得接受缺失正文的插件资产。
  "docs/recording.md",
  "docs/workflow.md",
  "skills/control-browser/SKILL.md",
  "skills/web-gui-tester/SKILL.md",
];

// 四个内容型插件（office 三件 + pdf）：只有 skills/agents/scripts（check_office.py 之类），
// 没有 MCP server、没有构建产物。requiresRuntime: false 让 collectSeaOfficialPluginAssets()
// 跳过 assertPluginRuntime() 的 dist/mcp/server.js 校验 —— 那个校验对内容型插件必然失败。
// office 三件此前完全没进这份清单，SEA 单文件可执行里因此不含 office 插件，用 SEA 发行
// 的用户拿不到 Office 能力；pdf 是同一批补齐的（C33）。
// version 取 official-plugin-definitions.ts 的 definition.value（权威归属）：
// 不一致会导致运行时按版本精确匹配失败、seed 不生效。个别插件（computer-use）
// 的 plugin.json manifest 版本与之有意不同，见该定义处的版本追踪注释。
//
// pdf 的 Node 载荷（scripts/pdf-node/*.cjs）不在源码树里（由 esbuild 现场产出），
// 所以 pdf 的 requiredSeedPaths 只有在载荷 staging 之后才可满足：build-sea 会先用
// prepareSeaPluginNodePayloads() 把四个内容插件连同 office-node/pdf-node 载荷一起 stage
// 到暂存副本，再通过 pluginRoots 让本收集器读那份副本。若直接用源码树收集 pdf，
// assertPluginRequiredSeedAssets() 会抛 missing —— 这条硬校验就是"载荷没 stage 就发包"
// 的构建期护栏（远端 prepare-prebuilds.mjs 是同款的两段式，见 remotePdfNodePayloadPaths
// 的注释）。
// office 三件：源码树里只有正文（skills/agents/scripts/check_office.py），
// requiredSeedPaths 与 official-plugin-definitions.ts 的同名条目一致。
const officeContentSeaPlugins = [
  { name: "documents", skill: "docx" },
  { name: "presentations", skill: "pptx" },
  { name: "spreadsheets", skill: "xlsx" },
].map(({ name, skill }) => ({
  marketplace: "zcode-plugins-official",
  name,
  packageName: `@zcode/${name}-plugin`,
  requiresRuntime: false,
  requiredSeedPaths: ["agents/visual-judge.md", `skills/${skill}/SKILL.md`],
  rootPath: join("packages", `${name}-plugin`),
  version: "0.1.7",
}));

// pdf 的 Node 载荷（pdfkit/fontkit 自包含 bundle）不在源码树（esbuild 现场产出），
// 由 prepareSeaPluginNodePayloads() stage 进暂存副本后经 pluginRoots 收集。
// requiredSeedPaths 与 official-plugin-definitions.ts 的 pdf 条目（含
// OFFICIAL_PDF_EXTRA_REQUIRED_SEED_PATHS）完全一致 —— 载荷没 stage 进副本时构建期
// 就会抛 missing，不会把"插件在、能力不在"的残缺资产嵌进二进制（task-6 实测过的失效形态）。
const pdfNodePayloadRequiredPaths = ["scripts/pdf-node/pdfkit.cjs", "scripts/pdf-node/fontkit.cjs"];
const pdfSeaPlugin = {
  marketplace: "zcode-plugins-official",
  name: "pdf",
  packageName: "@zcode/pdf-plugin",
  requiresRuntime: false,
  requiredSeedPaths: [
    "agents/visual-judge.md",
    "skills/pdf/SKILL.md",
    ...pdfNodePayloadRequiredPaths,
    "scripts/pdf-build.mjs",
    "scripts/check_pdf.mjs",
    "scripts/pdf-fonts.mjs",
  ],
  rootPath: join("packages", "pdf-plugin"),
  version: "0.1.7",
};

// Computer Use（对外插件名 computer-use，包目录 zcode-cua-plugin）：内容型条目 ——
// docs/scripts/skills 都在源码树，requiresRuntime: false（node_repl 宿主由独立的
// node-repl-host 条目嵌入，cua 自己不带 MCP server）。
// 原生驱动不随 SEA 嵌入：桌面链由 cua-driver-package-assets.mjs 把平台原生包
// stage 进 glm/packages/node-repl-host/node_modules，SEA 链没有等价步骤；SEA 用户启用
// 电脑控制时会走到 node-repl-host 的既有降级（captureComputerUseRuntimeFromEnvironment
// 返回 undefined + CUA_UNAVAILABLE_IN_SESSION_MESSAGE），是显式降级而非静默。
// version 取 official-plugin-definitions.ts 的 definition.version（computer-use = 0.6.3），
// 与 plugin.json 的 manifest 版本（0.6.1）有意不同 —— 版本追踪口径见该定义处注释。
const cuaSeaPlugin = {
  marketplace: "zcode-plugins-official",
  name: "computer-use",
  // 该插件包没有 package.json（按 F3-1 §9.1 的决策不补）；packageName 只用于
  // assertPluginRuntime 的错误文案，cua 走 requiresRuntime:false 永不触发。
  packageName: "@zcode/zcode-cua-plugin",
  requiresRuntime: false,
  requiredSeedPaths: [
    "docs/computer-use.md",
    "scripts/computer-use-client.mjs",
    "skills/computer-use/SKILL.md",
  ],
  rootPath: join("packages", "zcode-cua-plugin"),
  version: "0.6.3",
};

export const officialSeaPlugins = [
  {
    // node_repl 宿主：Browser Use 与 Computer Use 共用的运行时产物，自己不是面向用户的插件
    // （无 skill、无市场 listing）。它必须始终随发布物嵌入，否则任一能力启用时都没有宿主可跑。
    marketplace: "zcode-plugins-official",
    name: "node-repl-host",
    packageName: "@zcode/node-repl-host",
    requiresRuntime: true,
    requiredRuntimePaths: ["dist/mcp/server.js"],
    rootPath: join("packages", "node-repl-host"),
    version: "0.6.0",
  },
  {
    marketplace: "zcode-plugins-official",
    name: "browser-use",
    packageName: "@zcode/browser-use-plugin",
    requiresRuntime: true,
    // Browser Use 的 runtime、client、API 文档和 skills 是同一发布单元；
    // SEA 构建必须在嵌入前拒绝任一缺失项，不能把损坏产物留到用户启动时才发现。
    requiredRuntimePaths: browserUseRequiredRuntimePaths,
    rootPath: join("packages", "browser-use-plugin"),
    // SEA 清单仍指向旧版时，runtime 会与官方 definition 精确匹配失败，
    // 导致发布产物不 seed browser-use，进而无法装配宿主 node_repl MCP。
    version: "0.5.1",
  },

  cuaSeaPlugin,

  ...officeContentSeaPlugins,

  pdfSeaPlugin,
];

export const collectSeaOfficialPluginAssets = async ({
  requireRuntime = false,
  root,
  stagingDirectory,
  // 插件名 → 暂存副本绝对路径：内容插件的 Node 载荷不在源码树，由 build-sea 先用
  // prepareSeaPluginNodePayloads() 把插件 stage 到副本（载荷写进副本的 scripts/*-node/），
  // 再经此参数让收集器读副本而非源码树。缺省时全程读源码树（pdf 除外 —— 它的
  // requiredSeedPaths 含载荷路径，在纯源码树上必然抛 missing，见 pdfSeaPlugin 注释）。
  pluginRoots = {},
} = {}) => {
  const files = [];
  const assets = {};
  const plugins = [];

  await rm(stagingDirectory, {
    force: true,
    recursive: true,
  });

  for (const plugin of officialSeaPlugins) {
    const pluginRoot = pluginRoots[plugin.name] ?? resolve(root, plugin.rootPath);
    assertPluginRoot(pluginRoot, plugin);
    assertPluginRequiredSeedAssets(pluginRoot, plugin);
    // 只提供 skills 的内容型插件没有 MCP server，用 requiresRuntime:false 跳过校验；
    // 其余运行时插件仍要在此校验，避免发布缺失可执行入口的产物。
    if (requireRuntime && plugin.requiresRuntime !== false) assertPluginRuntime(pluginRoot, plugin);

    const pluginFiles = [];
    for await (const sourcePath of walkFiles(pluginRoot)) {
      const relativePath = relative(pluginRoot, sourcePath);
      if (!shouldIncludePluginFile(relativePath)) continue;

      const bytes = await readFile(sourcePath);
      const sourceStats = await stat(sourcePath);
      const assetPath = toPosixPath(
        join(plugin.marketplace, plugin.name, plugin.version, relativePath),
      );
      assets[`${seaOfficialPluginAssetPrefix}${assetPath}`] = sourcePath;
      const file = {
        mode: modeForSeedFile(relativePath, sourceStats.mode),
        path: toPosixPath(relativePath),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
      pluginFiles.push(file);
      files.push({
        ...file,
        plugin: plugin.name,
      });
    }

    pluginFiles.sort((left, right) => left.path.localeCompare(right.path));
    plugins.push({
      files: pluginFiles,
      marketplace: plugin.marketplace,
      name: plugin.name,
      version: plugin.version,
    });
  }

  plugins.sort((left, right) => left.name.localeCompare(right.name));
  const manifestHash = createHash("sha256")
    .update(
      JSON.stringify(
        plugins.map((plugin) => [
          plugin.marketplace,
          plugin.name,
          plugin.version,
          plugin.files.map(({ path, sha256, mode }) => [path, sha256, modeForSeedFile(path, mode)]),
        ]),
      ),
    )
    .digest("hex");
  const manifest = {
    hash: manifestHash,
    plugins,
    version: 1,
  };
  const manifestPath = resolve(stagingDirectory, "official-plugins-manifest.json");
  await mkdir(stagingDirectory, {
    recursive: true,
  });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  assets[seaOfficialPluginManifestAssetKey] = manifestPath;

  return {
    assets,
    manifest,
  };
};

function assertPluginRoot(pluginRoot, plugin) {
  if (!existsSync(join(pluginRoot, ".zcode-plugin", "plugin.json"))) {
    throw new Error(`Missing ${plugin.name} plugin manifest at ${pluginRoot}`);
  }
}

function assertPluginRequiredSeedAssets(pluginRoot, plugin) {
  for (const relativePath of plugin.requiredSeedPaths ?? []) {
    const assetPath = join(pluginRoot, ...relativePath.split("/"));
    if (!existsSync(assetPath)) {
      throw new Error(`Missing ${plugin.name} required seed asset at ${assetPath}`);
    }
  }
}

function assertPluginRuntime(pluginRoot, plugin) {
  for (const relativePath of plugin.requiredRuntimePaths ?? ["dist/mcp/server.js"]) {
    const runtimePath = join(pluginRoot, ...relativePath.split("/"));
    if (!existsSync(runtimePath)) {
      const assetKind = relativePath === "dist/mcp/server.js" ? "MCP runtime" : "runtime asset";
      throw new Error(
        `Missing ${plugin.name} ${assetKind} at ${runtimePath}. ` +
          `Run \`pnpm --filter ${plugin.packageName} build\` before \`pnpm sea\`.`,
      );
    }
  }
}

async function* walkFiles(directory) {
  const entries = await readdir(directory, {
    withFileTypes: true,
  });

  for (const entry of entries) {
    if (shouldSkipDirectory(entry.name)) continue;
    const fullPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(fullPath);
      continue;
    }
    if (entry.isFile()) {
      yield fullPath;
    }
  }
}

const shouldSkipDirectory = (name) =>
  name === "node_modules" ||
  name === ".turbo" ||
  name === "coverage" ||
  name === ".venv" ||
  name === "__pycache__";

const includedTopLevelPaths = new Set([
  ".mcp.json",
  ".zcode-plugin",
  "README.md",
  // SEA 资源采集曾只允许 skills/commands，导致 document-skills 的 judge 子代理未进入可执行文件。
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

const shouldIncludePluginFile = (relativePath) => {
  const segments = relativePath.split(sep);
  if (segments.includes(".DS_Store") || segments.some((segment) => segment.endsWith(".pyc"))) {
    return false;
  }
  const [topLevel] = relativePath.split(sep);
  return topLevel !== undefined && includedTopLevelPaths.has(topLevel);
};

const toPosixPath = (value) => value.split(sep).join("/");

const modeForSeedFile = (filePath, sourceMode) => {
  if (sourceMode !== undefined && (sourceMode & 0o111) !== 0) return 0o755;

  const normalizedPath = toPosixPath(filePath);
  if (/(?:^|\/)dist\/mcp\/server\.js$/i.test(normalizedPath)) return 0o755;
  if (/^hooks\//u.test(normalizedPath) && !/\.(json|md|txt)$/iu.test(normalizedPath)) {
    return 0o755;
  }

  return 0o644;
};
