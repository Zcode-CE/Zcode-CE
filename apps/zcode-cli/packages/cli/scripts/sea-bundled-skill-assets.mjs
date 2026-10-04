// 随 CLI 内置的技能包（apps/zcode-cli/packages/bundled-skills）的 SEA（单文件可执行）资产采集。
//
// 它不是官方插件：不进市场目录、没有版本身份，运行时按内容 hash 解包到
// `<cli storage>/bundled-skills/<hash>/`（bootstrap/src/app/bundled-skills.ts 的
// materializeSeaBundledSkillPack）。这里的 manifest 形状与那边的读取逐字对应：
//   - 资产键前缀 `zcode-bundled-skills/` + 清单键 `zcode-bundled-skills/manifest.json`；
//   - 每个文件带 sha256，运行时解包时逐个复核（缺一或哈希不符即整包拒收并降级到旧缓存）。
//
// ## 为什么现在才补
// task-52（3.14.3 跟进）只做了桌面链：bundled-skills.ts 解析器 + 两侧 staging 清单
// （prepare-agent-node-bundle.mjs 的 stageBundledSkills 与 prepare-prebuilds.mjs 的
// stageRemoteBundledSkills）。SEA 那条链当时刻意留下（见 .reverse/25-v3143/BUNDLED-SKILLS.md
// §6.1），因为 SEA 清单本身还缺一堆插件；本批连同 sea-official-plugin-assets.mjs 一起补齐。
//
// ## 与 official-plugins 采集的区别
// 官方插件按 marketplace/name/version 分键（运行时按版本精确匹配 definition）；
// bundled-skills 没有版本身份，只按内容 hash 标识身份——清单的 hash 就是全部版本号。
// 所以这里只走 `skills` 子树（README 不是运行时资产，桌面 staging 另带它是因为它面向
// 人读；SEA 嵌入只保留运行时必需文件，体积归零到能力本身）。
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export const seaBundledSkillAssetPrefix = "zcode-bundled-skills/";
export const seaBundledSkillManifestAssetKey = `${seaBundledSkillAssetPrefix}manifest.json`;
export const bundledSkillPackRootPath = join("packages", "bundled-skills");
export const bundledSkillPackSkillsDirectory = "skills";
// 与 bootstrap 的 BUNDLED_SKILL_REQUIRED_PATHS 逐字同源（那边是 TS 常量，构建脚本无法
// 跨包引用而不引入构建顺序耦合，故双写 + 由 packages/services/test 的闭包测试钉住一致性）：
// 缺任一项即中止 SEA 构建，不把一个引用文件残缺的技能包发进正式二进制。
export const bundledSkillPackRequiredPaths = [
  "skills/dynamic-workflows/SKILL.md",
  "skills/dynamic-workflows/patterns.md",
  "skills/dynamic-workflows/examples.md",
];

export const collectSeaBundledSkillAssets = async ({ root, stagingDirectory }) => {
  const packRoot = resolve(root, bundledSkillPackRootPath);
  assertBundledSkillPack(packRoot);

  await rm(stagingDirectory, { force: true, recursive: true });

  const files = [];
  const assets = {};
  for await (const sourcePath of walkFiles(join(packRoot, bundledSkillPackSkillsDirectory))) {
    const relativePath = relative(packRoot, sourcePath);
    if (!shouldIncludeFile(relativePath)) continue;
    const bytes = await readFile(sourcePath);
    const sourceStats = await stat(sourcePath);
    const posixPath = toPosixPath(relativePath);
    assets[`${seaBundledSkillAssetPrefix}${posixPath}`] = sourcePath;
    files.push({
      mode: modeForFile(sourceStats.mode),
      path: posixPath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));

  const manifest = {
    hash: createHash("sha256")
      .update(JSON.stringify(files.map(({ path, sha256, mode }) => [path, sha256, mode])))
      .digest("hex"),
    files,
    version: 1,
  };
  const manifestPath = resolve(stagingDirectory, "bundled-skills-manifest.json");
  await mkdir(stagingDirectory, { recursive: true });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  assets[seaBundledSkillManifestAssetKey] = manifestPath;

  return { assets, manifest };
};

function assertBundledSkillPack(packRoot) {
  if (!existsSync(join(packRoot, bundledSkillPackSkillsDirectory))) {
    throw new Error(`Missing bundled skill pack at ${packRoot}`);
  }
  for (const relativePath of bundledSkillPackRequiredPaths) {
    const assetPath = join(packRoot, ...relativePath.split("/"));
    if (!existsSync(assetPath)) {
      throw new Error(`Missing bundled skill pack required asset at ${assetPath}`);
    }
  }
}

async function* walkFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".turbo") continue;
    const fullPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(fullPath);
      continue;
    }
    if (entry.isFile()) yield fullPath;
  }
}

const shouldIncludeFile = (relativePath) => !relativePath.split(sep).includes(".DS_Store");

const toPosixPath = (value) => value.split(sep).join("/");

const modeForFile = (sourceMode) => ((sourceMode & 0o111) !== 0 ? 0o755 : 0o644);
