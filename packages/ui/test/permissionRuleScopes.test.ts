import assert from "node:assert/strict";
import test from "node:test";
import { readPermissionRuleScopes } from "../src/lib/permissionRuleScopes.js";

/**
 * 权限弹窗「批准范围可视化」测试（task-73）。
 *
 * 回归的是安全审计 task-72 的 P1 兜底缺口：原实现按 `endsWith(":*")` 过滤，
 * 把**无 ruleContent 的规则**（匹配一切）静默丢弃 —— 用户在没有任何范围提示的情况下
 * 批准了整个工具的任意命令。
 *
 * 运行：cd packages/ui && node --import tsx --test test/permissionRuleScopes.test.ts
 */

const allowUpdate = (rules: Array<{ toolName: string; ruleContent?: string }>) => ({
  behavior: "allow" as const,
  rules,
  type: "addRules" as const,
});

test("无 ruleContent 的规则被显式展示为「任意命令」，不再被静默丢弃", () => {
  const scopes = readPermissionRuleScopes({
    response: { permissionUpdates: [allowUpdate([{ toolName: "Bash" }])] },
  });
  assert.equal(scopes.length, 1);
  assert.equal(scopes[0]?.kind, "any");
  assert.equal(scopes[0]?.toolName, "Bash");
});

test("无 ruleContent 的规则对任何工具都展示（不是 Bash 专属）", () => {
  const scopes = readPermissionRuleScopes({
    response: { permissionUpdates: [allowUpdate([{ toolName: "Agent" }])] },
  });
  assert.equal(scopes.length, 1);
  assert.equal(scopes[0]?.kind, "any");
  assert.equal(scopes[0]?.toolName, "Agent");
});

test("前缀规则仍按前缀展示（行为不变）", () => {
  const scopes = readPermissionRuleScopes({
    response: {
      permissionUpdates: [allowUpdate([{ ruleContent: "npm install:*", toolName: "Bash" }])],
    },
  });
  assert.equal(scopes.length, 1);
  assert.equal(scopes[0]?.kind, "prefix");
  assert.equal(scopes[0]?.display, "npm install …");
});

test("精确规则也展示 —— 用户要看出「记住」的到底是哪一条", () => {
  const scopes = readPermissionRuleScopes({
    response: {
      permissionUpdates: [allowUpdate([{ ruleContent: "rm -rf /tmp/x", toolName: "Bash" }])],
    },
  });
  assert.equal(scopes.length, 1);
  assert.equal(scopes[0]?.kind, "exact");
  assert.equal(scopes[0]?.display, "rm -rf /tmp/x …");
});

test("非 Bash 的带内容规则不展示（避免噪声，行为不变）", () => {
  const scopes = readPermissionRuleScopes({
    response: { permissionUpdates: [allowUpdate([{ ruleContent: "/tmp/x", toolName: "Write" }])] },
  });
  assert.deepEqual(scopes, []);
});

test("deny 更新不参与展示", () => {
  const scopes = readPermissionRuleScopes({
    response: {
      permissionUpdates: [
        { behavior: "deny", rules: [{ ruleContent: "rm:*", toolName: "Bash" }], type: "addRules" },
      ],
    },
  });
  assert.deepEqual(scopes, []);
});

test("没有 permissionUpdates 时返回空数组（不抛异常）", () => {
  assert.deepEqual(readPermissionRuleScopes({ response: undefined }), []);
  assert.deepEqual(readPermissionRuleScopes({}), []);
});

test("最多展示 5 条，避免撑爆弹窗", () => {
  const scopes = readPermissionRuleScopes({
    response: {
      permissionUpdates: [
        allowUpdate(
          Array.from({ length: 8 }, (_, index) => ({
            ruleContent: `cmd${index}:*`,
            toolName: "Bash",
          })),
        ),
      ],
    },
  });
  assert.equal(scopes.length, 5);
});

test("超长规则截断并标记 truncated", () => {
  const long = "a".repeat(400);
  const scopes = readPermissionRuleScopes({
    response: {
      permissionUpdates: [allowUpdate([{ ruleContent: `${long}:*`, toolName: "Bash" }])],
    },
  });
  assert.equal(scopes[0]?.truncated, true);
  assert.ok((scopes[0]?.display.length ?? 0) <= 160);
});
