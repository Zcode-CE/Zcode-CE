import assert from "node:assert/strict";
import test from "node:test";
import { approvalPermissionScopes } from "../src/app-approval.js";

/**
 * TUI 批准范围可视化测试（task-73）。
 *
 * 与 GUI 的 `readPermissionRuleScopes` 同构：三种形态都必须展示，
 * 缺一种就是静默放大授权（安全审计 task-72 的 P1）。
 * 原实现 `if (!content) continue;` 把无 ruleContent 的规则（匹配一切）静默剔除。
 *
 * 运行：cd apps/zcode-cli/packages/tui && node --import tsx --test test/approvalPermissionScopes.test.ts
 */

const request = (rules: Array<{ toolName: string; ruleContent?: string }>) =>
  ({
    input: {},
    reason: "r",
    requestId: "p1",
    riskLevel: "high",
    sessionId: "s1",
    suggestedPermissionUpdates: [{ behavior: "allow", rules, type: "addRules" }],
    toolCallId: "t1",
    toolName: "Bash",
  }) as never;

test("无 ruleContent 的规则被显式暴露为 any（不再被静默丢弃）", () => {
  const scopes = approvalPermissionScopes(request([{ toolName: "Bash" }]));
  assert.deepEqual(scopes, [{ kind: "any", text: "Bash" }]);
});

test("无 ruleContent 对任何工具都暴露（不是 Bash 专属）", () => {
  const scopes = approvalPermissionScopes(request([{ toolName: "Agent" }]));
  assert.deepEqual(scopes, [{ kind: "any", text: "Agent" }]);
});

test("前缀规则仍按前缀展示（行为不变）", () => {
  const scopes = approvalPermissionScopes(
    request([{ ruleContent: "npm install:*", toolName: "Bash" }]),
  );
  assert.deepEqual(scopes, [{ kind: "prefix", text: "npm install …" }]);
});

test("精确规则展示原样", () => {
  const scopes = approvalPermissionScopes(
    request([{ ruleContent: "rm -rf /tmp/x", toolName: "Bash" }]),
  );
  assert.deepEqual(scopes, [{ kind: "exact", text: "rm -rf /tmp/x" }]);
});

test("非 Bash 的带内容规则不展示（避免噪声，行为不变）", () => {
  assert.deepEqual(
    approvalPermissionScopes(request([{ ruleContent: "/tmp/x", toolName: "Write" }])),
    [],
  );
});

test("最多展示 5 条", () => {
  const scopes = approvalPermissionScopes(
    request(
      Array.from({ length: 8 }, (_, index) => ({
        ruleContent: `cmd${index}:*`,
        toolName: "Bash",
      })),
    ),
  );
  assert.equal(scopes.length, 5);
});
