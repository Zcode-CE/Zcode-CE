import { chmod, cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import {
  collectSeaTuiAssets,
  seaTuiAssetPrefix,
} from "../../apps/zcode-cli/packages/cli/scripts/sea-tui-assets.mjs";
import { supportedTargets } from "../../apps/zcode-cli/packages/cli/scripts/sea-targets.mjs";
const root = resolve(import.meta.dirname, "../..");
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

const runtimePackageNames = [
  "@hono/node-server",
  "@hono/node-ws",
  "ssh2",
  "node-pty",
  "undici",
  "axios",
  "form-data",
  "combined-stream",
  "follow-redirects",
  "proxy-from-env",
  "ws",
  "hono",
  "yaml",
  "yazl",
  // HTTP bundle 将 yauzl 外置；发行包必须携带它，否则脱离仓库就无法启动后端。
  "yauzl",
  "node-forge",
];

export async function stageTuiRuntime(packageRoot) {
  const stagingDirectory = resolve(packageRoot, "../tui-staging");
  const copied = new Map();
  try {
    for (const target of supportedTargets) {
      const { assets, manifest } = await collectSeaTuiAssets({
        root: resolve(root, "apps/zcode-cli"),
        stagingDirectory,
        target,
      });
      for (const file of manifest.files) {
        const previous = copied.get(file.path);
        if (previous) {
          if (previous !== file.sha256)
            throw new Error(`Conflicting TUI asset: ${file.path} (${target})`);
          continue;
        }
        const destination = resolve(packageRoot, "agent", file.path);
        await mkdir(dirname(destination), { recursive: true });
        await cp(assets[`${seaTuiAssetPrefix}${file.path}`], destination);
        await chmod(destination, file.mode);
        copied.set(file.path, file.sha256);
      }
    }
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}
const lydellNodePtyPackages = [
  "@lydell/node-pty-darwin-arm64",
  "@lydell/node-pty-darwin-x64",
  "@lydell/node-pty-linux-arm64",
  "@lydell/node-pty-linux-x64",
];

function shouldCopyPackagePath(packageDirectory, source) {
  const rel = relative(packageDirectory, source);
  if (!rel) {
    return true;
  }
  const parts = rel.split(sep);
  return !parts.includes("node_modules") && !parts.includes(".git");
}

async function resolvePackageJsonPath(requireFrom, packageName) {
  try {
    return requireFrom.resolve(`${packageName}/package.json`);
  } catch (error) {
    if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") {
      throw error;
    }
    let current = dirname(requireFrom.resolve(packageName));
    for (;;) {
      const candidate = resolve(current, "package.json");
      if (await pathExists(candidate)) {
        try {
          const packageJson = await readJson(candidate);
          if (packageJson.name === packageName) {
            return candidate;
          }
        } catch {
          // Keep walking; malformed nested metadata should not pick the package root.
        }
      }
      const parent = dirname(current);
      if (parent === current) {
        throw error;
      }
      current = parent;
    }
  }
}

async function copyRuntimePackageTree({ packageName, packageRoot, requireFrom, seen }) {
  if (seen.has(packageName)) {
    return;
  }
  seen.add(packageName);

  let packageJsonPath;
  try {
    packageJsonPath = await resolvePackageJsonPath(requireFrom, packageName);
  } catch (error) {
    throw new Error(`Unable to resolve runtime package ${packageName}`, {
      cause: error,
    });
  }

  const packageDirectory = dirname(packageJsonPath);
  const destination = resolve(packageRoot, "node_modules", ...packageName.split("/"));
  await mkdir(dirname(destination), {
    recursive: true,
  });
  await cp(packageDirectory, destination, {
    dereference: true,
    force: true,
    recursive: true,
    filter: (source) => shouldCopyPackagePath(packageDirectory, source),
  });

  const packageJson = await readJson(packageJsonPath);
  const requireFromPackage = createRequire(packageJsonPath);
  const dependencies = Object.assign(
    {},
    packageJson.dependencies,
    packageJson.optionalDependencies,
  );
  for (const dependencyName of Object.keys(dependencies)) {
    try {
      await copyRuntimePackageTree({
        packageName: dependencyName,
        packageRoot,
        requireFrom: requireFromPackage,
        seen,
      });
    } catch (error) {
      if (!Object.hasOwn(packageJson.optionalDependencies ?? {}, dependencyName)) {
        throw error;
      }
      console.warn(`[zcode] optional package ${dependencyName} is unavailable; skipping`);
    }
  }
}

export async function copyRuntimeNodeModules(packageRoot) {
  const requireFromServer = createRequire(resolve(root, "packages", "server", "package.json"));
  const seen = new Set();
  for (const packageName of runtimePackageNames) {
    await copyRuntimePackageTree({
      packageName,
      packageRoot,
      requireFrom: requireFromServer,
      seen,
    });
  }
  // CLI 的浏览器运行时同样是外部依赖，不能依赖开发仓库的 hoisted node_modules。
  await copyRuntimePackageTree({
    packageName: "playwright-core",
    packageRoot: resolve(packageRoot, "agent"),
    requireFrom: createRequire(resolve(root, "apps/zcode-cli/packages/cli/package.json")),
    seen: new Set(),
  });
}

// 内置技能包（bundled-skills）：不是插件（无 .zcode-plugin/plugin.json），但运行时
// （bootstrap/src/app/bundled-skills.ts 的 resolveBundledSkillRoots）会沿官方插件同款候选目录，
// 在 agent 入口旁找 packages/bundled-skills 并原地读取。
//
// 为什么落点是 agent/packages/bundled-skills：分发包的 agent 入口是 agent/zcode.cjs，
// 而候选基目录的第一顺位是 dirname(process.argv[1])，也就是 agent/。
//
// 为什么必须 stage：/workflow 是内置命令、无条件展开（bootstrap 的 slash-commands.ts 与
// builtin-prompt-command.ts），它的提示词要求模型先读 dynamic-workflows 技能；技能文件不在包里时
// 模型读不到，而技能门又会拒绝调用 ⇒ 用户侧表现为「门拒 + 读不到」的死循环，是真功能倒退。
//
// 范式与另外两条链一致（桌面 packages/desktop/scripts/prepare-agent-node-bundle.mjs 的
// stageBundledSkills、远端 scripts/prepare-prebuilds.mjs 的 stageRemoteBundledSkills）：
// 顶层白名单拷贝 + 必需资产 fail-closed 校验。
export const BUNDLED_SKILL_PACK_TOP_LEVEL_PATHS = ["README.md", "skills"];
export const BUNDLED_SKILL_PACK_REQUIRED_PATHS = [
  "skills/dynamic-workflows/SKILL.md",
  "skills/dynamic-workflows/patterns.md",
  "skills/dynamic-workflows/examples.md",
];

/**
 * 权威清单所在的源文件与声明前缀。
 *
 * 运行期闸门是 bootstrap 的 BUNDLED_SKILL_REQUIRED_PATHS（bundled-skills.ts）：它决定
 * 「资产齐不齐、要不要整包拒收」。上面那份是本模块拷贝的一份，而拷贝就会漂移 —— 本项目已多次
 * 因平行清单各自手写而漏 stage（见 prepare-agent-node-bundle.mjs 里那份常量的注释）。
 * 所以这里在构建期对账一次：不一致就中止构建，而不是等用户发现技能没了。
 */
const BUNDLED_SKILL_AUTHORITATIVE_SOURCE =
  "apps/zcode-cli/packages/bootstrap/src/app/bundled-skills.ts";
const BUNDLED_SKILL_AUTHORITATIVE_DECLARATION = "export const BUNDLED_SKILL_REQUIRED_PATHS = [";

/**
 * 把内置技能包 stage 进分发包的 agent/packages/bundled-skills。
 *
 * 缺任一必需资产即抛错（fail-closed）：分发包不是「少一个 reference 文件」而是「技能整包不可用」，
 * 让问题在构建期暴露，比等用户点 /workflow 时才发现便宜得多。
 */
export async function stageBundledSkillPack(packageRoot) {
  await assertBundledSkillRequiredPathsInSync();
  const sourceRoot = resolve(root, "apps/zcode-cli/packages/bundled-skills");
  const targetRoot = resolve(packageRoot, "agent", "packages", "bundled-skills");
  await mkdir(targetRoot, { recursive: true });
  for (const entryName of BUNDLED_SKILL_PACK_TOP_LEVEL_PATHS) {
    const sourcePath = resolve(sourceRoot, entryName);
    // README.md 是可选的（运行期只校验 skills/ 下的必需资产），缺席时跳过而不是报错。
    if (!(await pathExists(sourcePath))) continue;
    await cp(sourcePath, resolve(targetRoot, entryName), { recursive: true });
  }
  for (const relativePath of BUNDLED_SKILL_PACK_REQUIRED_PATHS) {
    const stagedAssetPath = resolve(targetRoot, ...relativePath.split("/"));
    if (!(await pathExists(stagedAssetPath))) {
      throw new Error(`Missing staged bundled skill asset: ${stagedAssetPath}`);
    }
  }
  console.log("[zcode] staged bundled skill pack (agent/packages/bundled-skills)");
}

/**
 * 把本模块的必需资产清单与 bootstrap 的权威清单对账。
 *
 * 用文本解析而不是 import：bootstrap 是 TypeScript 源码，构建脚本在 tsx 之外运行；
 * 而声明形态变化时这里会显式报错（fail-closed），不会静默退化成「校验一个空清单」。
 */
async function assertBundledSkillRequiredPathsInSync() {
  const sourcePath = resolve(root, BUNDLED_SKILL_AUTHORITATIVE_SOURCE);
  const source = await readFile(sourcePath, "utf8");
  const declarationIndex = source.indexOf(BUNDLED_SKILL_AUTHORITATIVE_DECLARATION);
  if (declarationIndex < 0) {
    throw new Error(
      `Unable to locate ${BUNDLED_SKILL_AUTHORITATIVE_DECLARATION} in ${sourcePath}; ` +
        "内置技能包的权威清单改名/改形后必须同步更新本对账逻辑（它防的是平行清单漂移）",
    );
  }
  const bodyStart = declarationIndex + BUNDLED_SKILL_AUTHORITATIVE_DECLARATION.length;
  const bodyEnd = source.indexOf("] as const", bodyStart);
  if (bodyEnd < 0) {
    throw new Error(`Unterminated BUNDLED_SKILL_REQUIRED_PATHS declaration in ${sourcePath}`);
  }
  const authoritative = [...source.slice(bodyStart, bodyEnd).matchAll(/"([^"]+)"/g)].map(
    (match) => match[1],
  );
  if (authoritative.length === 0) {
    throw new Error(`Parsed no required paths from ${sourcePath}`);
  }
  const declared = [...BUNDLED_SKILL_PACK_REQUIRED_PATHS];
  const inSync =
    authoritative.length === declared.length &&
    authoritative.every((relativePath) => declared.includes(relativePath));
  if (!inSync) {
    throw new Error(
      `Bundled skill required paths drifted from ${BUNDLED_SKILL_AUTHORITATIVE_SOURCE}:\n` +
        `  authoritative: ${authoritative.join(", ")}\n` +
        `  this module:  ${declared.join(", ")}`,
    );
  }
}

export async function patchNodePtyPrebuilds(packageRoot) {
  const requireFromServer = createRequire(resolve(root, "packages", "server", "package.json"));
  const nodePtyPrebuildRoot = resolve(packageRoot, "node_modules", "node-pty", "prebuilds");

  for (const packageName of lydellNodePtyPackages) {
    let packageJsonPath;
    try {
      packageJsonPath = await resolvePackageJsonPath(requireFromServer, packageName);
    } catch {
      console.warn(`[zcode] ${packageName} is unavailable; skipping node-pty prebuild patch`);
      continue;
    }
    const sourcePrebuildRoot = resolve(dirname(packageJsonPath), "prebuilds");
    const sourceStat = await stat(sourcePrebuildRoot).catch(() => null);
    if (!sourceStat?.isDirectory()) {
      continue;
    }
    await cp(sourcePrebuildRoot, nodePtyPrebuildRoot, {
      dereference: true,
      force: true,
      recursive: true,
    });
  }

  for (const helper of [
    resolve(nodePtyPrebuildRoot, "darwin-arm64", "spawn-helper"),
    resolve(nodePtyPrebuildRoot, "darwin-x64", "spawn-helper"),
  ]) {
    if (await pathExists(helper)) {
      await chmod(helper, 0o755);
    }
  }
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
