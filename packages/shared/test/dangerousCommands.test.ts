import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_DANGEROUS_EXECUTABLES,
  PRIVILEGE_WRAPPERS,
  isDangerousCommandAllowRuleEffective,
  isDangerousCommandSubject,
  normalizeDangerousPattern,
  resolveDangerousCommandPolicy,
} from "../src/dangerousCommands.js";

/**
 * 危险命令清单的判据测试（task-73）。
 *
 * 这份清单是 UI 与 core 共用的唯一真相源，所以断言直接打在 shared 的纯函数上 ——
 * core 侧只是把 Bash invocation 归一成 subject 再调这里。
 *
 * 关键回归：**提权 wrapper 必须参与判定**。原 core 的 HIGH_RISK_ROOT_COMMANDS 只查
 * 内层可执行名，所以 `sudo` 永不触发保守化（安全审计 task-67 §7.5「债 1」），
 * `sudo apt install foo` 会生成 `sudo apt install:*`。
 *
 * 运行：cd packages/shared && node --import tsx --test test/dangerousCommands.test.ts
 */

const subject = (executableName: string, wrapperNames: string[] = [], prefix?: string) => ({
  executableName,
  wrapperNames,
  ...(prefix ? { prefix } : {}),
});

test("默认清单与 core 原 HIGH_RISK_ROOT_COMMANDS 逐字一致（16 条，不是 19 条）", () => {
  // task-67 §7.5 与 task-73 描述都写 19 条；task-72 实测 16 条，此处锁死实测值，
  // 避免「被列举、被计数的值静默漂移」（AGENTS.md）。
  assert.equal(DEFAULT_DANGEROUS_EXECUTABLES.length, 16);
  assert.deepEqual([...DEFAULT_DANGEROUS_EXECUTABLES].sort(), [
    "bash",
    "chgrp",
    "chmod",
    "chown",
    "cmd",
    "dd",
    "fish",
    "mkfs",
    "mount",
    "powershell",
    "pwsh",
    "rm",
    "rmdir",
    "sh",
    "umount",
    "zsh",
  ]);
});

test("缺省即严格：policy 缺席时不允许持久授权，且默认项全部生效", () => {
  const resolved = resolveDangerousCommandPolicy(undefined);
  assert.equal(resolved.allowPersistentAuthorization, false);
  assert.equal(resolved.disabledDefaultEntries.length, 0);
  assert.equal(resolved.enabledDefaultEntries.length, 16 + PRIVILEGE_WRAPPERS.length);
});

test("提权 wrapper 参与判定 —— 这是 task-67「债 1」的修复点", () => {
  const resolved = resolveDangerousCommandPolicy(undefined);
  // sudo 不在可执行名表里（它是 wrapper），必须靠 wrapper 链命中。
  assert.equal(resolved.executableNames.has("sudo"), false);
  assert.equal(isDangerousCommandSubject(resolved, subject("apt", ["sudo"])), true);
  assert.equal(isDangerousCommandSubject(resolved, subject("apt", ["time", "sudo"])), true);
  // 无 wrapper 的同一命令不是危险命令（apt 不在默认表里）。
  assert.equal(isDangerousCommandSubject(resolved, subject("apt")), false);
});

test("doas / pkexec 同样是提权项（原实现只覆盖 sudo）", () => {
  const resolved = resolveDangerousCommandPolicy(undefined);
  assert.equal(isDangerousCommandSubject(resolved, subject("apt", ["doas"])), true);
  assert.equal(isDangerousCommandSubject(resolved, subject("apt", ["pkexec"])), true);
});

test("关闭提权项后，提权不再触发保守化（放宽生效）", () => {
  const resolved = resolveDangerousCommandPolicy({ disabledEntries: ["sudo"] });
  assert.equal(isDangerousCommandSubject(resolved, subject("apt", ["sudo"])), false);
  assert.equal(resolved.disabledDefaultEntries.includes("sudo"), true);
  // 其他提权项不受影响。
  assert.equal(isDangerousCommandSubject(resolved, subject("apt", ["doas"])), true);
});

test("关闭可逆：重新打开后恢复保守化", () => {
  const off = resolveDangerousCommandPolicy({ disabledEntries: ["rm"] });
  assert.equal(isDangerousCommandSubject(off, subject("rm")), false);
  const on = resolveDangerousCommandPolicy({ disabledEntries: [] });
  assert.equal(isDangerousCommandSubject(on, subject("rm")), true);
});

test("用户自加项按可执行名匹配", () => {
  const resolved = resolveDangerousCommandPolicy({ customEntries: [{ pattern: "kubectl" }] });
  assert.equal(isDangerousCommandSubject(resolved, subject("kubectl")), true);
  assert.equal(isDangerousCommandSubject(resolved, subject("KUBECTL")), true, "大小写不敏感");
});

test("用户自加项带参数时按前缀匹配（docker run:* 正是实测的放大形态）", () => {
  const resolved = resolveDangerousCommandPolicy({
    customEntries: [{ pattern: "docker run" }],
  });
  assert.equal(resolved.executableNames.has("docker"), false, "带参数项不进可执行名集合");
  assert.deepEqual(resolved.executablePrefixes, ["docker run"]);
  assert.equal(isDangerousCommandSubject(resolved, subject("docker", [], "docker run")), true);
  assert.equal(isDangerousCommandSubject(resolved, subject("docker", [], "docker ps")), false);
});

test("关闭的自加项不生效，但仍保留在列表里（关闭可逆、删除才不可逆）", () => {
  const resolved = resolveDangerousCommandPolicy({
    customEntries: [{ enabled: false, pattern: "kubectl" }],
  });
  assert.equal(isDangerousCommandSubject(resolved, subject("kubectl")), false);
  assert.deepEqual(resolved.customEntries, [{ enabled: false, pattern: "kubectl" }]);
});

test("自加项输入归一化：拒绝含 shell 元字符的输入，而不是静默存下永不匹配的项", () => {
  assert.equal(normalizeDangerousPattern("  DOCKER   Run "), "docker run");
  assert.equal(normalizeDangerousPattern("rm; whoami"), undefined);
  assert.equal(normalizeDangerousPattern("rm | sh"), undefined);
  assert.equal(normalizeDangerousPattern(""), undefined);
  assert.equal(normalizeDangerousPattern("a".repeat(200)), undefined);
});

test("allow 规则有效性：严格态一律不放行，放宽态只认精确规则", () => {
  const strict = resolveDangerousCommandPolicy(undefined);
  // 严格态：连精确规则都不放行 —— 这就是裁决 3 的「评估时撤销」。
  assert.equal(isDangerousCommandAllowRuleEffective(strict, "rm -rf /tmp/x"), false);
  // 无 ruleContent 的规则匹配一切，任何状态下都不得放行危险命令。
  assert.equal(isDangerousCommandAllowRuleEffective(strict, undefined), false);

  const relaxed = resolveDangerousCommandPolicy({ allowPersistentAuthorization: true });
  assert.equal(isDangerousCommandAllowRuleEffective(relaxed, "rm -rf /tmp/x"), true);
  // 前缀 / 通配规则永不用于危险命令：docker run:* 可逃逸到宿主。
  assert.equal(isDangerousCommandAllowRuleEffective(relaxed, "rm:*"), false);
  assert.equal(isDangerousCommandAllowRuleEffective(relaxed, "docker run:*"), false);
  assert.equal(isDangerousCommandAllowRuleEffective(relaxed, "rm *"), false);
  assert.equal(isDangerousCommandAllowRuleEffective(relaxed, undefined), false);
});
