// 测试用的模块解析钩子：把 `@zcode/*` 从「构建产物 dist/」重定向到「源码 src/」。
//
// ## 为什么需要它（task-78 的根因）
//
// CI 的 Test 步骤（.github/workflows/ci.yml）顺序是
//   pnpm install --frozen-lockfile → typecheck → lint → fmt:check → test
// 其中 `pnpm typecheck` 展开成 `tsc -b packages/...` —— **工程列表里没有 apps/zcode-cli**
// （见根 package.json 的 typecheck script）。实测：在无产物的树上跑完 typecheck，
// 只新增 9 个根 `packages/*/dist`，`apps/zcode-cli/packages/*/dist` **一个都没有**。
//
// 而 devChainAgentPayloads 测试要在**真实 seed** 下验证载荷落点，必须 import bootstrap 的
// `src/app/bundled-plugins.ts`（有意取源码，才能测到当前逻辑）。该文件的传递依赖
// `@zcode/adapters` 的 package.json `exports` 指向 `./dist/index.js` ⇒
// fresh clone（无 dist）下必然 `ERR_MODULE_NOT_FOUND`。
//
// **本地为什么绿**：本机跑过构建，`apps/zcode-cli/packages/adapters/dist` 已在磁盘上。
// 这正是 AGENTS.md「验证必须打到最终消费点」的镜像问题 —— 本地验证依赖了本地状态。
//
// ## 为什么用解析钩子，而不是 tsconfig paths / mock / 让测试自己构建
//
// - **tsconfig paths 表达不了子路径**：`@zcode/*/*` 会被 get-tsconfig 直接拒绝
//   （"Pattern '@zcode/*/*' can have at most one '*' character"），而 bootstrap 的闭包里
//   确实有 `@zcode/adapters/*`、`@zcode/shared/*` 这类子路径导入。
// - **不能 mock `@zcode/adapters`**：`writeBundledOfficialMarketplacePartitionSync`
//   在 seed 路径里被真实调用（bundled-plugins.ts:423），mock 掉就等于把「真实 seed」
//   这条前提抽掉 —— 与本测试的立身之本冲突。
// - **不能让测试去构建**：那会让每个测试都背上构建成本，且仍然依赖磁盘状态。
// - **不能改 CI 加构建步骤**：所有测试都会变慢，且掩盖「测试依赖外部状态」这个真问题。
//
// ⇒ 唯一既忠实又无外部前提的做法：**让 `@zcode/*` 直接解析到源码**。
// 源码比 dist 更贴近被测对象（dist 可能是陈旧的），且不需要任何构建步骤。
//
// ## 解析规则（不手写第二份清单）
//
// 每个包的 `exports` 就是它的契约，所以这里**从被解析包的 package.json 读取**，
// 把目标路径 `./dist/<x>.js` 反推成 `src/<x>.ts`：
//   · 包目录按 `name` 字段匹配，**不靠目录名** —— `@zcode/server-cli` 的目录叫
//     `zcode-server-cli`，按目录名猜会漏；
//   · 已经是 `./src/*.ts` 的（如 `@zcode/shared`、`@zcode/rpc`）原样放行；
//   · 找不到源码时**不静默兜底**，交回 nextResolve 让 Node 报它原本的错误。
//
// 用法：作为 `--import` 的目标装在需要它的进程上，例如
//   node --import tsx --import ./support/zcodeSourceResolver.mjs probe.mts

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 本文件位于 <repoRoot>/packages/services/test/support/ ⇒ 上溯 4 级即仓库根。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** workspace 内所有 @zcode 包的父目录（相对仓库根）。 */
const PACKAGE_PARENT_DIRS = ["packages", join("apps", "zcode-cli", "packages")];

/** name → 包目录。惰性构建一次并缓存：解析钩子在热路径上，不能每次读盘。 */
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
        // 同名取先命中的一个（workspace 内不应有重名，真重名时交给 Node 报错）。
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
  packageDirByName ??= buildPackageDirMap();
  return packageDirByName.get(name) ?? null;
}

/** 收集一个 exports 条目的候选目标路径（按 Node 的解析优先级展开条件对象）。 */
function collectExportTargets(value) {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  const targets = [];
  // 顺序即优先级：import 是本仓库（ESM-only）的主路径。
  for (const candidate of [value.import, value.node, value.default, value.require, value.types]) {
    targets.push(...collectExportTargets(candidate));
  }
  return targets;
}

/**
 * 把一个 exports 目标路径映射成候选源码路径。
 *
 * `./dist/auth/index.js` → `src/auth/index.ts`；
 * `./src/node.ts`（包本身就直指源码）→ 原样保留。
 */
function collectSourceCandidates(target) {
  if (typeof target !== "string") return [];
  if (target.startsWith("./src/")) return [target];
  const distMatch = /^\.\/dist\/(.+?)\.(?:js|mjs|cjs)$/u.exec(target);
  if (!distMatch) return [];
  const stem = distMatch[1];
  return [`src/${stem}.ts`, `src/${stem}.mts`, `src/${stem}/index.ts`];
}

/**
 * 尝试把 `@zcode/<pkg>[/<sub>]` 解析到源码文件。
 *
 * @returns 源码文件的 file:// URL；无法解析时返回 null（调用方须交回 nextResolve）。
 */
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
    // 没有 exports（或该子路径未导出）：退回 main/types；裸包名再退回约定的 src/index.ts。
    targets = [manifest.main, manifest.types].filter((item) => typeof item === "string");
    if (subpath === "") targets.push("./src/index.ts");
  }

  for (const target of targets) {
    for (const relativeSource of collectSourceCandidates(target)) {
      const absoluteSource = join(packageDir, relativeSource);
      if (existsSync(absoluteSource)) return pathToFileURL(absoluteSource).href;
    }
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@zcode/")) {
      const sourceUrl = resolveZcodeSpecifierToSource(specifier);
      if (sourceUrl) return { url: sourceUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
