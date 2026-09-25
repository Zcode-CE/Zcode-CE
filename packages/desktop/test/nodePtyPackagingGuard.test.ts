import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
import test from "node:test";
import {
  assertPackagedNodePtyPayloadVerified,
  resolveNodePtyPayloadSourcePackageName,
  resolvePackagedNodePtyPrebuildPath,
  resolveSourceNodePtyPrebuildPath,
} from "../scripts/node-pty-package-assets.mjs";

/**
 * 分发产物里 node-pty 原生载荷的护栏（task-73）。
 *
 * 为什么必须钉住：node-pty 的加载顺序是 [build/Release, build/Debug, prebuilds/<platform>-<arch>]
 * （node-pty/lib/utils.js:19），build/Release **优先于** prebuilds。本仓同时存在两份来源不同的
 * pty.node：本地在 Node 24 下编的（build/Release，1.1.0）与打包时从 @lydell/node-pty-<platform>
 * 恢复进来的（prebuilds/...）。一旦产物同时带这两份，运行时会静默加载未经验证的那一份，
 * 终端仍然"能开"、只在特定条件下崩 —— 这类静默失效最难排查，所以要在出包阶段 fail-closed。
 */

const PLATFORM_KEY = "linux-x64";
const SOURCE_PACKAGE = "@lydell/node-pty-" + PLATFORM_KEY;

function withFakeArtifact(run: (resourcesDir: string, packageRoot: string) => void): string | null {
  const resourcesDir = mkdtempSync(join(tmpdir(), "node-pty-artifact-"));
  const packageRoot = join(resourcesDir, "app.asar.unpacked", "node_modules", "node-pty");
  mkdirSync(join(packageRoot, "prebuilds", PLATFORM_KEY), { recursive: true });
  let skipped: string | null = null;
  try {
    let sourceBinaryPath: string;
    try {
      sourceBinaryPath = resolveSourceNodePtyPrebuildPath({
        sourcePackageName: SOURCE_PACKAGE,
        platformKey: PLATFORM_KEY,
      });
    } catch (error) {
      skipped = String(error instanceof Error ? error.message : error);
      return skipped;
    }
    cpSync(sourceBinaryPath, join(packageRoot, "prebuilds", PLATFORM_KEY, "pty.node"));
    run(resourcesDir, packageRoot);
    return null;
  } finally {
    rmSync(resourcesDir, { recursive: true, force: true });
  }
}

test("干净产物：通过，并回报校验过的摘要", (t) => {
  const skipped = withFakeArtifact((resourcesDir) => {
    const result = assertPackagedNodePtyPayloadVerified({
      resourcesDir,
      platformKey: PLATFORM_KEY,
    });
    assert.equal(result.checked, true);
    assert.equal(result.platformKey, PLATFORM_KEY);
    assert.match(result.digest, /^[0-9a-f]{32}$/);
  });
  if (skipped) t.skip("本机没有 " + SOURCE_PACKAGE + "：" + skipped);
});

test("产物内出现 build/Release/pty.node 必须失败（它优先于 prebuilds 被加载）", (t) => {
  const skipped = withFakeArtifact((resourcesDir, packageRoot) => {
    const forbiddenDir = join(packageRoot, "build", "Release");
    mkdirSync(forbiddenDir, { recursive: true });
    writeFileSync(join(forbiddenDir, "pty.node"), "not-our-verified-binary");
    assert.throws(
      () => assertPackagedNodePtyPayloadVerified({ resourcesDir, platformKey: PLATFORM_KEY }),
      (error: unknown) => {
        const message = String(error instanceof Error ? error.message : error);
        assert.ok(
          message.includes("build/Release"),
          "错误必须点名 build/Release，实际：" + message,
        );
        assert.ok(
          message.includes("加载顺序") || message.includes("utils.js:19"),
          "错误必须写明原因（加载顺序/lib/utils.js:19），否则后人会删掉这条校验，实际：" + message,
        );
        return true;
      },
    );
  });
  if (skipped) t.skip("本机没有 " + SOURCE_PACKAGE + "：" + skipped);
});

test("产物内出现 build/Debug/pty.node 同样必须失败", (t) => {
  const skipped = withFakeArtifact((resourcesDir, packageRoot) => {
    const forbiddenDir = join(packageRoot, "build", "Debug");
    mkdirSync(forbiddenDir, { recursive: true });
    writeFileSync(join(forbiddenDir, "pty.node"), "debug-build-binary");
    assert.throws(
      () => assertPackagedNodePtyPayloadVerified({ resourcesDir, platformKey: PLATFORM_KEY }),
      (error: unknown) =>
        String(error instanceof Error ? error.message : error).includes("build/Debug"),
    );
  });
  if (skipped) t.skip("本机没有 " + SOURCE_PACKAGE + "：" + skipped);
});

test("prebuilds 那份与平台包不一致必须失败（否则静默跑未验证的原生模块）", (t) => {
  const skipped = withFakeArtifact((resourcesDir, packageRoot) => {
    writeFileSync(join(packageRoot, "prebuilds", PLATFORM_KEY, "pty.node"), "tampered-binary");
    assert.throws(
      () => assertPackagedNodePtyPayloadVerified({ resourcesDir, platformKey: PLATFORM_KEY }),
      (error: unknown) => {
        const message = String(error instanceof Error ? error.message : error);
        assert.ok(message.includes("与平台包不一致"), "错误必须说明哈希不一致，实际：" + message);
        assert.ok(message.includes(SOURCE_PACKAGE), "错误必须点名平台包，实际：" + message);
        return true;
      },
    );
  });
  if (skipped) t.skip("本机没有 " + SOURCE_PACKAGE + "：" + skipped);
});

test("prebuilds 缺失必须失败", (t) => {
  const skipped = withFakeArtifact((resourcesDir, packageRoot) => {
    rmSync(join(packageRoot, "prebuilds", PLATFORM_KEY, "pty.node"));
    assert.throws(
      () => assertPackagedNodePtyPayloadVerified({ resourcesDir, platformKey: PLATFORM_KEY }),
      (error: unknown) =>
        String(error instanceof Error ? error.message : error).includes("预编译产物缺失"),
    );
  });
  if (skipped) t.skip("本机没有 " + SOURCE_PACKAGE + "：" + skipped);
});

test("产物内没有 node-pty 时不适用（checked:false），不误伤其它形态", () => {
  const resourcesDir = mkdtempSync(join(tmpdir(), "node-pty-absent-"));
  try {
    const result = assertPackagedNodePtyPayloadVerified({
      resourcesDir,
      platformKey: PLATFORM_KEY,
    });
    assert.equal(result.checked, false);
    assert.ok(String(result.reason).includes("产物内没有 node-pty"));
  } finally {
    rmSync(resourcesDir, { recursive: true, force: true });
  }
});

test("路径约定：护栏检查的位置与 resolvePackagedNodePtyPrebuildPath 一致（防两侧漂移）", (t) => {
  const skipped = withFakeArtifact((resourcesDir) => {
    const expectedPath = resolvePackagedNodePtyPrebuildPath({
      resourcesDir,
      platformKey: PLATFORM_KEY,
    });
    assert.ok(existsSync(expectedPath), "平台路径助手指向的文件必须存在（假产物已按该约定布局）");
    assert.ok(expectedPath.includes("app.asar.unpacked"), "必须沿用 app.asar.unpacked 约定");
    const result = assertPackagedNodePtyPayloadVerified({
      resourcesDir,
      platformKey: PLATFORM_KEY,
    });
    assert.equal(result.checked, true, "同一布局下护栏必须通过，证明两侧口径一致");
  });
  if (skipped) t.skip("本机没有 " + SOURCE_PACKAGE + "：" + skipped);
});

/**
 * 平台来源分叉的回归护栏（本次 Windows 构建失败的直接原因）。
 *
 * 原缺陷：护栏把来源包硬编码成 `@lydell/node-pty-<platformKey>`，而 @lydell 的 win32 包
 * 不提供 pty.node（实测其 prebuilds/win32-x64 下只有 conpty.node / conpty_console_list.node /
 * conpty/），win32 构建因此在 afterPack 抛 Cannot find module '@lydell/node-pty-win32-x64'。
 * 修复后来源按平台分叉，且 restore 与断言共用同一份映射（禁止各写一份）。
 */
test("来源包按平台分叉：linux 用 @lydell，win32/darwin 用 node-pty 自身", () => {
  assert.equal(resolveNodePtyPayloadSourcePackageName("linux-x64"), "@lydell/node-pty-linux-x64");
  assert.equal(
    resolveNodePtyPayloadSourcePackageName("linux-arm64"),
    "@lydell/node-pty-linux-arm64",
  );
  for (const key of ["win32-x64", "win32-arm64", "darwin-x64", "darwin-arm64"]) {
    assert.equal(
      resolveNodePtyPayloadSourcePackageName(key),
      "node-pty",
      key + " 的来源必须是 node-pty 自身（@lydell 的 win32 包不含 pty.node）",
    );
  }
});

test("win32/darwin 产物：用 node-pty 自带的 prebuild 就能通过（原缺陷的直接回归）", () => {
  // 这条不经过 resolveNodePtyPayloadSourcePackageName：直接从 node-pty 自身目录取那份，
  // 因此映射被改坏时它不会「跟着一起坏」而假绿（反向验证时发现的空跑风险）。
  let nodePtyRoot: string;
  try {
    nodePtyRoot = dirname(require.resolve("node-pty/package.json"));
  } catch {
    return; // 本机没有 node-pty（CI 恒有）
  }
  let covered = 0;
  for (const platformKey of ["win32-x64", "win32-arm64", "darwin-x64", "darwin-arm64"]) {
    const prebuild = join(nodePtyRoot, "prebuilds", platformKey, "pty.node");
    if (!existsSync(prebuild)) continue;
    covered += 1;
    // 产物布局 = node-pty 目录原样（prebuilds 已在该平台目录下）。
    const root = mkdtempSync(join(tmpdir(), "node-pty-src-" + platformKey + "-"));
    const packageRoot = join(root, "node-pty");
    mkdirSync(join(packageRoot, "prebuilds", platformKey), { recursive: true });
    cpSync(prebuild, join(packageRoot, "prebuilds", platformKey, "pty.node"));
    try {
      const result = assertPackagedNodePtyPayloadVerified({
        nodePtyPackageRoot: packageRoot,
        platformKey,
      });
      assert.equal(
        result.checked,
        true,
        platformKey + " 必须通过（原缺陷在此抛 Cannot find module）",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  assert.ok(covered > 0, "本机 node-pty 必须至少带一个 win32/darwin prebuild，否则这条回归是空跑");
});

test("build/Release 下的 conpty.node 也必须被拦（Windows 真正加载的那一份）", (t) => {
  // Windows 默认走 conpty 后端：windowsPtyAgent.js:38-50 命中时 loadNativeModule('conpty')，
  // 只有回退 winpty 才 loadNativeModule('pty')。只查 pty.node 会让这份绕过护栏。
  const skipped = withFakeArtifact((resourcesDir, packageRoot) => {
    const forbiddenDir = join(packageRoot, "build", "Release");
    mkdirSync(forbiddenDir, { recursive: true });
    writeFileSync(join(forbiddenDir, "conpty.node"), "host-built-conpty");
    assert.throws(
      () => assertPackagedNodePtyPayloadVerified({ resourcesDir, platformKey: PLATFORM_KEY }),
      (error: unknown) => {
        const message = String(error instanceof Error ? error.message : error);
        assert.ok(message.includes("build/Release"), "必须点名 build/Release，实际：" + message);
        assert.ok(message.includes("conpty.node"), "必须点名 conpty.node，实际：" + message);
        return true;
      },
    );
  });
  if (skipped) t.skip("本机没有 " + SOURCE_PACKAGE + "：" + skipped);
});

test("build/Debug 下的 conpty_console_list.node 同样必须被拦", (t) => {
  const skipped = withFakeArtifact((resourcesDir, packageRoot) => {
    const forbiddenDir = join(packageRoot, "build", "Debug");
    mkdirSync(forbiddenDir, { recursive: true });
    writeFileSync(join(forbiddenDir, "conpty_console_list.node"), "host-built-list");
    assert.throws(
      () => assertPackagedNodePtyPayloadVerified({ resourcesDir, platformKey: PLATFORM_KEY }),
      (error: unknown) =>
        String(error instanceof Error ? error.message : error).includes("conpty_console_list.node"),
    );
  });
  if (skipped) t.skip("本机没有 " + SOURCE_PACKAGE + "：" + skipped);
});
