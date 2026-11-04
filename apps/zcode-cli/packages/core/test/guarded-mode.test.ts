import assert from "node:assert/strict";
import test from "node:test";
import {
  CronAutomationSchema,
  inheritPermissionMode,
  type CollaborationMode,
} from "@zcode/contracts";
import { PermissionService } from "../src/permission/service.js";
import { bashToolEntry } from "../src/tool/handlers/bash.js";

/**
 * F3（170）：guarded 模式的权限语义（A3/A7/A9）。
 *
 * 移植上游 tests/guarded-mode.test.ts 为 node:test：
 * - guarded 是可选模式而非全局门禁：命中危险规则才逐次确认（user-once）；
 * - Plan 优先于 guarded；guarded 保留 workflow alwaysAsk 与会话 allow 的既有行为；
 * - 继承规则只把父 guarded 下的 yolo 子模式收紧为 guarded；
 * - yolo 回归：非命中的危险命令在 guarded 与 yolo 下同为 allow。
 *
 * 运行：cd apps/zcode-cli/packages/core && node --import tsx --test test/guarded-mode.test.ts
 */

const guardedDangerous = {
  toolName: "Bash",
  input: { command: "rm -rf build" },
  mode: "guarded" as const,
  riskLevel: "high" as const,
};

test("A7 独立 Plan 的执行限制优先于 guarded 的危险命令确认", () => {
  const service = new PermissionService();
  const capability = {
    ...bashToolEntry.metadata,
    userApprovalRule: "safety.bash.remove-critical-path",
  };
  assert.deepEqual(
    service.checkPermission({ ...guardedDangerous, planEnabled: true }, capability).decision,
    "deny",
  );
  const asked = service.checkPermission({ ...guardedDangerous, planEnabled: false }, capability);
  assert.deepEqual(asked.decision, "ask");
  assert.deepEqual(asked.approvalMode, "user-once");
});

test("guarded 保留 workflow alwaysAsk 与会话 allow 的既有行为", () => {
  const service = new PermissionService();
  const context = {
    toolName: "CreateWorkflow",
    input: {},
    mode: "guarded" as const,
    riskLevel: "high" as const,
  };
  const capability = { alwaysAsk: true };
  assert.deepEqual(service.checkPermission(context, capability).decision, "ask");
  service.grantSessionPermission([
    { type: "addRules", behavior: "allow", rules: [{ toolName: "CreateWorkflow" }] },
  ]);
  assert.deepEqual(service.checkPermission(context, capability).decision, "allow");
});

test("automation 记录保留显式 guarded/yolo，不迁移缺席值", () => {
  const record = {
    automationId: "guarded-fixture",
    title: "fixture",
    cronExpr: "0 * * * *",
    prompt: "fixture",
    enabled: true,
    lifecycleStatus: "active",
    runCount: 0,
    recurring: true,
  };
  for (const mode of ["guarded", "yolo", undefined] as const) {
    const parsed = CronAutomationSchema.parse({ ...record, ...(mode ? { mode } : {}) });
    assert.equal(parsed.mode, mode);
  }
});

test("继承规则：只有父 guarded 下的 yolo 子模式被收紧", () => {
  const parents: CollaborationMode[] = ["guarded", "yolo", "build", "edit", "plan", "auto"];
  const children: CollaborationMode[] = ["yolo", "build", "edit", "plan", "auto", "guarded"];
  for (const parent of parents) {
    for (const child of children) {
      assert.equal(
        inheritPermissionMode(parent, child),
        parent === "guarded" && child === "yolo" ? "guarded" : child,
        `parent=${parent} child=${child}`,
      );
    }
  }
});

test("A3/A9 guarded 命中才逐次确认；yolo 与非命中命令一律放行（回归）", () => {
  const service = new PermissionService();
  for (const mode of ["guarded", "yolo"] as const) {
    for (const command of ["rm -rf build", "echo hello", "bash -c 'rm -rf build'"]) {
      const input = { command };
      const capability = bashToolEntry.resolvePermissionCapability?.(input, {
        mode,
        bashShellSelection: {
          dialect: "posix",
          source: "auto-detected",
          display: { name: "bash" },
        },
      });
      const decision = service.checkPermission(
        { toolName: "Bash", input, mode, riskLevel: "high" },
        { ...bashToolEntry.metadata, ...capability },
      );
      const shouldAsk = mode === "guarded" && command === "rm -rf build";
      assert.deepEqual(decision.decision, shouldAsk ? "ask" : "allow", `${mode}: ${command}`);
      assert.deepEqual(
        decision.approvalMode,
        shouldAsk ? "user-once" : undefined,
        `${mode}: ${command} approvalMode`,
      );
    }
  }
});

test("selection 缺席时按 POSIX 文法匹配（基础设施状态不能静默退回 YOLO）", () => {
  const input = { command: "rm -rf build" };
  const capability = bashToolEntry.resolvePermissionCapability?.(input, {
    mode: "guarded",
  });
  assert.deepEqual(capability, {
    userApprovalRule: "safety.bash.remove-critical-path",
  });
  const legacy = bashToolEntry.resolvePermissionCapability?.(input, {
    mode: "guarded",
    bashShellSelection: {
      dialect: "legacy-shell",
      source: "legacy-fallback",
      display: { name: "system shell" },
    },
  });
  assert.equal(legacy, undefined);
});

// X19（3.17.2 移植）：Plan 闸门只在原模式之上收紧，不能比原模式更宽。
// 上游修复前的三条越权路径：① 需审批的只读工具被 Plan 直接 allow（任意 URL 的 WebFetch、
// readOnlyHint MCP）；② 非 destructive MCP 一律 allow（MCP 写工具、node_repl 的 js）；
// ③ guarded 的单次确认带 !planEnabled，开 Plan 时被整个跳过，闸门放过后又补回 guarded 放行。
test("X19 Plan 下需审批的只读工具交回原模式判定，不再被 Plan 直接放行", () => {
  const service = new PermissionService();
  const decision = service.checkPermission(
    {
      toolName: "WebFetch",
      input: { url: "https://example.com" },
      mode: "build",
      planEnabled: true,
      riskLevel: "medium",
    },
    {
      readOnly: true,
      destructive: false,
      needsApproval: true,
      sideEffectScope: "network",
      riskLevel: "medium",
    },
  );
  assert.equal(decision.decision, "ask");
  assert.equal(decision.ruleId, "mode.build.sideEffect");
});

test("X19 Plan 下非 destructive MCP：yolo/guarded 放行，build 改为不提供始终允许的询问", () => {
  const service = new PermissionService();
  const capability = {
    permission: {
      permission: "mcp",
      reason: "",
      riskLevel: "medium" as const,
      sideEffectScope: "workspace" as const,
      needsApproval: true,
      patternSources: [],
      denyPriority: "beforeAsk" as const,
    },
  };
  const context = {
    toolName: "mcp__fixture__write",
    input: {},
    riskLevel: "medium" as const,
  };
  const buildPlan = service.checkPermission(
    { ...context, mode: "build", planEnabled: true },
    capability,
  );
  assert.equal(buildPlan.decision, "ask");
  assert.equal(buildPlan.ruleId, "mode.plan.mcp");
  // Plan 下记住的 allow 规则不会生效，所以这次询问不提供「始终允许」。
  assert.equal(buildPlan.optionsPolicy, "no-always-allow");
  // 原模式本就放行的 yolo 不被 Plan 收窄，闸门放过后退回 yolo 基础策略。
  for (const mode of ["yolo", "guarded"] as const) {
    const decision = service.checkPermission(
      { ...context, mode, planEnabled: true },
      capability,
    );
    assert.equal(decision.decision, "allow", mode);
    assert.equal(decision.ruleId, "mode.yolo", mode);
  }
});

test("X19 guarded + Plan 下通过闸门的危险命令仍要单次确认", () => {
  const service = new PermissionService();
  const decision = service.checkPermission(
    {
      toolName: "Bash",
      input: { command: "rm -rf build" },
      mode: "guarded",
      planEnabled: true,
      riskLevel: "high",
    },
    {
      userApprovalRule: "safety.bash.remove-critical-path",
      readOnly: true,
      destructive: false,
      needsApproval: false,
    },
  );
  assert.equal(decision.decision, "ask");
  assert.equal(decision.ruleId, "safety.bash.remove-critical-path");
  assert.equal(decision.approvalMode, "user-once");
});

