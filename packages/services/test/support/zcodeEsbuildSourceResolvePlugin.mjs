// esbuild 层的 @zcode/* 源码解析插件 —— zcodeSourceResolver.mjs 的孪生件。
//
// ## 为什么需要第二份（同一根因的两个层）
//
// CI 的 Test 步骤不构建 apps/zcode-cli 的工作区包（根因与推导见
// zcodeSourceResolver.mjs 的注释）：typecheck 只产出根 packages/*/dist，
// apps/zcode-cli/packages/*/dist 一个都没有。tsx 层由解析钩子解决；
// 但 esbuild 的 onResolve 不经过 node:module 的钩子 —— 任何在测试里实跑
// esbuild 打包、且导入 @zcode/* 的链路（例如 SEA 插件闭包测试构建
// browser-client.mjs）在干净 CI 上仍然解析失败。
//
// ## 规则与 zcodeSourceResolver 逐条一致
//
//   · 包目录按 package.json 的 name 字段匹配（不靠目录名）；
//   · exports 目标 ./dist/x.js → src/x.ts（含 .mts 与目录 index 候选）；
//   · 已经是 ./src/*.ts 的原样放行；
//   · 解析不出时不静默兜底：返回 undefined 交回 esbuild 报它原本的错误。
//
// 用法：作为 esbuild 插件传入（真实构建流程不传，走构建产物 dist，
// 顺带校验 exports 映射本身）。
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 本文件位于 <repoRoot>/packages/services/test/support/ ⇒ 上溯 4 级即仓库根。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

const PACKAGE_PARENT_DIRS = ["packages", join("apps", "zcode-cli", "packages")];

let packageDirByName = null;

function buildPackageDirMap() {
  const map = new Map();
  for (const parentDir of PACKAGE_PARENT_DIRS) {
    const absParent = join(REPO_ROOT, parentDir);
    if (!existsSync(absParent)) continue;
    for (const entry of readdirSync(absParent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(absParent, entry.name);
      try {
        const name = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name;
        if (typeof name === "string" && name.length > 0 && !map.has(name)) {
          map.set(name, dir);
        }
      } catch {
        // 没有/读不了 package.json 的目录不是包，跳过。
      }
    }
  }
  return map;
}

function getPackageDir(name) {
  if (packageDirByName === null) packageDirByName = buildPackageDirMap();
  return packageDirByName.get(name) ?? null;
}

function collectExportTargets(value) {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  const targets = [];
  for (const candidate of [value.import, value.node, value.default, value.require, value.types]) {
    targets.push(...collectExportTargets(candidate));
  }
  return targets;
}

function collectSourceCandidates(target) {
  if (typeof target !== "string") return [];
  if (target.startsWith("./src/")) return [target];
  const distMatch = /^\.\/dist\/(.+?)\.(?:js|mjs|cjs)$/u.exec(target);
  if (!distMatch) return [];
  const stem = distMatch[1];
  return [`src/${stem}.ts`, `src/${stem}.mts`, `src/${stem}/index.ts`];
}

function resolveZcodeSpecifierToSource(specifier) {
  const withoutScope = specifier.slice("@zcode/".length);
  const slashIndex = withoutScope.indexOf("/");
  const packageName = slashIndex === -1 ? withoutScope : withoutScope.slice(0, slashIndex);
  const subpath = slashIndex === -1 ? "" : withoutScope.slice(slashIndex + 1);
  if (packageName.length === 0) return null;

  const packageDir = getPackageDir(`@zcode/${packageName}`);
  if (!packageDir) return null;

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  } catch {
    return null;
  }

  let targets = [];
  const exportsField = manifest.exports;
  if (exportsField && typeof exportsField === "object" && !Array.isArray(exportsField)) {
    const exportKey = subpath === "" ? "." : `./${subpath}`;
    targets = collectExportTargets(exportsField[exportKey]);
  }
  if (targets.length === 0) {
    targets = [manifest.main, manifest.types].filter((item) => typeof item === "string");
    if (subpath === "") targets.push("./src/index.ts");
  }

  for (const target of targets) {
    for (const relativeSource of collectSourceCandidates(target)) {
      const absoluteSource = join(packageDir, relativeSource);
      if (existsSync(absoluteSource)) return absoluteSource;
    }
  }
  return null;
}

export function createZcodeSourceEsbuildPlugin() {
  return {
    name: "zcode-source-resolve",
    setup(builder) {
      // esbuild 的 filter 是 Go 正则（RE2），不支持 JS 的 u 标志。
      builder.onResolve({ filter: /^@zcode\// }, (args) => {
        const sourcePath = resolveZcodeSpecifierToSource(args.path);
        // 解析不出时不静默兜底：返回 undefined 交回 esbuild 报它原本的错误。
        if (!sourcePath) return undefined;
        return { path: sourcePath };
      });
    },
  };
}
