/**
 * Bash 权限的文法收窄：CMD / legacy-shell 不认「解析出来的」授权与只读结论。
 *
 * 移植上游 v3.18.2 `tests/bash-command-permission-policy.test.ts` 的 cmd/legacy-shell 用例，
 * 并补上上游 bash.ts 的同一条收窄（只读能力）。为什么必须收窄：这两条结论都建立在 Bash AST
 * 上，而 `#` 在 CMD 里不是注释 —— `npm run test # & python script.py` 会被解析成只读的
 * `npm run test`，前缀规则与 readOnly 因此都会给出免审批放行。
 *
 * 收窄只作用于 allow / 只读：deny、ask 规则继续按完整规则集命中，既有拦截不能被削掉。
 *
 * 运行：cd apps/zcode-cli/packages/core && \
 *   mise exec node@24.14.0 -- node --import tsx --test test/bashPermissionDialect.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionShellSelection } from "@zcode/contracts";
import { resolveRuntimePermissionContext } from "../src/tool/executor/permission-capability.js";
import type { ToolExecutorDeps } from "../src/tool/executor/types.js";
import { resolveBashPermissionRulePolicy } from "../src/tool/handlers/bash-command-permission-policy.js";
import { bashToolEntry } from "../src/tool/handlers/bash.js";
import type { ToolPermissionRulePolicy } from "../src/tool/types.js";

const POSIX_SHELL: ExecutionShellSelection = {
  dialect: "posix",
  source: "auto-detected",
  display: { name: "bash" },
};

/** 文法与 Bash 不同的两种选择：CMD，以及解析不出文法的 legacy fallback。 */
const HETEROGENEOUS_SHELLS: ReadonlyArray<[string, ExecutionShellSelection]> = [
  ["cmd", { dialect: "cmd", source: "auto-detected", display: { name: "CMD" } }],
  [
    "legacy-shell",
    { dialect: "legacy-shell", source: "legacy-fallback", display: { name: "system shell" } },
  ],
];

function policyFor(command: string, selection?: ExecutionShellSelection): ToolPermissionRulePolicy {
  const policy = resolveBashPermissionRulePolicy(
    { command },
    selection ? { bashShellSelection: selection } : {},
  );
  assert.ok(policy, "a string command must always produce a rule policy");
  return policy;
}

function ruleContents(command: string, selection?: ExecutionShellSelection): Array<string | undefined> {
  return policyFor(command, selection).suggestedPermissionUpdates.flatMap((update) =>
    update.rules.map((rule) => rule.ruleContent),
  );
}

for (const [name, selection] of HETEROGENEOUS_SHELLS) {
  test(`${name}：只建议、也只接受完整命令授权`, () => {
    // `#` 在 CMD 里不是注释：Bash AST 只解析出 `npm run test`，而 shell 会接着执行 `python script.py`。
    const command = "npm run test # & python script.py";
    const policy = policyFor(command, selection);
    assert.deepEqual(ruleContents(command, selection), [command], "该文法只能建议精确规则");
    for (const ruleContent of ["npm run:*", "npm *", "npm run test"]) {
      assert.equal(
        policy.evaluateRules("allow", [{ toolName: "Bash", ruleContent }]),
        false,
        `${name} 的 allow 不得命中 ${ruleContent}`,
      );
    }
    assert.equal(policy.evaluateRules("allow", [{ toolName: "Bash", ruleContent: command }]), true);
    assert.equal(policy.evaluateRules("allow", [{ toolName: "Bash" }]), true);
    // 只收紧 allow：deny / ask 仍用完整规则集命中。
    for (const behavior of ["deny", "ask"] as const) {
      assert.equal(
        policy.evaluateRules(behavior, [{ toolName: "Bash", ruleContent: "npm run:*" }]),
        true,
        `${name} 的 ${behavior} 不能被文法收窄影响`,
      );
      assert.equal(
        policy.evaluateRules(behavior, [{ toolName: "Bash", ruleContent: command }]),
        true,
        `${name} 的 ${behavior} 仍认精确规则`,
      );
    }
  });
}

test("POSIX 与 selection 缺席时保持前缀建议（收窄面不外溢）", () => {
  assert.deepEqual(ruleContents("pnpm run lint --fix", POSIX_SHELL), ["pnpm run lint:*"]);
  assert.deepEqual(ruleContents("pnpm run lint --fix"), ["pnpm run lint:*"]);
});

test("异构 shell 不认只读结论（readOnly 会直接换成免审批放行）", () => {
  for (const [name, selection] of HETEROGENEOUS_SHELLS) {
    assert.equal(
      bashToolEntry.resolvePermissionCapability?.({ command: "ls" }, { bashShellSelection: selection }),
      undefined,
      `${name} 的只读结论必须缺席`,
    );
  }
  const posix = bashToolEntry.resolvePermissionCapability?.(
    { command: "ls" },
    { bashShellSelection: POSIX_SHELL },
  );
  assert.equal(posix?.readOnly, true, "POSIX 的只读结论保持不变");
});

test("能力上下文带的是当前实际 shell（getter 优先于 deps 快照）", () => {
  const deps = {
    bashShellSelection: { dialect: "cmd", source: "auto-detected", display: { name: "CMD" } },
    getBashShellSelection: () => POSIX_SHELL,
    getWorkingDirectory: () => process.cwd(),
    getWorkspaceRoot: () => process.cwd(),
  } as unknown as ToolExecutorDeps;
  assert.equal(resolveRuntimePermissionContext(deps).bashShellSelection?.dialect, "posix");
});