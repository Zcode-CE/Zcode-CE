/**
 * 项目 Hook 入口脚本内容绑定（D24 / ZP-20261110-06）的准入闸门。
 *
 * 修复前 Trust 只在 discovery 时绑定声明字段，会话中替换或删除已信任的脚本仍会启动进程。
 * 这里守住三件事：准入（脚本不可用不得授权）、派发（不可用/内容变化不得执行）、
 * 以及「旧 unbound 摘要不得被当成本次授权」——否则「声明不变、只换脚本」仍能命中旧摘要。
 *
 * 运行：cd apps/zcode-cli/packages/core && \
 *   mise exec node@24.14.0 -- node --import tsx --test test/workspaceHookScriptAdmission.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  HookEventName,
  SessionEventType,
  createWorkspaceHookBundleSnapshot,
  type ExecutionPort,
  type HookInput,
  type HookRunLifecyclePayload,
  type SessionEvent,
  type WorkspaceHookBundleSnapshot,
} from "@zcode/contracts";
import type { WorkspaceHookScriptState } from "@zcode/shared/workspace-hook-discovery";
import {
  WorkspaceHookTrustCoordinator,
  createConfiguredHookRunner,
  createInMemoryHookRunner,
  createWorkspaceHookRuntimeAdmission,
  createWorkspaceHookTrustRecords,
} from "../src/hooks/index.js";

const WORKSPACE = "/workspace";
const BUNDLE = "c".repeat(64);
const DIGEST = "a".repeat(64);
const UNBOUND_DIGEST = "b".repeat(64);
const TRUSTED_SHA = "1".repeat(64);
const CHANGED_SHA = "2".repeat(64);

function snapshot(
  state: WorkspaceHookScriptState | undefined,
  digest: string = DIGEST,
): WorkspaceHookBundleSnapshot {
  return createWorkspaceHookBundleSnapshot({
    schemaVersion: 1,
    workspaceIdentity: WORKSPACE,
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
        command: "bash .zcode/hook.sh",
        resolvedTimeoutMs: 60_000,
        resolvedMaxOutputBytes: 32_768,
        ...(state ? { scriptEntry: { path: ".zcode/hook.sh", state } } : {}),
        sourceRootEnabled: true,
        declarationEnabled: true,
        runtimeHooksEnabled: true,
        configuredEnabled: true,
        editable: true,
        declarationDigestAlgorithm: "sha256",
        hookDeclarationDigest: digest,
      },
    ],
    digestAlgorithm: "sha256",
    bundleDigest: BUNDLE,
  });
}

function coordinatorFor(hookSnapshot: WorkspaceHookBundleSnapshot) {
  const coordinator = new WorkspaceHookTrustCoordinator({ coordinatorEpoch: "epoch-script" });
  coordinator.replacePersistentTrustRecords(
    createWorkspaceHookTrustRecords({
      snapshot: hookSnapshot,
      reviewItemIds: ["item-0"],
      grantedAt: "2026-11-25T00:00:00.000Z",
    }),
    { status: "ok" },
  );
  return coordinator;
}

function executionPort(commands: string[]): ExecutionPort {
  return {
    async run(request) {
      commands.push(request.command.mode === "shell" ? request.command.command : request.command.file);
      const now = new Date();
      return {
        status: "completed",
        exitCode: 0,
        stdout: { text: "", bytes: 0, truncated: false },
        stderr: { text: "", bytes: 0, truncated: false },
        durationMs: 1,
        timedOut: false,
        cancelled: false,
        startedAt: now,
        completedAt: now,
      };
    },
  };
}

function sessionStartInput(cwd = WORKSPACE): HookInput {
  return {
    cwd,
    hookEventName: HookEventName.SessionStart,
    mode: "build",
    sessionId: "session-1" as never,
    source: "startup",
    timestamp: "2026-11-25T00:00:00.000Z",
    traceId: "trace-1" as never,
  };
}

async function runOnce(input: {
  recorded: WorkspaceHookScriptState | undefined;
  current?: WorkspaceHookScriptState | (() => Promise<WorkspaceHookScriptState>);
  inject?: boolean;
  trusted?: boolean;
  digest?: string;
  beforeResolve?: (coordinator: WorkspaceHookTrustCoordinator) => void;
}) {
  const hookSnapshot = snapshot(input.recorded, input.digest);
  const coordinator = coordinatorFor(hookSnapshot);
  if (input.trusted === false) coordinator.replacePersistentTrustRecords([], { status: "missing" });
  const reads: Array<{ cwd: string; path: string }> = [];
  const admission = createWorkspaceHookRuntimeAdmission({
    coordinator,
    ready: Promise.resolve(),
    snapshot: hookSnapshot,
    ...(input.inject === false
      ? {}
      : {
          readScriptState: async (cwd: string, path: string) => {
            reads.push({ cwd, path });
            input.beforeResolve?.(coordinator);
            return typeof input.current === "function" ? input.current() : input.current!;
          },
        }),
  });
  const events: SessionEvent[] = [];
  const commands: string[] = [];
  const runner = createConfiguredHookRunner({
    config: { enabled: true, events: {}, maxOutputBytes: 32_768, timeoutMs: 60_000 },
    emitEvent: async (event) => {
      events.push(event);
    },
    executionPort: executionPort(commands),
    getWorkingDirectory: () => WORKSPACE,
    workspaceHookAdmission: admission,
    workspaceHookSnapshot: hookSnapshot,
  });
  if (!runner) throw new Error("expected configured runner");
  await admission.activate("startup");
  await runner.run(sessionStartInput("/workspace/sub"), { matchValue: "startup" });
  const payload = events[0]?.payload as HookRunLifecyclePayload | undefined;
  return { admission, commands, events, payload, reads, coordinator, hookSnapshot };
}

test("记录为普通文件且内容未变：按实际 cwd 复核后正常执行", async () => {
  const result = await runOnce({ recorded: { kind: "file", sha256: TRUSTED_SHA }, current: { kind: "file", sha256: TRUSTED_SHA } });
  assert.deepEqual(result.commands, ["bash .zcode/hook.sh"]);
  assert.deepEqual(result.reads, [{ cwd: "/workspace/sub", path: ".zcode/hook.sh" }]);
  assert.equal(result.events[0]?.type, SessionEventType.HookRunStarted);
});

test("记录即不可用（missing）：不执行且以 script_unavailable 上报", async () => {
  const result = await runOnce({ recorded: { kind: "missing" }, current: { kind: "file", sha256: TRUSTED_SHA } });
  assert.deepEqual(result.commands, []);
  assert.equal(result.events[0]?.type, SessionEventType.HookRunBlocked);
  assert.equal(result.payload?.errorCode, "workspace_hook_script_unavailable");
  // 记录不可用时连读取都不做：没有可复核的内容。
  assert.deepEqual(result.reads, []);
});

test("会话中脚本被删除：不执行且以 script_unavailable 上报", async () => {
  const result = await runOnce({ recorded: { kind: "file", sha256: TRUSTED_SHA }, current: { kind: "missing" } });
  assert.deepEqual(result.commands, []);
  assert.equal(result.payload?.errorCode, "workspace_hook_script_unavailable");
});

test("会话中脚本变为不可读：不执行且以 script_unavailable 上报", async () => {
  const result = await runOnce({ recorded: { kind: "file", sha256: TRUSTED_SHA }, current: { kind: "unverifiable" } });
  assert.deepEqual(result.commands, []);
  assert.equal(result.payload?.errorCode, "workspace_hook_script_unavailable");
});

test("内容变化后未重新信任：不执行并提示重新信任（declaration_changed）", async () => {
  const result = await runOnce({ recorded: { kind: "file", sha256: TRUSTED_SHA }, current: { kind: "file", sha256: CHANGED_SHA } });
  assert.deepEqual(result.commands, []);
  assert.equal(result.payload?.errorCode, "workspace_hook_declaration_changed");
});

test("未注入脚本读取端口：有入口的声明一律 fail closed", async () => {
  const result = await runOnce({ recorded: { kind: "file", sha256: TRUSTED_SHA }, inject: false });
  assert.deepEqual(result.commands, []);
  assert.equal(result.payload?.errorCode, "workspace_hook_script_unavailable");
});

test("没有入口脚本的声明不受影响：仍按原授权执行", async () => {
  const result = await runOnce({ recorded: undefined });
  assert.deepEqual(result.commands, ["bash .zcode/hook.sh"]);
  assert.equal(result.events[0]?.type, SessionEventType.HookRunStarted);
});

test("准入：入口脚本不可用 ⇒ blocked_untrusted + script_unavailable，且不可运行", () => {
  const hookSnapshot = snapshot({ kind: "missing" });
  const coordinator = coordinatorFor(hookSnapshot);
  const evaluation = coordinator.evaluateSnapshot({ snapshot: hookSnapshot });
  const item = evaluation.items[0];
  assert.equal(item?.trustState, "blocked_untrusted");
  assert.equal(item?.reasonCode, "workspace_hook_script_unavailable");
  assert.equal(item?.effectiveRunnable, false);
  assert.equal(item?.admissionClass, "blocked");
});

test("准入：记录为普通文件且已信任 ⇒ 可运行", () => {
  const hookSnapshot = snapshot({ kind: "file", sha256: TRUSTED_SHA });
  const coordinator = coordinatorFor(hookSnapshot);
  const evaluation = coordinator.evaluateSnapshot({ snapshot: hookSnapshot });
  assert.equal(evaluation.items[0]?.trustState, "trusted_persistent");
  assert.equal(evaluation.items[0]?.effectiveRunnable, true);
});

test("旧 unbound 摘要不得被当成本次授权（不加爷爷条款）", async () => {
  // 旧记录来自不含 scriptEntry 的声明摘要：只换脚本、声明不变时它仍会命中旧摘要。
  const unbound = snapshot(undefined, UNBOUND_DIGEST);
  const bound = snapshot({ kind: "file", sha256: TRUSTED_SHA }, DIGEST);
  assert.notEqual(unbound.hooks[0]?.hookDeclarationDigest, bound.hooks[0]?.hookDeclarationDigest);
  const coordinator = coordinatorFor(unbound);
  const evaluation = coordinator.evaluateSnapshot({ snapshot: bound });
  assert.equal(evaluation.items[0]?.effectiveRunnable, false);
  assert.notEqual(evaluation.items[0]?.trustState, "trusted_persistent");
  const admission = createWorkspaceHookRuntimeAdmission({
    coordinator,
    ready: Promise.resolve(),
    readScriptState: async () => ({ kind: "file", sha256: TRUSTED_SHA }),
    snapshot: bound,
  });
  await admission.activate("startup");
  const decision = admission.evaluateDispatch({ hookDeclarationDigest: DIGEST, reviewItemId: "item-0" });
  assert.equal(decision.allowed, false);
});

test("派发前复核失败后再次复核授权：复核期间被 revoke 仍不得执行", async () => {
  const result = await runOnce({
    recorded: { kind: "file", sha256: TRUSTED_SHA },
    current: { kind: "file", sha256: TRUSTED_SHA },
    beforeResolve: (coordinator) => {
      coordinator.replacePersistentTrustRecords([], { status: "missing" });
    },
  });
  assert.deepEqual(result.commands, []);
  assert.equal(result.events[0]?.type, SessionEventType.HookRunBlocked);
});

test("派发前复核超时：不执行且以 script_unavailable 上报", async () => {
  const calls: string[] = [];
  const events: SessionEvent[] = [];
  const runner = createInMemoryHookRunner({
    defaultTimeoutMs: 40,
    emitEvent: async (event) => {
      events.push(event);
    },
    hooks: [
      {
        event: HookEventName.SessionStart,
        timeoutMs: 40,
        verifyBeforeDispatch: () => new Promise(() => undefined),
        callback: () => {
          calls.push("callback");
        },
      },
    ],
  });
  await runner.run(sessionStartInput());
  assert.deepEqual(calls, []);
  const payload = events[0]?.payload as HookRunLifecyclePayload | undefined;
  assert.equal(events[0]?.type, SessionEventType.HookRunBlocked);
  assert.equal(payload?.errorCode, "workspace_hook_script_unavailable");
});

test("父信号已中止：复核不再读取脚本，也不执行", async () => {
  const calls: string[] = [];
  let reads = 0;
  const runner = createInMemoryHookRunner({
    defaultTimeoutMs: 60_000,
    hooks: [
      {
        event: HookEventName.SessionStart,
        verifyBeforeDispatch: async () => {
          reads += 1;
          return { allowed: true };
        },
        callback: () => {
          calls.push("callback");
        },
      },
    ],
  });
  const controller = new AbortController();
  controller.abort();
  await runner.run(sessionStartInput(), { signal: controller.signal });
  assert.equal(reads, 0);
  assert.deepEqual(calls, []);
});
