import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveBuildAliases } from "../../cli/scripts/build.mjs";

/**
 * 「agent bundle 里 import 的每个 `@zcode/shared/<子路径>` 都在 esbuild 别名表里登记」的结构护栏。
 *
 * 为什么必须有（task-11 的根因）：`resolveBuildAliases` 是**手写白名单**，而 esbuild 的 alias 是
 * **前缀改写** —— 子路径没登记就会被通用 `"@zcode/shared"` 条目改写成
 * `packages/shared/src/index.ts/<subpath>`，报错形如
 * `Cannot read directory ".../shared/src/index.ts": not a directory`。
 *
 * 为什么这件事只能靠测试发现：
 * - NodeNext 的 tsc 按 `package.json` 的 `exports` 解析（源码级），**不经过 esbuild alias**；
 * - `node --import tsx --test` 同样按 exports 解析；
 * - CI 的 verify job 只跑 typecheck/lint/fmt/test/architecture，**不跑 build**（`.github/workflows/ci.yml:23-58`）。
 * 于是「源码级全绿 / 构建级直接红」能一路漂到打包才暴露。本测试把该漂移提前到 `pnpm test`。
 *
 * **判据是「谁能进 bundle」，不是「shared 导出了什么」**：shared 的 exports 里有若干子路径只有
 * desktop/web 侧用（例如 `node-repl-browser-broker`、`account-provider-state`），
 * 它们不在 agent bundle 里，本测试不要求它们登记。
 *
 * 运行：cd apps/zcode-cli/packages/core && node --import tsx --test test/sharedSubpathBuildAliases.test.ts
 */

const here = dirname(fileURLToPath(import.meta.url));
// test/ → core/ → packages/ → zcode-cli/ → repo root
const repoRoot = resolve(here, "../../../../..");

/** 会进 agent bundle 的源码根（不含桌面端专属包）。 */
const AGENT_SOURCE_ROOTS = [
  "apps/zcode-cli/packages/cli/src",
  "apps/zcode-cli/packages/contracts/src",
  "apps/zcode-cli/packages/adapters/src",
  "apps/zcode-cli/packages/core/src",
  "apps/zcode-cli/packages/bootstrap/src",
  "apps/zcode-cli/packages/dynamic-workflow/src",
  "apps/zcode-cli/packages/dynamic-workflow-runtime/src",
  "apps/zcode-cli/packages/shared-types/src",
];

const SHARED_SUBPATH_IMPORT = /["']@zcode\/shared\/([a-zA-Z0-9/_.-]+)["']/g;

function collectSourceFiles(directory: string): string[] {
  const absolute = resolve(repoRoot, directory);
  const files: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (entry.endsWith(".ts") || entry.endsWith(".tsx")) files.push(path);
    }
  };
  walk(absolute);
  return files;
}

function collectImportedSharedSubpaths(): string[] {
  const subpaths = new Set<string>();
  for (const directory of AGENT_SOURCE_ROOTS) {
    for (const file of collectSourceFiles(directory)) {
      const content = readFileSync(file, "utf8");
      for (const match of content.matchAll(SHARED_SUBPATH_IMPORT)) {
        const subpath = match[1];
        // `@zcode/shared/...` 指向目录（如 zcode-protocol-v4/index）时也统一按首段登记；
        // 现有别名表按「包内路径」登记，因此保留完整子路径做精确比对。
        if (subpath) subpaths.add(subpath);
      }
    }
  }
  return [...subpaths].sort();
}

test("agent bundle 用到的每个 shared 子路径都登记了精确别名", () => {
  const aliases = resolveBuildAliases();
  const missing = collectImportedSharedSubpaths().filter(
    (subpath) => aliases[`@zcode/shared/${subpath}`] === undefined,
  );
  assert.deepEqual(
    missing,
    [],
    `未登记的 shared 子路径会让打包报 "Cannot read directory .../shared/src/index.ts": ${missing.join(", ")}`,
  );
});

test("每条 shared 子路径别名都指向真实文件，且不是整个包的总入口", () => {
  const aliases = resolveBuildAliases();
  // 前缀改写失败时的**具体症状**就是把子路径拼到总入口后面，所以「指向总入口」是本测试要挡的错。
  // 注意不能简单地禁掉所有 `index.ts`：`@zcode/shared/zcode-protocol-v4` 本来就该指向
  // `src/zcode-protocol-v4/index.ts`（子目录自己的入口，合法）。
  const aggregateEntry = resolve(repoRoot, "packages/shared/src/index.ts");
  for (const subpath of collectImportedSharedSubpaths()) {
    const target = aliases[`@zcode/shared/${subpath}`];
    assert.ok(target, `missing alias for @zcode/shared/${subpath}`);
    assert.notEqual(
      resolve(target),
      aggregateEntry,
      `alias @zcode/shared/${subpath} must not point at the aggregate packages/shared/src/index.ts`,
    );
    assert.doesNotThrow(
      () => readFileSync(target, "utf8"),
      `alias @zcode/shared/${subpath} points at a missing file: ${target}`,
    );
  }
});

test("通用 @zcode/shared 条目排在所有子路径之后（顺序决定前缀改写结果）", () => {
  const keys = Object.keys(resolveBuildAliases());
  const genericIndex = keys.indexOf("@zcode/shared");
  assert.equal(genericIndex >= 0, true, "generic @zcode/shared alias must exist");
  for (const key of keys.filter((k) => k.startsWith("@zcode/shared/"))) {
    assert.ok(
      keys.indexOf(key) < genericIndex,
      `${key} must be declared before the generic "@zcode/shared" entry`,
    );
  }
});
