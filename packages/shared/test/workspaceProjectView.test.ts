import assert from "node:assert/strict";
import test from "node:test";
import {
  WORKSPACE_DISPLAY_NAME_MAX_LENGTH,
  buildWorkspaceDisplayNamePatch,
  mergeWorkspaceDisplayNames,
  normalizeWorkspaceDisplayName,
  normalizeWorkspaceDisplayNames,
  resolveWorkspaceProjectView,
  workspacePathBasename,
} from "../src/workspaceProjectView.js";

/**
 * B′ 项目投影：主根 + 附加根 + 展示名，全部来自既有事实，不新增表。
 *
 * 关键不变量：展示名只影响展示（不改路径/身份）；附加根去重且不含主根；
 * 展示名单键合并（空串删除），与附加目录同一套并发语义。
 */

const KEY = "/work/app";

test("路径末段兼容 POSIX/Windows 与尾部分隔符", () => {
  assert.equal(workspacePathBasename("/work/app"), "app");
  assert.equal(workspacePathBasename("/work/app/"), "app");
  assert.equal(workspacePathBasename("C:\\work\\app"), "app");
  assert.equal(workspacePathBasename("/"), "/");
});

test("展示名归一：去空白/控制字符/截断，空值表示没有覆盖", () => {
  assert.equal(normalizeWorkspaceDisplayName("  Backend  "), "Backend");
  assert.equal(normalizeWorkspaceDisplayName("a\u0000b\u001f"), "a b");
  assert.equal(normalizeWorkspaceDisplayName("   "), undefined);
  assert.equal(
    normalizeWorkspaceDisplayName("x".repeat(WORKSPACE_DISPLAY_NAME_MAX_LENGTH + 10))?.length,
    WORKSPACE_DISPLAY_NAME_MAX_LENGTH,
  );
});

test("投影：主根=路径、附加根去重且排除主根、展示名覆盖优先", () => {
  const view = resolveWorkspaceProjectView({
    workspaceKey: KEY,
    workspacePath: "/work/app",
    additionalRoots: ["/work/lib", " /work/lib ", "/work/app", "/work/tools"],
    displayNames: { [KEY]: "Backend" },
  });
  assert.deepEqual(view.additionalRoots, ["/work/lib", "/work/tools"]);
  assert.equal(view.primaryRoot, "/work/app");
  assert.equal(view.displayName, "Backend");
  assert.equal(view.displayNameSource, "override");

  const fallback = resolveWorkspaceProjectView({
    workspaceKey: KEY,
    workspacePath: "/work/app",
  });
  assert.equal(fallback.displayName, "app");
  assert.equal(fallback.displayNameSource, "basename");
});

test("展示名单键补丁与合并：空串删除、其它 key 保留", () => {
  const current = { [KEY]: "Backend", "/work/other": "Tools" };
  const patch = buildWorkspaceDisplayNamePatch(KEY, "  Web  ");
  assert.deepEqual(patch, { [KEY]: "Web" });
  assert.deepEqual(mergeWorkspaceDisplayNames(current, patch), {
    [KEY]: "Web",
    "/work/other": "Tools",
  });

  const remove = buildWorkspaceDisplayNamePatch(KEY, "");
  assert.deepEqual(remove, { [KEY]: "" });
  assert.deepEqual(mergeWorkspaceDisplayNames(current, remove), { "/work/other": "Tools" });
  assert.equal(mergeWorkspaceDisplayNames({ [KEY]: "Backend" }, remove), undefined);
});

test("整表归一：丢空键/空值，无有效项返回 undefined", () => {
  assert.equal(normalizeWorkspaceDisplayNames({ "  ": "x", [KEY]: "   " }), undefined);
  assert.deepEqual(normalizeWorkspaceDisplayNames({ [KEY]: " Backend " }), { [KEY]: "Backend" });
});
