import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createConfig, createConfigAsync } from "@zcode/adapters/config";
import { WorkspaceHookMutationError } from "@zcode/shared/workspace-hook-mutation";
import { createWorkspaceHookReviewMutationPort } from "../src/app/workspace-hook-review-mutation.js";
import {
  grantWorkspaceHookTrust,
  inspectWorkspaceHookTrust,
} from "../src/workspace-hook-trust-cli.js";

/**
 * 工作区 Hook 入口脚本内容绑定（D24）在三个异步消费点的跨入口一致性护栏。
 *
 * 为什么必须钉住：内容绑定是「调用方传 scriptStates 才生效」的开关，而摘要不匹配的代价是
 * 用户可见的抖动——同一工作区在运行时（createConfigAsync）、CLI 信任检查（inspect/grant）
 * 与审核中 toggle 的重建之间只要有一个入口漏传，就会出现 bound / unbound 两种 bundleDigest：
 * toggle 恒报 workspace_hooks_bundle_changed，授权写进去的摘要运行时永远不匹配。
 * Settings 侧（packages/services）的同一断言在 packages/services/test 内维护，
 * 两者都用 shared 的同一个 builder 作参照，因此「相等」是结构性的。
 *
 * 运行：cd apps/zcode-cli/packages/bootstrap && node --import tsx --test test/workspaceHookScriptWiring.test.ts
 */

const SCRIPT = "hook.sh";

const roots: string[] = [];

after(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Fixture {
  workspace: string;
  userConfigPath: string;
  scriptPath: string;
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "zcode-hook-wiring-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const scriptPath = join(workspace, SCRIPT);
  await mkdir(join(workspace, ".git"), { recursive: true });
  await mkdir(join(workspace, ".zcode"), { recursive: true });
  await writeFile(
    join(workspace, ".zcode", "config.json"),
    JSON.stringify({
      hooks: {
        enabled: true,
        events: {
          SessionStart: [{ hooks: [{ type: "process", command: "bash", args: [SCRIPT] }] }],
        },
      },
    }),
    "utf8",
  );
  await writeFile(scriptPath, "echo one\n", "utf8");
  // 信任存储根目录钉到临时目录：storage.dir 是绝对路径时不会落到真实 ~/.zcode。
  const userConfigPath = join(root, "user", "config.json");
  await mkdir(join(root, "user"), { recursive: true });
  await writeFile(
    userConfigPath,
    JSON.stringify({ storage: { dir: join(root, "storage") } }),
    "utf8",
  );
  return { workspace, userConfigPath, scriptPath };
}

function configOptions(fixture: Fixture) {
  return {
    workingDirectory: fixture.workspace,
    workspaceIdentity: fixture.workspace,
    env: {},
    skipUserConfig: true,
    userConfigPath: fixture.userConfigPath,
  } as const;
}

test("运行时、CLI 信任检查与审核中重建共用同一份 bound bundleDigest", async () => {
  const fixture = await makeFixture();
  const config = await createConfigAsync(configOptions(fixture));
  const snapshot = config.sources.project.workspaceHookSnapshot;
  assert.ok(snapshot);
  assert.equal(snapshot.hooks[0]?.scriptEntry?.state.kind, "file", "运行时快照必须绑定入口脚本");

  // 入口一：同步 createConfig 是兼容基线，不绑定脚本内容（既有 Trust 不因升级失效）。
  const syncSnapshot = createConfig(configOptions(fixture)).sources.project.workspaceHookSnapshot;
  assert.ok(syncSnapshot);
  assert.equal(syncSnapshot.hooks[0]?.scriptEntry, undefined);
  assert.notEqual(syncSnapshot.bundleDigest, snapshot.bundleDigest);

  // 入口二：CLI 信任检查（inspect 比对 trust store 里的 digest）。
  const status = await inspectWorkspaceHookTrust({
    workspacePath: fixture.workspace,
    workspaceIdentity: fixture.workspace,
    userConfigPath: fixture.userConfigPath,
  });
  assert.equal(status.bundleDigest, snapshot.bundleDigest, "CLI inspect 与运行时必须同摘要");
  assert.equal(status.items[0]?.hookDeclarationDigest, snapshot.hooks[0]?.hookDeclarationDigest);

  // 入口三：审核中 toggle 的重建（bundleDigest 不一致会抛 bundle_changed）。
  const port = createWorkspaceHookReviewMutationPort({
    workingDirectory: fixture.workspace,
    workspaceIdentity: fixture.workspace,
    runtimeRoot: config.sources.project.workspaceHookRuntimeRoot!,
  });
  const entry = snapshot.hooks[0];
  assert.ok(entry);
  await port.toggle({ snapshot, reviewItemId: entry.reviewItemId, enabled: false }, () => {});
  const written = JSON.parse(await readFile(join(fixture.workspace, ".zcode", "config.json"), "utf8")) as {
    hooks: { events: { SessionStart: Array<{ hooks: Array<{ enabled?: boolean }> }> } };
  };
  assert.equal(written.hooks.events.SessionStart[0]?.hooks[0]?.enabled, false);
});

test("脚本被替换后：旧授权记录不再匹配，审核中 toggle 必须报 bundle_changed", async () => {
  const fixture = await makeFixture();
  const config = await createConfigAsync(configOptions(fixture));
  const snapshot = config.sources.project.workspaceHookSnapshot;
  assert.ok(snapshot);
  const reviewedDigest = snapshot.hooks[0]?.hookDeclarationDigest;
  assert.ok(reviewedDigest);

  const granted = await grantWorkspaceHookTrust({
    workspacePath: fixture.workspace,
    workspaceIdentity: fixture.workspace,
    userConfigPath: fixture.userConfigPath,
    allCurrent: true,
    bundleDigest: snapshot.bundleDigest,
  });
  assert.equal(granted.items[0]?.trustState, "trusted_persistent");

  // 声明一字不改，只替换入口脚本内容。
  const declarationBefore = await readFile(join(fixture.workspace, ".zcode", "config.json"), "utf8");
  await writeFile(fixture.scriptPath, "echo two\n", "utf8");
  assert.equal(
    await readFile(join(fixture.workspace, ".zcode", "config.json"), "utf8"),
    declarationBefore,
  );

  const afterSwap = await inspectWorkspaceHookTrust({
    workspacePath: fixture.workspace,
    workspaceIdentity: fixture.workspace,
    userConfigPath: fixture.userConfigPath,
  });
  assert.notEqual(afterSwap.items[0]?.hookDeclarationDigest, reviewedDigest);
  assert.equal(afterSwap.items[0]?.trustState, "pending_trust", "脚本变化后旧授权不得继续匹配");

  const port = createWorkspaceHookReviewMutationPort({
    workingDirectory: fixture.workspace,
    workspaceIdentity: fixture.workspace,
    runtimeRoot: config.sources.project.workspaceHookRuntimeRoot!,
  });
  const entry = snapshot.hooks[0];
  assert.ok(entry);
  await assert.rejects(
    port.toggle({ snapshot, reviewItemId: entry.reviewItemId, enabled: false }, () => {}),
    (error: unknown) =>
      error instanceof WorkspaceHookMutationError &&
      error.code === "workspace_hooks_bundle_changed",
  );
});
