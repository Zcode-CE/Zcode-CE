import assert from "node:assert/strict";
import test from "node:test";
import { resolveBashPermissionRulePolicy } from "../src/tool/handlers/bash-command-permission-policy.js";

/**
 * 危险命令在 Bash 授权链路里的行为测试（task-73）。
 *
 * 断言打在**最终消费点**：`resolveBashPermissionRulePolicy` 的
 * `suggestedPermissionUpdates` 与 `optionsPolicy` —— 它们分别决定
 * 「这次批准会记住什么」与「能不能记住」。
 *
 * 运行：cd apps/zcode-cli/packages/core && node --import tsx --test test/dangerousCommandPolicy.test.ts
 */

type Ctx = { dangerousCommandPolicy?: unknown };

function ruleContents(command: string, ctx?: Ctx): string[] {
  const policy = resolveBashPermissionRulePolicy({ command }, ctx as never);
  return (policy?.suggestedPermissionUpdates ?? []).flatMap((update) =>
    update.rules.map((rule) => rule.ruleContent ?? "<no ruleContent>"),
  );
}

function optionsPolicy(command: string, ctx?: Ctx): string | undefined {
  return resolveBashPermissionRulePolicy({ command }, ctx as never)?.optionsPolicy;
}

test("危险命令永不生成 :* 前缀规则（P2 的修复）", () => {
  // sudo apt install foo 原先生成 `sudo apt install:*`（一次批准 = 永久允许装任意包）。
  assert.deepEqual(ruleContents("sudo apt install foo"), ["sudo apt install foo"]);
  assert.deepEqual(ruleContents("sudo rm -rf /tmp/x"), ["sudo rm -rf /tmp/x"]);
  assert.deepEqual(ruleContents("rm -rf /tmp/x"), ["rm -rf /tmp/x"]);
});

test("普通命令的前缀规则行为不变（回归断言）", () => {
  assert.deepEqual(ruleContents("npm install left-pad"), ["npm install:*"]);
  assert.deepEqual(ruleContents("docker run hello-world"), ["docker run:*"]);
  assert.deepEqual(ruleContents("ls -la"), ["ls -la"]);
});

test("默认严格：危险命令不投放持久授权，只保留「仅此一次」+「拒绝」", () => {
  assert.equal(optionsPolicy("sudo apt install foo"), "no-always-allow");
  assert.equal(optionsPolicy("rm -rf /tmp/x"), "no-always-allow");
  assert.equal(optionsPolicy("npm install left-pad"), undefined);
  assert.equal(optionsPolicy("ls -la"), undefined);
});

test("放宽后危险命令可进入持久授权，但仍只生成精确规则", () => {
  const relaxed: Ctx = { dangerousCommandPolicy: { allowPersistentAuthorization: true } };
  assert.equal(optionsPolicy("sudo apt install foo", relaxed), undefined);
  assert.deepEqual(ruleContents("sudo apt install foo", relaxed), ["sudo apt install foo"]);
});

test("关闭提权项即放宽：sudo 命令恢复普通行为", () => {
  const ctx: Ctx = { dangerousCommandPolicy: { disabledEntries: ["sudo"] } };
  assert.equal(optionsPolicy("sudo apt install foo", ctx), undefined);
  // 提权项关掉后 apt 不在默认表里，于是恢复前缀规则 —— 这正是「放宽生效」。
  assert.deepEqual(ruleContents("sudo apt install foo", ctx), ["sudo apt install:*"]);
});

test("关闭可执行名项即放宽：rm 恢复普通行为", () => {
  const ctx: Ctx = { dangerousCommandPolicy: { disabledEntries: ["rm"] } };
  assert.deepEqual(ruleContents("rm -rf /tmp/x", ctx), ["rm -rf /tmp/x"]);
  assert.equal(optionsPolicy("rm -rf /tmp/x", ctx), undefined);
});

test("重新打开后恢复保守化（关闭可逆）", () => {
  const reopened: Ctx = { dangerousCommandPolicy: { disabledEntries: [] } };
  assert.equal(optionsPolicy("rm -rf /tmp/x", reopened), "no-always-allow");
  assert.deepEqual(ruleContents("rm -rf /tmp/x", reopened), ["rm -rf /tmp/x"]);
});

test("用户自加项可加严：kubectl 加入后不再前缀记忆", () => {
  const ctx: Ctx = { dangerousCommandPolicy: { customEntries: [{ pattern: "kubectl" }] } };
  assert.deepEqual(ruleContents("kubectl apply -f x.yaml", ctx), ["kubectl apply -f x.yaml"]);
  assert.equal(optionsPolicy("kubectl apply -f x.yaml", ctx), "no-always-allow");
  assert.deepEqual(ruleContents("docker run hello-world", ctx), ["docker run:*"]);
});

test("用户自加带参数项按前缀加严", () => {
  const ctx: Ctx = { dangerousCommandPolicy: { customEntries: [{ pattern: "docker run" }] } };
  assert.deepEqual(ruleContents("docker run hello-world", ctx), ["docker run hello-world"]);
  assert.deepEqual(ruleContents("docker ps", ctx), ["docker ps"]);
});

test("加严后，此前落盘的授权规则不再放行（裁决 3「评估时撤销」）", () => {
  const strict = resolveBashPermissionRulePolicy({ command: "sudo apt install foo" });
  assert.ok(strict);
  assert.equal(
    strict.evaluateRules("allow", [{ ruleContent: "sudo apt install:*", toolName: "Bash" }]),
    false,
    "前缀规则不得再放行危险命令",
  );
  assert.equal(
    strict.evaluateRules("allow", [{ ruleContent: "sudo apt install foo", toolName: "Bash" }]),
    false,
    "严格态连精确规则也不放行",
  );
  assert.equal(
    strict.evaluateRules("allow", [{ toolName: "Bash" }]),
    false,
    "无 ruleContent 的规则匹配一切，必须被挡住",
  );
});

test("放宽后，精确规则重新生效，前缀规则仍不放行", () => {
  const relaxed = resolveBashPermissionRulePolicy({ command: "sudo apt install foo" }, {
    dangerousCommandPolicy: { allowPersistentAuthorization: true },
  } as never);
  assert.ok(relaxed);
  assert.equal(
    relaxed.evaluateRules("allow", [{ ruleContent: "sudo apt install foo", toolName: "Bash" }]),
    true,
  );
  assert.equal(
    relaxed.evaluateRules("allow", [{ ruleContent: "sudo apt install:*", toolName: "Bash" }]),
    false,
    "放宽也不接受前缀规则",
  );
  assert.equal(
    relaxed.evaluateRules("allow", [{ toolName: "Bash" }]),
    false,
    "放宽也不接受无 ruleContent 的规则",
  );
});

test("deny / ask 规则不受保守化影响（收紧方向不能被削弱）", () => {
  const policy = resolveBashPermissionRulePolicy({ command: "rm -rf /tmp/x" });
  assert.ok(policy);
  assert.equal(policy.evaluateRules("deny", [{ ruleContent: "rm:*", toolName: "Bash" }]), true);
  assert.equal(policy.evaluateRules("ask", [{ ruleContent: "rm:*", toolName: "Bash" }]), true);
});

test("空命令仍然不投放 allow_project（Lead 的 P1 修复不能被本次改动覆盖）", () => {
  assert.deepEqual(ruleContents(""), []);
  assert.deepEqual(ruleContents("   "), []);
});
