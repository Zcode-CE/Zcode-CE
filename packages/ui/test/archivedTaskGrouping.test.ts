import assert from "node:assert/strict";
import test from "node:test";
import { groupArchivedTasksByWorkspace } from "../src/workspace-archived-tasks/groupArchivedTasks.js";

/**
 * W4 批次 1 的纯逻辑：归档任务按工作区分组（跨工作区视图）。
 * 组顺序按首次出现、组内保持原顺序、标签由调用方（展示名/路径末段）给出。
 */

const tasks = [
  { id: "t1", workspacePath: "/work/a" },
  { id: "t2", workspacePath: "/work/b" },
  { id: "t3", workspacePath: "/work/a" },
  { id: "t4", workspacePath: "/work/c" },
];

test("按工作区分组：组顺序取首次出现，组内保持原顺序", () => {
  const groups = groupArchivedTasksByWorkspace(
    tasks,
    (task) => task.workspacePath,
    (_task, key) => key,
  );
  assert.deepEqual(
    groups.map((group) => group.key),
    ["/work/a", "/work/b", "/work/c"],
  );
  assert.deepEqual(
    groups[0]?.items.map((task) => task.id),
    ["t1", "t3"],
  );
});

test("标签由调用方给出，单工作区也只有一个组", () => {
  const groups = groupArchivedTasksByWorkspace(
    [{ id: "solo", workspacePath: "/work/a" }],
    (task) => task.workspacePath,
    () => "Backend",
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.label, "Backend");
});
