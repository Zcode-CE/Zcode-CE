import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
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
 * 与官方实现对齐的四处（官方 `resolveBundledSkillRoots`）：
 *   1. rootCandidates 与官方插件同一套 candidate walk（`packages/bundled-skills` 起四项）；
 *   2. 解析结果只有一个 root：`{path: <packRoot>/skills, priority: 1_000_000, scope: "system", source: "bundled"}`；
 *   3. 必需资产缺一即**整包拒收**并 warn，而不是发一个缺 reference 文件的半残技能；
 *   4. 优先级 1e6 压过任何同名用户/插件技能（官方同值）。
 *
 * 未实现（有意，见 .reverse/25-v3143/BUNDLED-SKILLS.md）：SEA 单文件发行态的资产内嵌与解包
 * （官方 `scripts/sea-bundled-skill-assets.mjs` + `zcode-bundled-skills/` 前缀 +
 * `~/.zcode/cli/bundled-skills/<content-hash>/`）。CE 的桌面链路不是 SEA，等 SEA 清单那条线补齐时再一并做。
 */

const BUNDLED_SKILLS_DIRECTORY_NAME = "bundled-skills";
const BUNDLED_SKILLS_SKILLS_DIRECTORY_NAME = "skills";

/**
 * 内置技能包的必需资产（相对包根）。
 *
 * 每个内置技能的正文与它的 reference 文件是同一发布单元：少了 `patterns.md` 或
 * `examples.md`，SKILL.md 里指向它们的引用就会悬空，模型读到一个说不清的技能。
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

export interface ResolveBundledSkillRootsOptions {
  /** 候选基目录；缺席时用入口目录 / `__dirname` / cwd（与官方插件同一枚举器）。 */
  baseDirs?: readonly string[];
  logger?: Logger;
}

/**
 * 解析内置技能包的 skill root。
 *
 * 找不到包或缺必需资产时返回 `[]` 并 warn，**不抛错**：内置技能缺失不应该让 CLI 起不来，
 * 但必须留下可诊断的日志（官方同口径：`Bundled skill pack unavailable` + requiredPaths）。
 */
export function resolveBundledSkillRoots(
  options: ResolveBundledSkillRootsOptions = {},
): SkillRoot[] {
  const packRoot = resolveBundledSkillPackRoot(options.baseDirs);
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
export function findMissingBundledSkillPackPaths(packRoot: string): string[] {
  return BUNDLED_SKILL_REQUIRED_PATHS.filter(
    (relativePath) => !existsSync(resolve(packRoot, ...relativePath.split("/"))),
  );
}

function resolveBundledSkillPackRoot(baseDirs?: readonly string[]): string | undefined {
  for (const baseDir of baseDirs ?? listEntrypointCandidateBaseDirs()) {
    for (const relativePath of BUNDLED_SKILLS_ROOT_CANDIDATES) {
      const candidate = resolve(baseDir, relativePath);
      // 先看 skills/ 是否存在，再逐项校验必需资产：只做后者会把「目录不存在」也算成缺资产，
      // 日志上看不出到底是没装还是装坏了。
      if (
        existsSync(join(candidate, BUNDLED_SKILLS_SKILLS_DIRECTORY_NAME)) &&
        findMissingBundledSkillPackPaths(candidate).length === 0
      ) {
        return candidate;
      }
    }
  }
  return undefined;
}
