// SEA 官方插件的 Node 载荷 staging：把需要 Node 运行时载荷的内容插件
// （office 三件 + pdf）从源码树拷到暂存副本，再把 office-node / pdf-node 的
// esbuild 自包含 bundle 写进副本，供 collectSeaOfficialPluginAssets() 经 pluginRoots 收集。
//
// ## 为什么 SEA 需要这一步
// 内容插件的"正文"（skills/agents/scripts 源文件）在源码树里，但生成能力依赖
// esbuild 现场产出的自包含 bundle（docx/pptxgenjs/exceljs/pdfkit/fontkit）：
//   documents-plugin/scripts/office-node/docx.cjs
//   pdf-plugin/scripts/pdf-node/{pdfkit,fontkit}.cjs
// 这些文件不在 git 里，SEA 收集器直接读源码树会缺载荷 —— pdf 的 requiredSeedPaths
// 钉住了载荷路径，缺了会在构建期抛 missing（见 sea-official-plugin-assets.mjs 的 pdf 注释）。
//
// ## 为什么拷副本而不是写进源码树
// 构建不应污染源码树（多 target 共享同一份源；写进去会让桌面/远端链与 git 状态
// 产生未声明依赖）。拷贝用与收集器同款的顶层白名单 + 排除规则，保证副本里
// 只有会进 SEA 的文件（node_modules / .turbo / __pycache__ 等不拷）。
//
// ## 顺序
// 必须在 collectSeaOfficialPluginAssets() 之前调用：收集器按 pluginRoots 读副本。
// 载荷生成器（stageOfficeNode/stagePdfNode）要求 glm 布局 <glmDir>/packages/<plugin>，
// 所以副本按那个布局落盘，返回的 pluginRoots 直接指向 <glmDir>/packages/<name>-plugin。
//
// ## 远端同款
// prepare-prebuilds.mjs 的 stageRemoteOfficeNodePayloads / stageRemotePdfNodePayloads
// 是同一条链的远端版本（stage 副本在前、载荷在后）；本模块复用桌面侧同一个
// payload 生成器（packages/desktop/scripts/*-node-payload-assets.mjs），不重写打包逻辑。
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { stageOfficeNodePayloads } from "../../../../../packages/desktop/scripts/office-node-payload-assets.mjs";
import { stagePdfNodePayloads } from "../../../../../packages/desktop/scripts/pdf-node-payload-assets.mjs";

/** 需要载荷暂存副本的内容插件（SEA 清单条目目录名）。 */
const SEA_PAYLOAD_PLUGIN_DIRECTORIES = [
  "documents-plugin",
  "presentations-plugin",
  "spreadsheets-plugin",
  "pdf-plugin",
];

/**
 * 与收集器（sea-official-plugin-assets.mjs）及桌面/远端 staging 同源的顶层白名单。
 * 多写一份而不跨包导入：SEA 收集器是 .mjs、不跨包导入桌面脚本（本模块是唯一例外，
 * 它需要载荷生成器），顶层白名单的一致性由 packages/services/test 的闭包测试钉住。
 */
const includedPluginTopLevelPaths = new Set([
  ".mcp.json",
  ".zcode-plugin",
  "README.md",
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

const excludedCopyEntryNames = new Set([
  ".DS_Store",
  ".turbo",
  ".venv",
  "__pycache__",
  "coverage",
  "node_modules",
]);

function shouldCopyPluginAsset(sourcePath) {
  const name = basename(sourcePath);
  return !excludedCopyEntryNames.has(name) && !name.endsWith(".pyc");
}

function copyPluginIntoStagingGLM({ sourceRoot, glmDir, pluginDirectory }) {
  const manifestPath = resolve(sourceRoot, ".zcode-plugin", "plugin.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`[sea-plugin-node-payloads] missing plugin manifest: ${manifestPath}`);
  }
  const targetRoot = resolve(glmDir, "packages", pluginDirectory);
  mkdirSync(targetRoot, { recursive: true });
  for (const entryName of readdirSync(sourceRoot)) {
    if (!includedPluginTopLevelPaths.has(entryName)) continue;
    const sourcePath = resolve(sourceRoot, entryName);
    // 白名单成员仍可能不存在（不是每个插件都有 commands/hooks/dist）。
    if (!existsSync(sourcePath)) continue;
    cpSync(sourcePath, resolve(targetRoot, entryName), {
      recursive: true,
      filter: shouldCopyPluginAsset,
    });
  }
  return targetRoot;
}

/**
 * 为 SEA 收集准备带 Node 载荷的内容插件暂存副本。
 *
 * @param root CLI 包根（`apps/zcode-cli`），插件位于 `<root>/packages/<pluginDirectory>`
 * @param stagingDirectory 本 target 的暂存目录；会先清空，副本落在 `<stagingDirectory>/glm/packages/*`
 * @param lookupRoots 载荷库解析根（与桌面/远端同款：[repoRoot, packages/desktop]）
 * @returns { pluginRoots, staged }：pluginRoots 按 SEA 清单插件名（documents/presentations/
 *          spreadsheets/pdf）给出副本绝对路径；staged 是载荷明细（版本/体积/内联包）。
 */
export const prepareSeaPluginNodePayloads = async ({ root, stagingDirectory, lookupRoots }) => {
  const glmDir = resolve(stagingDirectory, "glm");
  rmSync(stagingDirectory, { force: true, recursive: true });

  const pluginRoots = {};
  for (const pluginDirectory of SEA_PAYLOAD_PLUGIN_DIRECTORIES) {
    const sourceRoot = resolve(root, "packages", pluginDirectory);
    const targetRoot = copyPluginIntoStagingGLM({ sourceRoot, glmDir, pluginDirectory });
    // SEA 清单的插件名是 documents/presentations/spreadsheets/pdf（目录名去 -plugin）。
    pluginRoots[pluginDirectory.replace(/-plugin$/, "")] = targetRoot;
  }

  const officeStaged = await stageOfficeNodePayloads({ lookupRoots, glmDir });
  const pdfStaged = await stagePdfNodePayloads({ lookupRoots, glmDir });
  const staged = [...officeStaged, ...pdfStaged];
  for (const item of staged) {
    // 落盘存在性校验（构建期护栏）：载荷是 esbuild 现场产物，写盘失败不重试会
    // 产出"插件在、能力不在"的残缺资产 —— pdf 的 requiredSeedPaths 会先在收集器
    // 抛 missing，但这里更早给出可定位的错误。
    if (!existsSync(item.target)) {
      throw new Error(`[sea-plugin-node-payloads] missing staged payload bundle: ${item.target}`);
    }
  }
  const bytes = staged.reduce((sum, item) => sum + item.bytes, 0);
  console.log(
    `[sea-plugin-node-payloads] staged ${staged.length} node payload bundles into ${glmDir} (${(bytes / 1024 / 1024).toFixed(2)} MiB)`,
  );
  return { pluginRoots, staged };
};
