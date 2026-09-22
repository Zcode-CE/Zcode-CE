import assert from "node:assert/strict";
import test from "node:test";
import { resolveBashPermissionRulePolicy } from "../src/tool/handlers/bash-command-permission-policy.js";

/**
 * 「关闭可逆、删除不可逆」的逐步实测（Lead 的追加验收要求）。
 *
 * 每一步都断言**行为**（规则内容 / optionsPolicy），不是断言数据结构 ——
 * 「代码看起来对」不算证据。
 *
 * 运行：cd apps/zcode-cli/packages/core && node --import tsx --test test/dangerousCommandReversibility.test.ts
 */

type Ctx = { dangerousCommandPolicy?: unknown };

const rules = (command: string, ctx?: Ctx): string[] =>
  (
    resolveBashPermissionRulePolicy({ command }, ctx as never)?.suggestedPermissionUpdates ?? []
  ).flatMap((update) => update.rules.map((rule) => rule.ruleContent ?? "<no ruleContent>"));

const policy = (command: string, ctx?: Ctx): string | undefined =>
  resolveBashPermissionRulePolicy({ command }, ctx as never)?.optionsPolicy;

test("默认项：关闭 → 重新打开 → 行为恢复（四步实测）", () => {
  const cmd = "apt install foo";
  // 第 1 步：默认（严格 + 默认项全开）—— apt 不在表里，走前缀规则。
  assert.deepEqual(rules(cmd), ["apt install:*"], "第1步：默认态 apt 走前缀规则");

  // 第 2 步：用户把 apt 加进清单（加严）。
  const tightened: Ctx = { dangerousCommandPolicy: { customEntries: [{ pattern: "apt" }] } };
  assert.deepEqual(rules(cmd, tightened), ["apt install foo"], "第2步：加严后只精确匹配");
  assert.equal(policy(cmd, tightened), "no-always-allow", "第2步：且不可持久授权");

  // 第 3 步：关闭该项（放宽）。
  const disabled: Ctx = {
    dangerousCommandPolicy: { customEntries: [{ enabled: false, pattern: "apt" }] },
  };
  assert.deepEqual(rules(cmd, disabled), ["apt install:*"], "第3步：关闭后恢复前缀规则");
  assert.equal(policy(cmd, disabled), undefined, "第3步：且恢复可持久授权");

  // 第 4 步：重新打开（关闭可逆）。
  const reenabled: Ctx = { dangerousCommandPolicy: { customEntries: [{ pattern: "apt" }] } };
  assert.deepEqual(rules(cmd, reenabled), ["apt install foo"], "第4步：重新打开后恢复加严");
  assert.equal(policy(cmd, reenabled), "no-always-allow");
});

test("默认提权项关闭与重新打开：可逆", () => {
  const cmd = "sudo apt install foo";
  assert.equal(policy(cmd), "no-always-allow", "默认：提权命令不可持久授权");

  const off: Ctx = { dangerousCommandPolicy: { disabledEntries: ["sudo"] } };
  assert.equal(policy(cmd, off), undefined, "关闭提权项后：恢复可持久授权");
  assert.deepEqual(rules(cmd, off), ["sudo apt install:*"], "关闭提权项后：恢复前缀规则");

  const on: Ctx = { dangerousCommandPolicy: { disabledEntries: [] } };
  assert.equal(policy(cmd, on), "no-always-allow", "重新打开：恢复保守化");
  assert.deepEqual(rules(cmd, on), ["sudo apt install foo"]);
});

test("默认项无可删除语义：从 disabledEntries 移除即重新打开", () => {
  const cmd = "rm -rf /tmp/x";
  const off: Ctx = { dangerousCommandPolicy: { disabledEntries: ["rm"] } };
  assert.equal(policy(cmd, off), undefined);
  // 默认项在清单里永远存在，只能被关闭；移除即恢复。
  const reopened: Ctx = { dangerousCommandPolicy: { disabledEntries: [] } };
  assert.equal(policy(cmd, reopened), "no-always-allow");
});

test("用户自加项：关闭 → 重新打开 → 删除（四步实测）", () => {
  const cmd = "kubectl apply -f x.yaml";
  // 加进来：加严生效。
  const added: Ctx = { dangerousCommandPolicy: { customEntries: [{ pattern: "kubectl" }] } };
  assert.deepEqual(rules(cmd, added), ["kubectl apply -f x.yaml"], "加入后只精确匹配");

  // 关闭：放宽，但项仍在列表里（可重新打开）。
  const disabled: Ctx = {
    dangerousCommandPolicy: { customEntries: [{ enabled: false, pattern: "kubectl" }] },
  };
  assert.deepEqual(rules(cmd, disabled), ["kubectl apply:*"], "关闭后恢复前缀规则");

  // 重新打开：恢复加严。
  const reenabled: Ctx = { dangerousCommandPolicy: { customEntries: [{ pattern: "kubectl" }] } };
  assert.deepEqual(rules(cmd, reenabled), ["kubectl apply -f x.yaml"], "重新打开后恢复加严");

  // 删除：项从列表消失，行为回到「从未加过」。
  const deleted: Ctx = { dangerousCommandPolicy: { customEntries: [] } };
  assert.deepEqual(rules(cmd, deleted), ["kubectl apply:*"], "删除后完全回到默认行为");
});
