import { dirname } from "node:path";

/**
 * 入口附近的候选基目录。官方插件（`packages/<name>-plugin`）与内置技能包
 * （`packages/bundled-skills`）共用这一套查找根 —— 官方 3.14.3 的实现同样是同一个枚举器
 * （其 `resolveBundledSkillRoots` 与官方插件解析走同一批候选基目录）。
 *
 * 为什么必须优先看入口目录：Electron 的 app-server 运行在 `resources/glm/zcode.cjs`，
 * 官方插件与内置技能包都随包 stage 到同级 `packages/*`；只看 `__dirname` 会退化成
 * monorepo-only 的假设，正式包里就找不到资源。
 */
export function listEntrypointCandidateBaseDirs(cwd: string = process.cwd()): string[] {
  return [entrypointDir(), runtimeDir(), cwd].filter(
    (dir): dir is string => typeof dir === "string",
  );
}

function runtimeDir(): string | undefined {
  return typeof __dirname === "string" ? __dirname : undefined;
}

function entrypointDir(): string | undefined {
  return process.argv[1] ? dirname(process.argv[1]) : undefined;
}
