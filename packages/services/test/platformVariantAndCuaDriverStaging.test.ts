import assert from "node:assert/strict";
import test from "node:test";
import {
  currentPlatformVariantTags,
  isForeignPlatformVariant,
  platformVariantTagOf,
} from "../../../scripts/third-party-npm.mjs";
import {
  stageCuaDriverIntoBundledAgents,
  verifyStagedCuaDriver,
} from "../../desktop/scripts/cua-driver-package-assets.mjs";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 「平台变体包缺失」判据 + Computer Use 驱动 staging 的回归测试。
 *
 * 运行：cd packages/services && node --import tsx --test test/platformVariantAndCuaDriverStaging.test.ts
 *
 * 为什么这两件事放在一起：它们是同一条发布链上的前后两环 —— 前者决定
 * licenses 门禁不会把「其他平台的原生包没装」误报成缺依赖，后者保证当前平台的
 * 原生包真的被打进安装包。前者放过太多会掩盖真缺失，后者漏拷会让正式包的
 * Computer Use 静默不可用。
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// ─────────────────────────────── 平台变体判据

test("a platform tag is extracted from the package name suffix", () => {
  assert.equal(platformVariantTagOf("@napi-rs/canvas-linux-x64-gnu"), "linux-x64-gnu");
  assert.equal(platformVariantTagOf("@ubjs/node-linux-arm64-musl"), "linux-arm64-musl");
  assert.equal(platformVariantTagOf("@trycua/cua-driver-win32-x64-msvc"), "win32-x64-msvc");
  assert.equal(platformVariantTagOf("@trycua/cua-driver-darwin-arm64"), "darwin-arm64");
  // 无 abi 后缀的写法（esbuild 等包如此命名）。
  assert.equal(platformVariantTagOf("esbuild-linux-x64"), "linux-x64");
  // 不是平台变体：普通包名不能因为含平台词就命中。
  assert.equal(platformVariantTagOf("@zcode/shared"), undefined);
  assert.equal(platformVariantTagOf("react"), undefined);
  assert.equal(platformVariantTagOf("windows-release"), undefined);
  assert.equal(platformVariantTagOf("@trycua/cua-driver"), undefined);
});

test("the current platform's variant is never treated as foreign", () => {
  // 这条是判据的核心价值：当前平台的原生包缺失时必须继续报错，
  // 否则真正缺依赖会被静默放过。
  const tags = currentPlatformVariantTags();
  assert.ok(tags.size > 0, "至少要有当前平台标签");
  for (const tag of tags) {
    assert.equal(isForeignPlatformVariant(`some-native-pkg-${tag}`, tags), false, tag);
  }
  // 反向确认：换成一组明显不含当前平台的标签时，同样的包名会被判为 foreign。
  const unrelated = new Set(["plan9-sparc"]);
  for (const tag of tags) {
    assert.equal(isForeignPlatformVariant(`some-native-pkg-${tag}`, unrelated), true, tag);
  }
});

test("another platform's variant is exempt so the gate does not fail spuriously", () => {
  const tags = currentPlatformVariantTags();
  // 构造一个确定不在当前平台的标签。
  const foreignTag = tags.has("linux-x64-gnu") ? "darwin-arm64" : "linux-x64-gnu";
  assert.equal(isForeignPlatformVariant(`@ubjs/node-${foreignTag}`, tags), true);
  // 非平台变体包一律不免除 —— 缺了真依赖还是要报错。
  assert.equal(isForeignPlatformVariant("@ubjs/core", tags), false);
  assert.equal(isForeignPlatformVariant("typescript", tags), false);
});

test("glibc treats the bare linux tag as current, musl does not", () => {
  // npm 生态里无 abi 后缀的 linux-<arch> 指 glibc。判错会把 musl 包当成当前平台
  // （放过真缺失），或把 glibc 包当成其他平台（误报）。
  const gnuTags = new Set(["linux-x64-gnu", "linux-x64"]);
  const muslTags = new Set(["linux-x64-musl"]);
  assert.equal(isForeignPlatformVariant("@napi-rs/canvas-linux-x64", gnuTags), false);
  assert.equal(isForeignPlatformVariant("@napi-rs/canvas-linux-x64", muslTags), true);
});

// ─────────────────────────────── CUA 驱动 staging

const TARGET = { os: "linux", arch: "x64", key: "linux-x64", npmLibc: "glibc" };

const require = (await import("node:module")).createRequire(import.meta.url);

/**
 * 造一棵最小的 staged 树：node-repl-host bundle + 驱动依赖闭包。
 *
 * **必须**一起拷 package.json：它声明 `"type": "module"`，而 bundle 是 ESM
 * （含顶层 await）。少了它，Node 按 CJS 解析 .js，esbuild 的 transform 直接报
 * "Top-level await is currently not supported with the cjs output format" ——
 * 这是测试夹具与生产不符，不是产物问题。生产的 stageOfficialPlugins 同样会拷
 * package.json（见 prepare-agent-node-bundle.mjs 的 includedOfficialPluginTopLevelPaths）。
 */
function stageFixture(root) {
  rmSync(root, { recursive: true, force: true });
  const glmDir = resolve(root, "glm");
  const hostDir = resolve(glmDir, "packages/node-repl-host/dist/mcp");
  mkdirSync(hostDir, { recursive: true });
  const source = resolve(repoRoot, "apps/zcode-cli/packages/node-repl-host/dist/mcp/server.js");
  if (!existsSync(source)) return undefined; // 未构建时跳过，由调用方断言前置条件
  const { copyFileSync } = require("node:fs");
  copyFileSync(source, resolve(hostDir, "server.js"));
  copyFileSync(
    resolve(repoRoot, "apps/zcode-cli/packages/node-repl-host/package.json"),
    resolve(glmDir, "packages/node-repl-host/package.json"),
  );
  return glmDir;
}

test("staging places the driver closure and its platform native library", async (t) => {
  const root = "/tmp/zcode-cua-staging-test";
  const glmDir = stageFixture(root);
  if (!glmDir) {
    t.skip("node-repl-host bundle 未构建（先跑 pnpm --filter @zcode/node-repl-host build）");
    return;
  }
  const result = stageCuaDriverIntoBundledAgents({
    lookupRoots: [repoRoot, resolve(repoRoot, "packages/desktop")],
    glmDir,
    targetPlatform: TARGET,
  });
  assert.equal(result.triple, "linux-x64-gnu");
  const names = result.staged.map((item) => item.packageName).sort();
  assert.deepEqual(names, [
    "@trycua/cua-driver",
    "@trycua/cua-driver-linux-x64-gnu",
    "@ubjs/core",
    "@ubjs/node",
    "@ubjs/node-linux-x64-gnu",
  ]);
  // 只 stage 目标平台：全拷会把六个平台的二进制一起打进安装包。
  assert.ok(!names.some((name) => name.includes("darwin") || name.includes("win32")));
  // 原生依赖落在 node-repl-host 的 node_modules 下：electron-builder 会硬编码丢弃
  // **源根直属**的 node_modules（util/filter.js 的 `if (relative === "node_modules") return false`），
  // 所以不能放 glm/node_modules —— 那条路写什么 filter 都打不进包（见 staging 模块头注释）。
  assert.equal(result.nodeModulesDir, resolve(glmDir, "packages/node-repl-host/node_modules"));
  // 原生库本体必须真的到位（只看目录会把"目录在但 .so 没拷进来"放过去）。
  assert.ok(
    existsSync(
      resolve(
        glmDir,
        "packages/node-repl-host/node_modules/@trycua/cua-driver-linux-x64-gnu/libcua_driver_sdk.so",
      ),
    ),
  );
  // 体积统计用于构建日志：用户需要知道安装包会变大多少。
  assert.ok(result.staged.every((item) => item.size > 0));
  assert.deepEqual(verifyStagedCuaDriver({ resourcesDir: root, targetPlatform: TARGET }), []);
});

test("verification catches every way the staged runtime can be incomplete", async (t) => {
  const root = "/tmp/zcode-cua-staging-test-verify";
  const glmDir = stageFixture(root);
  if (!glmDir) {
    t.skip("node-repl-host bundle 未构建");
    return;
  }
  stageCuaDriverIntoBundledAgents({
    lookupRoots: [repoRoot, resolve(repoRoot, "packages/desktop")],
    glmDir,
    targetPlatform: TARGET,
  });

  const nodeModulesDir = resolve(glmDir, "packages/node-repl-host/node_modules");

  // ① 原生库缺失
  rmSync(resolve(nodeModulesDir, "@trycua/cua-driver-linux-x64-gnu/libcua_driver_sdk.so"), {
    force: true,
  });
  assert.match(
    verifyStagedCuaDriver({ resourcesDir: root, targetPlatform: TARGET }).join("\n"),
    /missing staged native driver/u,
  );

  // ② 平台依赖包整目录缺失
  rmSync(resolve(nodeModulesDir, "@ubjs/node-linux-x64-gnu"), {
    recursive: true,
    force: true,
  });
  assert.match(
    verifyStagedCuaDriver({ resourcesDir: root, targetPlatform: TARGET }).join("\n"),
    /missing staged driver package @ubjs\/node-linux-x64-gnu/u,
  );

  // ③ node_repl host bundle 缺失（staging 顺序被改坏的信号）
  rmSync(resolve(glmDir, "packages/node-repl-host"), { recursive: true, force: true });
  assert.match(
    verifyStagedCuaDriver({ resourcesDir: root, targetPlatform: TARGET }).join("\n"),
    /missing staged node_repl host bundle/u,
  );
});

test("an unsupported target platform fails loudly instead of staging nothing", () => {
  assert.throws(
    () =>
      stageCuaDriverIntoBundledAgents({
        lookupRoots: [repoRoot],
        glmDir: "/tmp/zcode-cua-staging-test-bad",
        targetPlatform: { os: "freebsd", arch: "x64" },
      }),
    /unsupported target platform/u,
  );
});

test("the staged tree really resolves the driver from the host bundle", async (t) => {
  // 端到端：这是整套 staging 的唯一目的 —— staged bundle 能 import 到原生驱动。
  const root = "/tmp/zcode-cua-staging-test-e2e";
  const glmDir = stageFixture(root);
  if (!glmDir) {
    t.skip("node-repl-host bundle 未构建");
    return;
  }
  stageCuaDriverIntoBundledAgents({
    lookupRoots: [repoRoot, resolve(repoRoot, "packages/desktop")],
    glmDir,
    targetPlatform: TARGET,
  });
  const module = await import(resolve(glmDir, "packages/node-repl-host/dist/mcp/server.js"));
  const runtime = module.captureComputerUseRuntimeFromEnvironment({
    ZCODE_CUA_NODE_REPL_HOST: "1",
  });
  assert.ok(runtime, "staged host must expose the Computer Use runtime");
  // 不依赖真实桌面：只要驱动能加载，list_apps 就会成功返回（空列表也算成功）。
  const result = await runtime.execute({
    toolName: "list_apps",
    arguments: {},
    context: { sessionId: "s", runtimeScope: "main", workspaceKey: "w" },
  });
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  await runtime.dispose();
});

test("the host bundle keeps the driver as a runtime import rather than inlining it", async (t) => {
  // esbuild 无法 bundle uniffi 的 .node；一旦被内联，staging 就失去意义，
  // 而症状只在正式包出现。这里把 bundle 策略本身钉住。
  const bundle = resolve(repoRoot, "apps/zcode-cli/packages/node-repl-host/dist/mcp/server.js");
  if (!existsSync(bundle)) {
    t.skip("node-repl-host bundle 未构建");
    return;
  }
  const source = readFileSync(bundle, "utf8");
  assert.match(source, /@trycua\/cua-driver/u);
  assert.ok(
    !source.includes("cua_driver_sdk"),
    "native driver must not be inlined into the bundle",
  );
});
