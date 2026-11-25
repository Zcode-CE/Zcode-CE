import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createConfig, createConfigAsync } from "../src/config/index.js";

/**
 * 工作区 Hook 入口脚本内容绑定（D24 / ZP-20261110-06）在配置装配入口的接线护栏。
 *
 * 为什么必须钉住两条相反的断言：
 * 1. 同步 createConfig 拿不到脚本状态，必须保持引入内容绑定之前的 declaration digest。
 *    一旦它也跟着变，升级会把既有 Trust 一次性失效，而那条路径本身并没有读到脚本内容，
 *    等于白付代价（金样与 packages/shared/test/workspaceHookScriptBinding.test.ts 同源）。
 * 2. 异步 createConfigAsync 必须绑定脚本内容并把三态（file/missing/unverifiable）写进条目：
 *    运行时（create-app）与 Review / Settings 共用这份摘要，漏接就是「声明不变、换脚本」
 *    仍能沿用旧 Trust 的 TOCTOU 面。
 */

/** 与 shared 金样同源的声明：process bash hook.sh（SessionStart 单 matcher 单 hook）。 */
const DECLARATION_SCRIPT = "hook.sh";
const LEGACY_DECLARATION_DIGEST =
  "62de1139cc89a54eab91f3f1662d2cd734594d5ab9414240c91b4ad416e3b701";

const roots: string[] = [];

after(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zcode-hook-config-"));
  roots.push(root);
  await mkdir(join(root, ".git"), { recursive: true });
  await mkdir(join(root, ".zcode"), { recursive: true });
  await writeFile(
    join(root, ".zcode", "config.json"),
    JSON.stringify({
      hooks: {
        enabled: true,
        events: {
          SessionStart: [{ hooks: [{ type: "process", command: "bash", args: [DECLARATION_SCRIPT] }] }],
        },
      },
    }),
    "utf8",
  );
  return root;
}

const options = (workspace: string) => ({
  workingDirectory: workspace,
  workspaceIdentity: workspace,
  env: {},
  skipUserConfig: true,
} as const);

async function asyncSnapshot(workspace: string) {
  const result = await createConfigAsync(options(workspace));
  const snapshot = result.sources.project.workspaceHookSnapshot;
  assert.ok(snapshot, "异步入口应产出 workspace hook 快照");
  return snapshot;
}

test("同步 createConfig 不绑定脚本内容：无 scriptEntry，摘要等于内容绑定之前的金样", async () => {
  const workspace = await makeWorkspace();
  await writeFile(join(workspace, DECLARATION_SCRIPT), "echo one\n", "utf8");

  const snapshot = createConfig(options(workspace)).sources.project.workspaceHookSnapshot;
  assert.ok(snapshot);
  assert.equal(snapshot.hooks[0]?.scriptEntry, undefined, "同步路径不得携带 scriptEntry");
  assert.equal(
    snapshot.hooks[0]?.hookDeclarationDigest,
    LEGACY_DECLARATION_DIGEST,
    "同步路径的 declaration digest 必须与改动前逐字节相同",
  );
});

test("异步 createConfigAsync 绑定入口脚本：file 三态与摘要变化", async () => {
  const workspace = await makeWorkspace();
  const scriptPath = join(workspace, DECLARATION_SCRIPT);
  await writeFile(scriptPath, "echo one\n", "utf8");

  const present = await asyncSnapshot(workspace);
  assert.equal(present.hooks[0]?.scriptEntry?.path, DECLARATION_SCRIPT);
  assert.equal(present.hooks[0]?.scriptEntry?.state.kind, "file");
  assert.notEqual(
    present.hooks[0]?.hookDeclarationDigest,
    LEGACY_DECLARATION_DIGEST,
    "绑定脚本内容后的摘要必须区别于声明级旧摘要",
  );

  await writeFile(scriptPath, "echo two\n", "utf8");
  const changed = await asyncSnapshot(workspace);
  assert.notEqual(
    changed.hooks[0]?.hookDeclarationDigest,
    present.hooks[0]?.hookDeclarationDigest,
    "脚本内容变化必须改变 declaration digest（旧 Trust 因此不再匹配）",
  );
  assert.notEqual(changed.bundleDigest, present.bundleDigest);

  // 稳定不抖动：内容不变时两次装配必须得到同一摘要。
  const again = await asyncSnapshot(workspace);
  assert.equal(again.hooks[0]?.hookDeclarationDigest, changed.hooks[0]?.hookDeclarationDigest);
  assert.equal(again.bundleDigest, changed.bundleDigest);
});

test("异步 createConfigAsync 对缺失与不可读入口给明确状态且摘要互不相同", async () => {
  const workspace = await makeWorkspace();
  const scriptPath = join(workspace, DECLARATION_SCRIPT);

  const missing = await asyncSnapshot(workspace);
  assert.deepEqual(missing.hooks[0]?.scriptEntry, {
    path: DECLARATION_SCRIPT,
    state: { kind: "missing" },
  });

  await writeFile(scriptPath, "echo one\n", "utf8");
  const present = await asyncSnapshot(workspace);

  await rm(scriptPath, { force: true });
  await mkdir(scriptPath);
  const unreadable = await asyncSnapshot(workspace);
  assert.deepEqual(unreadable.hooks[0]?.scriptEntry, {
    path: DECLARATION_SCRIPT,
    state: { kind: "unverifiable" },
  });

  const digests = new Set([
    missing.hooks[0]?.hookDeclarationDigest,
    present.hooks[0]?.hookDeclarationDigest,
    unreadable.hooks[0]?.hookDeclarationDigest,
  ]);
  assert.equal(digests.size, 3, "三种脚本状态不得共用同一 declaration digest");
  assert.equal(digests.has(LEGACY_DECLARATION_DIGEST), false);
});
