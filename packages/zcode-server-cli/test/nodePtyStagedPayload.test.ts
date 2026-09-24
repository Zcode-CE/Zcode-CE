import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertPackagedNodePtyPayloadVerified,
  resolveSourceNodePtyPrebuildPath,
} from "../../desktop/scripts/node-pty-package-assets.mjs";
import { assertStagedNodePtyPayload } from "../src/packaging/stage.js";

/**
 * CLI 发行包（dist-release）形态的 node-pty 护栏（task-74）。
 *
 * 为什么必须：ce.3 要发的 npm/Docker 就是这个形态，而它此前**没有任何产物校验步骤**。
 * stage 白名单今天已剔除 build/，但白名单一旦被改宽，产物就会带上宿主编译产物
 * build/Release/pty.node —— node-pty 的加载顺序是 [build/Release, build/Debug,
 * prebuilds/<platform>-<arch>]（node-pty/lib/utils.js:19），build/Release 优先
 * ⇒ 目标机静默加载未经我们验证的原生模块。断言实现与桌面端共用同一份（单一实现）。
 */

const PLATFORM_KEY = "linux-x64";
const SOURCE_PACKAGE = "@lydell/node-pty-" + PLATFORM_KEY;

function resolvePlatformBinary(): string | null {
  // 用护栏自己的解析器取平台包那份：保证干净产物用的就是护栏的比较基准，
  // 不会因为两侧解析到不同副本而假红/假绿。
  try {
    return resolveSourceNodePtyPrebuildPath({
      sourcePackageName: SOURCE_PACKAGE,
      platformKey: PLATFORM_KEY,
    });
  } catch {
    return null;
  }
}

const platformBinary = resolvePlatformBinary();

function withStagedRuntime(run: (nodeModulesTargetDir: string, packageRoot: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "zcode-cli-staged-"));
  const nodeModulesTargetDir = join(root, "zcode-server-linux-x64", "runtime", "node_modules");
  const packageRoot = join(nodeModulesTargetDir, "node-pty");
  mkdirSync(join(packageRoot, "prebuilds", PLATFORM_KEY), { recursive: true });
  try {
    if (platformBinary)
      cpSync(platformBinary, join(packageRoot, "prebuilds", PLATFORM_KEY, "pty.node"));
    run(nodeModulesTargetDir, packageRoot);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("stage 后的干净产物：通过并回报摘要", (t) => {
  if (!platformBinary) return t.skip("本机没有 " + SOURCE_PACKAGE);
  withStagedRuntime((nodeModulesTargetDir, packageRoot) => {
    assertStagedNodePtyPayload({ nodeModulesTargetDir, target: PLATFORM_KEY });
    const result = assertPackagedNodePtyPayloadVerified({
      nodePtyPackageRoot: packageRoot,
      platformKey: PLATFORM_KEY,
    });
    assert.equal(result.checked, true);
    assert.match(String(result.digest), /^[0-9a-f]{32}$/);
  });
});

test("stage 后产物出现 build/Release/pty.node ⇒ 必须失败", (t) => {
  if (!platformBinary) return t.skip("本机没有 " + SOURCE_PACKAGE);
  withStagedRuntime((nodeModulesTargetDir, packageRoot) => {
    mkdirSync(join(packageRoot, "build", "Release"), { recursive: true });
    writeFileSync(join(packageRoot, "build", "Release", "pty.node"), "host-built-binary");
    assert.throws(
      () => assertStagedNodePtyPayload({ nodeModulesTargetDir, target: PLATFORM_KEY }),
      (error: unknown) => {
        const message = String(error instanceof Error ? error.message : error);
        assert.ok(message.includes("build/Release"), "必须点名 build/Release，实际：" + message);
        assert.ok(message.includes("utils.js:19") || message.includes("加载顺序"), "必须写明原因");
        return true;
      },
    );
  });
});

test("stage 后 prebuilds 与平台包 md5 不一致 ⇒ 必须失败", (t) => {
  if (!platformBinary) return t.skip("本机没有 " + SOURCE_PACKAGE);
  withStagedRuntime((nodeModulesTargetDir, packageRoot) => {
    writeFileSync(join(packageRoot, "prebuilds", PLATFORM_KEY, "pty.node"), "tampered");
    assert.throws(
      () => assertStagedNodePtyPayload({ nodeModulesTargetDir, target: PLATFORM_KEY }),
      (error: unknown) =>
        String(error instanceof Error ? error.message : error).includes("与平台包不一致"),
    );
  });
});

test("产物内没有 node-pty ⇒ 不适用（不误伤）", () => {
  const root = mkdtempSync(join(tmpdir(), "zcode-cli-nopty-"));
  const nodeModulesTargetDir = join(root, "runtime", "node_modules");
  mkdirSync(nodeModulesTargetDir, { recursive: true });
  try {
    assertStagedNodePtyPayload({ nodeModulesTargetDir, target: PLATFORM_KEY });
    const result = assertPackagedNodePtyPayloadVerified({
      nodePtyPackageRoot: join(nodeModulesTargetDir, "node-pty"),
      platformKey: PLATFORM_KEY,
    });
    assert.equal(result.checked, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("既没有 resourcesDir 也没有 nodePtyPackageRoot ⇒ 显式报错（防误用成静默通过）", () => {
  assert.throws(
    () => assertPackagedNodePtyPayloadVerified({ platformKey: PLATFORM_KEY }),
    (error: unknown) =>
      String(error instanceof Error ? error.message : error).includes(
        "需要 resourcesDir 或 nodePtyPackageRoot 之一",
      ),
  );
});
