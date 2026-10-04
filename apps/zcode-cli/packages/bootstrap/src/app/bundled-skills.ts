import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Logger, SkillRoot } from "@zcode/contracts";
import { listEntrypointCandidateBaseDirs } from "./entrypoint-candidates.js";

/**
 * 内置技能包（bundled skills）解析。
 *
 * 官方 3.14.3 引入 `glm/packages/bundled-skills`：把「产品功能依赖的技能」从插件体系里拿出来，
 * 由运行时每次启动直接发现，不进插件商店、无启停开关、不可卸载、也不出现在设置页技能列表与
 * composer 的 `$` 选择器里（理由见包内 README：工具面由 runtime 注册，教模型用工具的正文就必须
 * 同样不可移除）。第一个住户是 `dynamic-workflows` —— 它此前挂在 zcode-guide 插件下，
 * 3.14.3 起从该插件迁出。
 *
 * 两种运行形态解析到同一个 skills 目录：
 * - 开发态 / Electron 桌面 / 远端预构建：沿官方插件同款候选目录在入口旁找到
 *   `packages/bundled-skills`，原地读取，不拷贝。
 * - SEA 二进制：资产内嵌在 `zcode-bundled-skills/` 前缀下（采集见
 *   `apps/zcode-cli/packages/cli/scripts/sea-bundled-skill-assets.mjs`），首启按内容 hash
 *   解压到 `<cli storage>/bundled-skills/<hash>/`；目录名即内容身份，重复启动幂等，
 *   并发只会有一个赢家（临时目录 + rename 原子提交）。
 *
 * 与官方实现对齐的四处（官方 `resolveBundledSkillRoots`）：
 *   1. rootCandidates 与官方插件同一套 candidate walk（`packages/bundled-skills` 起四项）；
 *   2. 解析结果只有一个 root：`{path: <packRoot>/skills, priority: 1_000_000, scope: "system", source: "bundled"}`；
 *   3. 必需资产缺一即**整包拒收**并 warn，而不是发一个缺 reference 文件的半残技能；
 *   4. 优先级 1e6 压过任何同名用户/插件技能（官方同值）。
 *
 * 与官方的一处有意差异：SEA 解包失败时官方回退到任一已完整的旧包，我们保留同款降级
 * （升级中途掉盘仍有技能可用），并把降级原因写进 warn —— 静默降级是唯一不被允许的形态。
 */

const BUNDLED_SKILLS_DIRECTORY_NAME = "bundled-skills";
const BUNDLED_SKILLS_SKILLS_DIRECTORY_NAME = "skills";

/**
 * 内置技能包的必需资产（相对包根）。
 *
 * 每个内置技能的正文与它的 reference 文件是同一发布单元：少了 `patterns.md` 或
 * `examples.md`，SKILL.md 里指向它们的引用就会悬空，模型读到一个说不清的技能。
 *
 * 与 `sea-bundled-skill-assets.mjs` 的 `bundledSkillPackRequiredPaths` 逐字同源
 * （构建脚本是 .mjs、无法跨包引用 TS 常量；一致性由 packages/services/test 的闭包测试钉住）。
 */
export const BUNDLED_SKILL_REQUIRED_PATHS = [
  "skills/dynamic-workflows/SKILL.md",
  "skills/dynamic-workflows/patterns.md",
  "skills/dynamic-workflows/examples.md",
] as const;

/** 与官方插件同形的候选相对路径（官方 `rootCandidates` 四项）。 */
const BUNDLED_SKILLS_ROOT_CANDIDATES = [
  `packages/${BUNDLED_SKILLS_DIRECTORY_NAME}`,
  `../${BUNDLED_SKILLS_DIRECTORY_NAME}`,
  `../../${BUNDLED_SKILLS_DIRECTORY_NAME}`,
  `../../../${BUNDLED_SKILLS_DIRECTORY_NAME}`,
] as const;

/** 内置技能必须压过同名用户/插件技能（与官方 1e6 同值）。 */
export const BUNDLED_SKILLS_ROOT_PRIORITY = 1_000_000;

/** SEA 内嵌资产键前缀与清单键（与采集脚本 `sea-bundled-skill-assets.mjs` 同源）。 */
export const SEA_BUNDLED_SKILL_ASSET_PREFIX = "zcode-bundled-skills/";
const SEA_BUNDLED_SKILL_MANIFEST_ASSET_KEY = `${SEA_BUNDLED_SKILL_ASSET_PREFIX}manifest.json`;
const SEED_MARKER_FILE = ".zcode-bundled-skills-seed.json";

interface SeaBundledSkillManifest {
  files: Array<{ mode?: number; path: string; sha256: string }>;
  hash: string;
  version: 1;
}

type SeaModule = Pick<typeof import("node:sea"), "getAsset" | "getRawAsset" | "isSea">;

export interface ResolveBundledSkillRootsOptions {
  /** 候选基目录；缺席时用入口目录 / `__dirname` / cwd（与官方插件同一枚举器）。 */
  baseDirs?: readonly string[];
  /** CLI 存储根（`getCliStorageRoot(storage.dir)`）；仅 SEA 解包需要。 */
  cliStorageRoot?: string;
  logger?: Logger;
  /**
   * SEA 模块注入点（默认 `process.getBuiltinModule("node:sea")`）。
   * 生产态拿不到假 SEA 二进制，测试用它造一个从 staged 资产读字的 sea。
   */
  seaModule?: SeaModule;
}

/**
 * 解析内置技能包的 skill root。
 *
 * SEA 态先尝试按清单解包到 `<cliStorageRoot>/bundled-skills/<hash>/`，非 SEA 或解包失败时
 * 回退到文件系统候选目录。找不到包或缺必需资产时返回 `[]` 并 warn，**不抛错**：
 * 内置技能缺失不应该让 CLI 起不来，但必须留下可诊断的日志（官方同口径：
 * `Bundled skill pack unavailable` + requiredPaths）。
 */
export async function resolveBundledSkillRoots(
  options: ResolveBundledSkillRootsOptions = {},
): Promise<SkillRoot[]> {
  const packRoot =
    (await materializeSeaBundledSkillPack(options)) ??
    (await resolveFilesystemBundledSkillPackRoot(options.baseDirs));
  if (!packRoot) {
    options.logger?.warn("Bundled skill pack unavailable", {
      module: "bootstrap.bundled_skills",
      requiredPaths: [...BUNDLED_SKILL_REQUIRED_PATHS],
    });
    return [];
  }
  return [
    {
      path: join(packRoot, BUNDLED_SKILLS_SKILLS_DIRECTORY_NAME),
      priority: BUNDLED_SKILLS_ROOT_PRIORITY,
      scope: "system",
      source: "bundled",
    },
  ];
}

/** 列出内置技能包里缺失的必需资产；空数组表示这一份资产是完整的。 */
export async function findMissingBundledSkillPackPaths(packRoot: string): Promise<string[]> {
  const present = await Promise.all(
    BUNDLED_SKILL_REQUIRED_PATHS.map((requiredPath) =>
      pathExists(join(packRoot, ...requiredPath.split("/"))),
    ),
  );
  return BUNDLED_SKILL_REQUIRED_PATHS.filter((_, index) => !present[index]);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveFilesystemBundledSkillPackRoot(
  baseDirs?: readonly string[],
): Promise<string | undefined> {
  for (const baseDir of baseDirs ?? listEntrypointCandidateBaseDirs()) {
    for (const relativePath of BUNDLED_SKILLS_ROOT_CANDIDATES) {
      const candidate = resolve(baseDir, relativePath);
      // 先看 skills/ 是否存在，再逐项校验必需资产：只做后者会把「目录不存在」也算成缺资产，
      // 日志上看不出到底是没装还是装坏了。
      if (
        (await pathExists(join(candidate, BUNDLED_SKILLS_SKILLS_DIRECTORY_NAME))) &&
        (await findMissingBundledSkillPackPaths(candidate)).length === 0
      ) {
        return candidate;
      }
    }
  }
  return undefined;
}

/**
 * 把 SEA 内嵌的内置技能包解包到 `<cliStorageRoot>/bundled-skills/<hash>/`。
 *
 * 目录名就是内容 hash：写进唯一临时目录再 rename，rename 失败但目标已完整即并发赢家先到，
 * 直接复用；解包或哈希校验失败时回退到任一已完整的旧包（升级中途掉盘仍有技能可用），
 * 并把降级原因 warn 出来——静默降级是唯一不被允许的形态。
 */
async function materializeSeaBundledSkillPack(
  options: ResolveBundledSkillRootsOptions,
): Promise<string | undefined> {
  const sea = options.seaModule ?? getSeaModule();
  if (!sea?.isSea()) return undefined;

  const manifest = readSeaManifest(sea);
  if (!manifest) return undefined;

  if (!options.cliStorageRoot) {
    // SEA 态却没有存储根：调用方装配顺序出错的信号，必须显式降级而不是往下走到
    // 一个未定义路径。技能包不可用不阻断启动（见 resolveBundledSkillRoots 的 warn 口径）。
    options.logger?.warn("Bundled skill pack unavailable in SEA without cli storage root", {
      module: "bootstrap.bundled_skills",
      requiredPaths: [...BUNDLED_SKILL_REQUIRED_PATHS],
    });
    return undefined;
  }

  const packsRoot = join(options.cliStorageRoot, BUNDLED_SKILLS_DIRECTORY_NAME);
  const targetRoot = join(packsRoot, manifest.hash);
  if (await isSeedComplete(targetRoot, manifest.hash)) return targetRoot;

  const temporaryRoot = `${targetRoot}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await mkdir(temporaryRoot, { recursive: true });
    for (const file of manifest.files) {
      const bytes = Buffer.from(sea.getRawAsset(`${SEA_BUNDLED_SKILL_ASSET_PREFIX}${file.path}`));
      if (hashBytes(bytes) !== file.sha256) {
        throw new Error(`Bundled skill asset hash mismatch: ${file.path}`);
      }
      const outputPath = join(temporaryRoot, ...file.path.split("/"));
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, bytes, { mode: file.mode ?? 0o644 });
    }
    await writeFile(
      join(temporaryRoot, SEED_MARKER_FILE),
      JSON.stringify({ hash: manifest.hash, version: 1 }, null, 2),
    );
    await mkdir(packsRoot, { recursive: true });
    await rename(temporaryRoot, targetRoot);
    return targetRoot;
  } catch (error) {
    await rm(temporaryRoot, { force: true, recursive: true });
    if (await isSeedComplete(targetRoot, manifest.hash)) return targetRoot;
    const fallbackRoot = await findUsableSeededPack(packsRoot);
    options.logger?.warn("Bundled skill pack seed degraded", {
      error: error instanceof Error ? error.message : String(error),
      fallbackRoot,
      module: "bootstrap.bundled_skills",
      targetRoot,
    });
    return fallbackRoot;
  }
}

async function isSeedComplete(targetRoot: string, expectedHash: string): Promise<boolean> {
  try {
    const marker = JSON.parse(await readFile(join(targetRoot, SEED_MARKER_FILE), "utf8")) as {
      hash?: unknown;
    };
    if (marker.hash !== expectedHash) return false;
  } catch {
    return false;
  }
  return (await findMissingBundledSkillPackPaths(targetRoot)).length === 0;
}

async function findUsableSeededPack(packsRoot: string): Promise<string | undefined> {
  let entries;
  try {
    entries = await readdir(packsRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.includes(".tmp-")) continue;
    const packRoot = join(packsRoot, entry.name);
    try {
      const marker = JSON.parse(await readFile(join(packRoot, SEED_MARKER_FILE), "utf8")) as {
        hash?: unknown;
      };
      if (typeof marker.hash === "string" && (await isSeedComplete(packRoot, marker.hash))) {
        return packRoot;
      }
    } catch {
      // 损坏的旧缓存不参与降级，继续查找完整的技能包。
    }
  }
  return undefined;
}

function readSeaManifest(sea: SeaModule): SeaBundledSkillManifest | undefined {
  try {
    const manifest = JSON.parse(
      sea.getAsset(SEA_BUNDLED_SKILL_MANIFEST_ASSET_KEY, "utf8"),
    ) as SeaBundledSkillManifest;
    return manifest.version === 1 &&
      typeof manifest.hash === "string" &&
      Array.isArray(manifest.files)
      ? manifest
      : undefined;
  } catch {
    return undefined;
  }
}

function getSeaModule(): SeaModule | undefined {
  const getBuiltinModule = process.getBuiltinModule as ((id: "node:sea") => SeaModule) | undefined;
  try {
    return getBuiltinModule?.("node:sea");
  } catch {
    return undefined;
  }
}

function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
