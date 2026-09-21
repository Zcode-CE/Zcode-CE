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
/** 含测试的包目录（相对仓库根）。新增测试包时在此登记。 */
const TEST_PACKAGES = ["packages/services", "packages/ui"];

function collectTests(packageDir) {
  const testDir = join(repoRoot, packageDir, "test");
  if (!existsSync(testDir)) return [];
  return readdirSync(testDir)
    .filter((name) => name.endsWith(".test.ts"))
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
