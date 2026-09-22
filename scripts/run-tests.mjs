#!/usr/bin/env node
/**
 * 仓库测试入口。
 *
 * 背景：CE 被裁剪后没有根 test script，但 packages 下已有测试文件，
 * 需手工拼命令且容易漏跑。本脚本统一入口。
 *
 * 关键约束（实测得出，勿改）：
 * - runner 是 node:test（Node 内置），配 --import tsx 解析 TS。
 * - **必须从各包目录内执行**：ui 包用 tsconfig paths 的 `@/*` 别名，
 *   node 直跑不认，从仓库根跑会 ERR_MODULE_NOT_FOUND。
 * - 不引入任何新依赖（tsx 已是根 devDependency）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/**
 * 含测试的包目录（相对仓库根）。新增测试包时在此登记。
 *
 * 为什么登记制而不是自动发现：各包运行方式不同（有的要 cwd 在包内，有的要 --import tsx），
 * 自动发现容易在 CI 上跑出与环境相关的假失败。
 */
const TEST_PACKAGES = [
  "packages/services",
  "packages/ui",
  // office 三插件的校验器测试：**必须在这里登记**，否则 4 条有牙齿的断言
  // （峰值内存受预算约束、命名空间密集 O(N²)、三份逐字节一致、staging 护栏）不进 CI。
  // 审计实测：未登记前 `pnpm test` 只跑 20 个文件，完全覆盖不到这些断言。
  // 注意它们用 .mjs（校验器本身是 Node 脚本），见下面的后缀列表。
  "apps/zcode-cli/packages/documents-plugin",
];

/** 允许的测试文件后缀：packages 下用 TS（走 tsx），apps 下的脚本测试用 .mjs。 */
const TEST_FILE_SUFFIXES = [".test.ts", ".test.mjs"];

function collectTests(packageDir) {
  const testDir = join(repoRoot, packageDir, "test");
  if (!existsSync(testDir)) return [];
  return readdirSync(testDir)
    .filter((name) => TEST_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix)))
    .map((name) => join("test", name));
}

let totalTests = 0;
let failedPackages = 0;

for (const packageDir of TEST_PACKAGES) {
  const files = collectTests(packageDir);
  if (files.length === 0) {
    console.log(`[test] ${packageDir}: 无测试文件，跳过`);
    continue;
  }
  console.log(`[test] ${packageDir}: ${files.length} 个测试文件`);
  // cwd 必须是包目录：ui 的 @/* 别名依赖 tsconfig paths，node 直跑不认。
  const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], {
    cwd: join(repoRoot, packageDir),
    stdio: "inherit",
  });
  if (result.status !== 0) {
    failedPackages += 1;
  }
  totalTests += files.length;
}

console.log(`[test] 共 ${totalTests} 个测试文件，${failedPackages} 个包失败`);
process.exit(failedPackages === 0 ? 0 : 1);
