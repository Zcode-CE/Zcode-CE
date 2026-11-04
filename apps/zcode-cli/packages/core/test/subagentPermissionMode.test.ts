import assert from "node:assert/strict";
import test from "node:test";
import type { CollaborationMode } from "@zcode/contracts";
import { resolveSubagentPermissionMode } from "../src/runtime/methods/subagent.js";

/**
 * X20（3.17.2 移植）：子会话权限模式不得宽于父会话。
 *
 * 为什么必须钉住：改前 `resolveSubagentPermissionMode` 对没有 permissionMode 的内置 Explore
 * 派生 yolo（`inheritPermissionMode(parentMode, builtInExplore ? "yolo" : parentMode)`），父会话在
 * build 或 Plan 下的 Explore 因此免审批执行任意 Bash——提示注入后模型经 Agent(Explore) 即可提权。
 * 同一处还让 Explore 拿到一份新建的默认权限服务，父会话的 allowedTools / disallowedTools 与会话内
 * 授权对它不生效（见 runtime/methods/subagent.ts 的 permissionService 传递）。
 *
 * 运行：cd apps/zcode-cli/packages/core && node --import tsx --test test/subagentPermissionMode.test.ts
 */

const PARENT_MODES: CollaborationMode[] = ["plan", "build", "edit", "guarded", "yolo", "auto"];

test("未声明 permissionMode 的子会话继承父会话模式（Explore 不再派生 yolo）", () => {
  for (const parent of PARENT_MODES) {
    assert.equal(resolveSubagentPermissionMode(parent, undefined), parent, parent);
  }
});

test("显式 plan / auto 只会更严，不会被父的宽松模式带跑", () => {
  // plan 只放行只读；auto 在未实现前一律拒绝。两者都不宽于任何父模式。
  assert.equal(resolveSubagentPermissionMode("yolo", "plan"), "plan");
  assert.equal(resolveSubagentPermissionMode("build", "plan"), "plan");
  assert.equal(resolveSubagentPermissionMode("yolo", "auto"), "auto");
  assert.equal(resolveSubagentPermissionMode("plan", "auto"), "auto");
});

test("任何输入都不会产出比父会话更宽的模式", () => {
  const STRICTNESS: readonly CollaborationMode[] = ["plan", "build", "edit", "guarded", "yolo"];
  for (const parent of PARENT_MODES) {
    for (const declared of [undefined, "plan", "auto"] as const) {
      const child = resolveSubagentPermissionMode(parent, declared);
      const parentRank = STRICTNESS.indexOf(parent);
      const childRank = STRICTNESS.indexOf(child);
      // auto 不在严格序里，它一律拒绝（更严）；其余必须不比父宽。
      if (child === "auto") continue;
      assert.ok(
        childRank >= 0 && parentRank >= 0 && childRank <= parentRank,
        `parent=${parent} declared=${String(declared)} child=${child}`,
      );
    }
  }
});
