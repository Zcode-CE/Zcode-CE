/**
 * 项目 Hook 入口脚本不可用时不得授权（D24 / ZP-20261110-06）。
 *
 * 三条路径都必须在写 store 之前拒绝：CLI 状态上报、CLI 授权、以及评审 respond。
 * 授权一个读不到的脚本等于把「不可审核」变成「已信任」，派发前复核会一直阻断它。
 *
 * 运行：cd apps/zcode-cli/packages/bootstrap && \
 *   mise exec node@24.14.0 -- node --import tsx --test test/workspaceHookScriptAdmission.test.ts
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  HookEventName,
  SessionEventType,
  createWorkspaceHookBundleSnapshot,
  type WorkspaceHookTrustRecord,
} from "@zcode/contracts";
import {
  WorkspaceHookTrustCoordinator,
  createWorkspaceHookRuntimeAdmission,
} from "@zcode/core";
import { WorkspaceHookReviewController } from "../src/app/workspace-hook-review-controller.js";
import { grantWorkspaceHookTrustForProtocol } from "../src/zcode-protocol/workspace-hook-trust.js";
import { toWorkspaceHookReviewTarget } from "../src/app/workspace-hook-review-request.js";
import type { WorkspaceHookReviewLifecycleEvent } from "../src/app/workspace-hook-review-types.js";
import {
  grantWorkspaceHookTrust,
  inspectWorkspaceHookTrust,
} from "../src/workspace-hook-trust-cli.js";

const SCRIPT_UNAVAILABLE = "workspace_hook_script_unavailable";

async function withWorkspace(
  run: (input: { workspacePath: string; userConfigPath: string; storageRoot: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "zcode-hook-script-admission-"));
  try {
    const workspacePath = join(root, "workspace");
    const storageRoot = join(root, "storage");
    const userConfigPath = join(root, "user", "config.json");
    await mkdir(join(workspacePath, ".zcode"), { recursive: true });
    await mkdir(join(root, "user"), { recursive: true });
    await writeFile(userConfigPath, JSON.stringify({ storage: { dir: storageRoot } }), "utf8");
    await writeFile(
      join(workspacePath, ".zcode", "config.json"),
      JSON.stringify({
        hooks: {
          enabled: true,
          events: {
            SessionStart: [{ hooks: [{ type: "command", command: "bash hook.sh" }] }],
          },
        },
      }),
      "utf8",
    );
    await run({ workspacePath, userConfigPath, storageRoot });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("CLI 状态：入口脚本不存在 ⇒ blocked_untrusted + script_unavailable，且不算待审", async () => {
  await withWorkspace(async ({ workspacePath, userConfigPath }) => {
    const status = await inspectWorkspaceHookTrust({ workspacePath, userConfigPath });
    assert.equal(status.reasonCode, SCRIPT_UNAVAILABLE);
    assert.equal(status.items[0]?.trustState, "blocked_untrusted");
  });
});

test("CLI 授权：入口脚本不存在 ⇒ 整条拒绝并给出 reason，不写 store", async () => {
  await withWorkspace(async ({ workspacePath, userConfigPath }) => {
    const status = await inspectWorkspaceHookTrust({ workspacePath, userConfigPath });
    await assert.rejects(
      grantWorkspaceHookTrust({
        workspacePath,
        userConfigPath,
        allCurrent: true,
        bundleDigest: status.bundleDigest!,
      }),
      (error: unknown) =>
        error instanceof Error &&
        error.message === SCRIPT_UNAVAILABLE &&
        Array.isArray((error as { unavailableItems?: unknown }).unavailableItems),
    );
    // 拒绝必须发生在写盘之前：状态仍是不可用，而不是「已信任但永不运行」。
    const after = await inspectWorkspaceHookTrust({ workspacePath, userConfigPath });
    assert.equal(after.reasonCode, SCRIPT_UNAVAILABLE);
  });
});

test("CLI 授权：脚本补齐后按内容绑定摘要授权成功", async () => {
  await withWorkspace(async ({ workspacePath, userConfigPath }) => {
    await writeFile(join(workspacePath, "hook.sh"), "exit 0", "utf8");
    const before = await inspectWorkspaceHookTrust({ workspacePath, userConfigPath });
    assert.equal(before.reasonCode, "workspace_hooks_pending_trust");
    assert.equal(before.items[0]?.trustState, "pending_trust");
    const granted = await grantWorkspaceHookTrust({
      workspacePath,
      userConfigPath,
      allCurrent: true,
      bundleDigest: before.bundleDigest!,
    });
    assert.equal(granted.reasonCode, "workspace_hooks_trusted_persistent");
    // 内容变化后摘要变化 ⇒ 回到待审，不沿用旧记录（旧 unbound 摘要同样不会命中）。
    await writeFile(join(workspacePath, "hook.sh"), "exit 1", "utf8");
    const changed = await inspectWorkspaceHookTrust({ workspacePath, userConfigPath });
    assert.notEqual(changed.items[0]?.hookDeclarationDigest, before.items[0]?.hookDeclarationDigest);
    assert.equal(changed.items[0]?.trustState, "pending_trust");
  });
});

function snapshotWithUnavailableScript() {
  return createWorkspaceHookBundleSnapshot({
    schemaVersion: 1,
    workspaceIdentity: "/workspace",
    discoveredAt: "2026-11-25T00:00:00.000Z",
    sourceFiles: [
      {
        canonicalPath: "/workspace/.zcode/config.json",
        baseDir: "/workspace",
        discoveryOrder: 0,
        configFileKind: ".zcode/config.json",
        explicitProjectConfig: false,
        editable: true,
        hooksRoot: { enabled: true },
      },
    ],
    hooks: [
      {
        reviewItemId: "item-0",
        event: HookEventName.SessionStart,
        matcherIndex: 0,
        hookIndex: 0,
        sourceFileIndex: 0,
        sourceRelativePath: ".zcode/config.json",
        matcher: null,
        type: "command",
        command: "bash hook.sh",
        resolvedTimeoutMs: 60_000,
        resolvedMaxOutputBytes: 32_768,
        scriptEntry: { path: "hook.sh", state: { kind: "missing" } },
        sourceRootEnabled: true,
        declarationEnabled: true,
        runtimeHooksEnabled: true,
        configuredEnabled: true,
        editable: true,
        declarationDigestAlgorithm: "sha256",
        hookDeclarationDigest: "a".repeat(64),
      },
      {
        reviewItemId: "item-1",
        event: HookEventName.UserPromptSubmit,
        matcherIndex: 0,
        hookIndex: 1,
        sourceFileIndex: 0,
        sourceRelativePath: ".zcode/config.json",
        matcher: null,
        type: "command",
        command: "bash other.sh",
        resolvedTimeoutMs: 60_000,
        resolvedMaxOutputBytes: 32_768,
        sourceRootEnabled: true,
        declarationEnabled: true,
        runtimeHooksEnabled: true,
        configuredEnabled: true,
        editable: true,
        declarationDigestAlgorithm: "sha256",
        hookDeclarationDigest: "d".repeat(64),
      },
    ],
    digestAlgorithm: "sha256",
    bundleDigest: "c".repeat(64),
  });
}

test("评审 respond：选中不可用入口时整体拒绝，不写 store", async () => {
  const snapshot = snapshotWithUnavailableScript();
  const coordinator = new WorkspaceHookTrustCoordinator({ coordinatorEpoch: "epoch-script" });
  coordinator.replacePersistentTrustRecords([], { status: "missing" });
  const admission = createWorkspaceHookRuntimeAdmission({
    coordinator,
    ready: Promise.resolve(),
    snapshot,
    readScriptState: async () => ({ kind: "missing" }),
  });
  await admission.activate("startup");
  const events: WorkspaceHookReviewLifecycleEvent[] = [];
  const grants: Array<readonly WorkspaceHookTrustRecord[]> = [];
  const controller = new WorkspaceHookReviewController({
    admission,
    coordinator,
    host: {
      taskId: "task-1",
      runId: "run-1",
      workspaceLabel: "workspace",
      emit: async (event) => {
        events.push(event);
      },
    },
    mutation: { toggle: async () => snapshot },
    sessionId: "session-1",
    store: Promise.resolve({
      grant: async (records: readonly WorkspaceHookTrustRecord[]) => {
        grants.push(records);
        return { records: [...records] };
      },
      revoke: async () => ({ records: [] }),
    }),
    createId: () => "id-1",
  });
  const requested = await controller.requestReview({
    workspaceIdentity: "/workspace",
    bundleDigest: "c".repeat(64),
  });
  assert.equal(requested.accepted, true);
  const request = events.find(
    (event) => event.type === SessionEventType.WorkspaceHookReviewRequested,
  )?.payload.request;
  assert.ok(request, "expected a review request");
  const response = await controller.respond(toWorkspaceHookReviewTarget(request), {
    action: "trust_selected",
    reviewItemIds: ["item-0", "item-1"],
  });
  assert.deepEqual(response, { accepted: false, reasonCode: SCRIPT_UNAVAILABLE });
  assert.deepEqual(grants, []);
});
test("Settings 预信任协议：入口脚本不可用时回传 script_unavailable 而不是回落码", async () => {
  // 无 session 的授权走 grantWorkspaceHookTrustForProtocol：它按 reason code 枚举收敛错误，
  // 枚举缺该码时会被当成未知异常回落成 workspace_hooks_config_unreadable，用户读到的是配置读取失败。
  await withWorkspace(async ({ workspacePath, userConfigPath }) => {
    const status = await inspectWorkspaceHookTrust({ workspacePath, userConfigPath });
    const result = await grantWorkspaceHookTrustForProtocol(
      {
        workspace: { workspacePath, workspaceKey: workspacePath },
        bundleDigest: status.bundleDigest!,
        hookDeclarationDigest: status.items[0]!.hookDeclarationDigest,
      },
      {
        grant: (input) => grantWorkspaceHookTrust({ ...input, userConfigPath }),
        policyProvider: { getPolicy: () => ({ mode: "user_decides", policyRevision: "rev-1" }) },
      },
    );
    assert.deepEqual(result, { accepted: false, reasonCode: SCRIPT_UNAVAILABLE });
  });
});
