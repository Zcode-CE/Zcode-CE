import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import {
  buildWorkspaceHookBundleSnapshot,
  readWorkspaceHookProjectSources,
  readWorkspaceHookScriptStates,
  resolveWorkspaceHookRuntimeRoot,
} from "@zcode/shared/workspace-hook-discovery";
import { createHooksService } from "../src/hooks/hooksService.js";
import { fromProjectSnapshot } from "../src/hooks/workspaceHookSettingsModel.js";

/**
 * Settings 侧（services）对工作区 Hook 入口脚本内容绑定（D24）的接线护栏。
 *
 * 为什么必须钉住：Settings 显示的信任状态是「行内 digest 是否在持久 Trust 记录里」的直接
 * 结果。这里漏传 scriptStates 会让 Settings 摘要退回声明级，而运行时（createConfigAsync）
 * 用绑定脚本的摘要，于是行内状态永远 pending（用户看到「需重新信任」但重信任也没用）；
 * 反之若脚本被替换而摘要不变，用户就看不到任何需要重新信任的信号。
 * 与 bootstrap/test/workspaceHookScriptWiring.test.ts 用同一个 shared builder 作参照，
 * 因此两条入口的一致性由同一份实现保证。
 *
 * 运行：cd packages/services && node --import tsx --test test/workspaceHookScriptWiring.test.ts
 */

const SCRIPT = "hook.sh";

const roots: string[] = [];

after(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

async function makeWorkspace(): Promise<{
  workspace: string;
  scriptPath: string;
  restoreHome: () => void;
}> {
  const root = await mkdtemp(join(tmpdir(), "zcode-hook-settings-"));
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
  // 用户级配置与 Trust store 都从 HOME 解析：钉到临时目录，避免碰真实 ~/.zcode。
  const previousHome = process.env.HOME;
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  process.env.HOME = home;
  return {
    workspace,
    scriptPath,
    restoreHome: () => {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    },
  };
}

test("Settings 快照与 shared 参照装配同摘要，且携带入口脚本状态", async () => {
  const fixture = await makeWorkspace();
  try {
    const service = createHooksService({ logger: silentLogger });
    const result = await service.loadHooks({
      workspacePath: fixture.workspace,
      workspaceIdentity: fixture.workspace,
    });
    const snapshot = result.workspaceHookSnapshot;
    assert.ok(snapshot);
    assert.equal(snapshot.hooks[0]?.scriptEntry?.path, SCRIPT);
    assert.equal(snapshot.hooks[0]?.scriptEntry?.state.kind, "file");

    const { sources } = await readWorkspaceHookProjectSources({
      workingDirectory: fixture.workspace,
    });
    const scriptStates = await readWorkspaceHookScriptStates({
      workspacePath: fixture.workspace,
      sources,
    });
    const reference = buildWorkspaceHookBundleSnapshot({
      workspaceIdentity: fixture.workspace,
      workspacePath: fixture.workspace,
      sources,
      runtimeRoot: resolveWorkspaceHookRuntimeRoot(sources.map((source) => source.hooks)),
      scriptStates,
    });
    assert.ok(reference);
    assert.equal(snapshot.bundleDigest, reference.bundleDigest);
    assert.equal(
      snapshot.hooks[0]?.hookDeclarationDigest,
      reference.hooks[0]?.hookDeclarationDigest,
    );
  } finally {
    fixture.restoreHome();
  }
});

test("脚本被替换后 Settings 行状态从已信任变为需重新信任", async () => {
  const fixture = await makeWorkspace();
  try {
    const service = createHooksService({ logger: silentLogger });
    const load = () =>
      service.loadHooks({
        workspacePath: fixture.workspace,
        workspaceIdentity: fixture.workspace,
      });
    const { sources } = await readWorkspaceHookProjectSources({
      workingDirectory: fixture.workspace,
    });

    const before = await load();
    const beforeSnapshot = before.workspaceHookSnapshot;
    assert.ok(beforeSnapshot);
    const beforeDigest = beforeSnapshot.hooks[0]?.hookDeclarationDigest;
    assert.ok(beforeDigest);
    const rowsBefore = fromProjectSnapshot({
      sources,
      snapshot: beforeSnapshot,
      workspaceIdentity: fixture.workspace,
      workspacePath: fixture.workspace,
      persistentTrustedDigests: new Set([beforeDigest]),
    });
    assert.equal(rowsBefore[0]?.workspaceHook?.trustState, "trusted_persistent");

    await writeFile(fixture.scriptPath, "echo two\n", "utf8");

    const after = await load();
    const afterSnapshot = after.workspaceHookSnapshot;
    assert.ok(afterSnapshot);
    assert.notEqual(
      afterSnapshot.hooks[0]?.hookDeclarationDigest,
      beforeDigest,
      "脚本变化必须改变 Settings 侧摘要",
    );
    const rowsAfter = fromProjectSnapshot({
      sources,
      snapshot: afterSnapshot,
      workspaceIdentity: fixture.workspace,
      workspacePath: fixture.workspace,
      persistentTrustedDigests: new Set([beforeDigest]),
    });
    assert.equal(rowsAfter[0]?.workspaceHook?.trustState, "pending_trust");
  } finally {
    fixture.restoreHome();
  }
});
