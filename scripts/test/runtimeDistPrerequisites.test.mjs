import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { tuiRuntimeWorkspaceBuildProjects } from "../zcode-distribution/runtime-dist-prerequisites.mjs";

/**
 * TUI 运行时 workspace 包的 dist 前置：构建脚本必须自己覆盖，不能指望调用方先跑 typecheck。
 *
 * 为什么需要这条护栏（tag v3.14.3-ce.3 的 Release 流水线实测）：
 * build-zcode.mjs 的构建段只跑 `pnpm --filter "@zcode/cli..." build`，而 pnpm 会**静默跳过**
 * 依赖闭包里没有 build 脚本的 workspace 包；stageTuiRuntime 却对 TUI 运行时闭包里的每个
 * workspace 包要求 dist/index.js。@zcode/shared 正是这种包（scripts 只有 lint）⇒ 干净检出里
 * `node scripts/build-zcode.mjs --allow-placeholder-base-url` 直接报
 * `Missing @zcode/shared dist files`，且**配了 ZCODE_DIST_BASE_URL 的正常路径同样会红**
 * （headless server package job 从不跑 typecheck）。
 *
 * 这条断言防的是同一类缺陷再次发生：**新增一个无 build 脚本的 workspace 运行时包**时，
 * 它必须被显式补进 tuiRuntimeWorkspaceBuildProjects，而不是等下一次发版才发现。
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// 与 sea-tui-assets.mjs 的 workspacePackageParentDirectories 同源：TUI 闭包会经由
// @zcode/contracts 依赖仓库根的 @zcode/shared，只扫 apps/zcode-cli 子 workspace 会误判为缺失。
const workspaceParentDirectories = ["apps/zcode-cli/packages", "apps/zcode-cli/tools", "packages"];

function toRepoRelativePath(directory) {
  return relative(repoRoot, directory).split(sep).join("/");
}

function readWorkspacePackages() {
  const packages = new Map();
  for (const parent of workspaceParentDirectories) {
    const absoluteParent = resolve(repoRoot, parent);
    if (!existsSync(absoluteParent)) continue;
    for (const entry of readdirSync(absoluteParent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = resolve(absoluteParent, entry.name, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (typeof manifest.name !== "string" || manifest.name.length === 0) continue;
      const directory = resolve(absoluteParent, entry.name);
      packages.set(manifest.name, {
        directory,
        relativePath: toRepoRelativePath(directory),
        manifest,
      });
    }
  }
  return packages;
}

/** TUI 运行时闭包：与 sea-tui-assets.mjs 的 runtimePackageNames 同一口径（只看 dependencies）。 */
function collectTuiRuntimeClosure(packages) {
  const closure = new Set();
  const queue = ["@zcode/tui"];
  while (queue.length > 0) {
    const name = queue.shift();
    if (closure.has(name)) continue;
    closure.add(name);
    const entry = packages.get(name);
    if (!entry) continue;
    for (const dependencyName of Object.keys(entry.manifest.dependencies ?? {})) {
      if (packages.has(dependencyName)) queue.push(dependencyName);
    }
  }
  return closure;
}

/** TUI 运行时闭包里"没有 build 脚本"的 workspace 包（它们的 dist 必须由构建清单显式补）。 */
function collectClosurePackagesWithoutBuildScript(packages) {
  const entries = [];
  for (const name of collectTuiRuntimeClosure(packages)) {
    const entry = packages.get(name);
    if (!entry) continue;
    if (typeof entry.manifest.scripts?.build === "string") continue;
    entries.push({ name, relativePath: entry.relativePath });
  }
  return entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

test("@zcode/shared 在 TUI 运行时闭包里，且它没有 build 脚本（本次缺陷的前提）", () => {
  const packages = readWorkspacePackages();
  assert.ok(
    collectTuiRuntimeClosure(packages).has("@zcode/shared"),
    "TUI 运行时闭包应包含 @zcode/shared",
  );
  assert.equal(
    packages.get("@zcode/shared").manifest.scripts?.build,
    undefined,
    "@zcode/shared 现在有 build 脚本了：请重新核对 tuiRuntimeWorkspaceBuildProjects 是否还必要",
  );
});

test("TUI 运行时闭包里每个没有 build 脚本的 workspace 包都在构建清单里", () => {
  const packages = readWorkspacePackages();
  const declared = new Set(tuiRuntimeWorkspaceBuildProjects);
  const missing = collectClosurePackagesWithoutBuildScript(packages)
    .filter((entry) => !declared.has(entry.relativePath))
    .map((entry) => `${entry.name} (${entry.relativePath})`);
  assert.deepEqual(
    missing,
    [],
    "这些 TUI 运行时包没有 build 脚本、也不在 tuiRuntimeWorkspaceBuildProjects 里：" +
      `${missing.join(", ")}。pnpm --filter "@zcode/cli..." build 会静默跳过它们，` +
      "而 stageTuiRuntime 要求它们的 dist/index.js ⇒ 干净检出里 build-zcode 必然失败。" +
      "请把它们加进 scripts/zcode-distribution/runtime-dist-prerequisites.mjs。",
  );
});

test("清单里的每一条都对应一个真实的、缺 build 脚本的 TUI 运行时 workspace 包", () => {
  const packages = readWorkspacePackages();
  const expected = new Map(
    collectClosurePackagesWithoutBuildScript(packages).map((entry) => [
      entry.relativePath,
      entry.name,
    ]),
  );
  const stale = tuiRuntimeWorkspaceBuildProjects.filter((project) => !expected.has(project));
  assert.deepEqual(
    stale,
    [],
    `构建清单里有过期条目：${stale.join(", ")}（已不在 TUI 运行时闭包里，或它已有 build 脚本）` +
      "。留着它们只会让构建多做无用功，并让清单不再可信。",
  );
});

test("build-zcode 的构建段确实消费了这份清单", () => {
  const source = readFileSync(resolve(repoRoot, "scripts/build-zcode.mjs"), "utf8");
  const body = source.match(/async function buildOutputs\([\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(body.length > 0, "未能从 build-zcode.mjs 中定位 buildOutputs");
  assert.ok(
    body.includes("tuiRuntimeWorkspaceBuildProjects"),
    "buildOutputs 没有消费 tuiRuntimeWorkspaceBuildProjects ⇒ 清单只是声明，构建仍然缺 dist",
  );
});
