import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  WORKSPACE_TASK_PAGE_SIZE,
  increaseWorkspaceTaskVisibleLimit,
  resolveVisibleWorkspaceTaskKeys,
  resolveWorkspaceTaskVisibleLimit,
  retainWorkspaceTaskVisibleLimits,
} from "../src/lib/workspaceTaskPagination.js";
import { buildTaskWorkspaceKey } from "../src/lib/taskQueryCache.js";

/**
 * 侧栏会话列表分页/折叠的复用护栏（fix.2 / Task F2）。
 *
 * 为什么必须钉住：用户反馈默认视图「一堆」，而 fix.2 的收敛手段之一是让每个工作区展开后的
 * 会话列表分页（复用既有的 WORKSPACE_TASK_PAGE_SIZE 与 handleShowMoreWorkspaceTasks，
 * 不新造机制）。这条链路有三个容易静默失效的点，都不会被类型检查发现：
 *  ① 分页位置被 retain 清掉 —— 可见集合若只含 tab，注册表行的「显示更多」点一次就归零；
 *  ② hasMore 与列表不同源 —— 按钮出现但点了没反应，或永远不出现；
 *  ③ 行渲染没有把 onShowMore 接上 —— 同上。
 *
 * 反向验证：把 workspaceSidebarRows 的 persistedSessionCount 改回 sessionCount、
 * 或把 visibleWorkspaceTaskKeys 的 workspaces 改回 projectWorkspaceTabs，对应用例会变红。
 */

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

function readSource(relativePath: string): string {
  return readFileSync(join(packageRoot, relativePath), "utf8");
}

test("分页步长复用既有常量：每页 5 条，且与默认可见上限同源", () => {
  assert.equal(WORKSPACE_TASK_PAGE_SIZE, 5, "分页步长是既有产品值，不得在本次改动中被改掉");
  assert.equal(
    resolveWorkspaceTaskVisibleLimit({}, "/proj/ws"),
    WORKSPACE_TASK_PAGE_SIZE,
    "未记录过的工作区必须从第一页开始",
  );
});

test("「显示更多」每次恰好推进一页，且已存上限不会被下调", () => {
  const key = "/proj/ws";
  const first = increaseWorkspaceTaskVisibleLimit({}, key);
  assert.equal(first[key], WORKSPACE_TASK_PAGE_SIZE * 2, "第一次点击推进一页");
  const second = increaseWorkspaceTaskVisibleLimit(first, key);
  assert.equal(second[key], WORKSPACE_TASK_PAGE_SIZE * 3, "第二次继续推进");
  assert.equal(first[key], WORKSPACE_TASK_PAGE_SIZE * 2, "不得修改入参（纯函数）");
  assert.equal(
    resolveWorkspaceTaskVisibleLimit({ [key]: 3 }, key),
    WORKSPACE_TASK_PAGE_SIZE,
    "比一页还小的存量上限必须被抬到一页，否则列表会比页大小还短",
  );
});

test("分页位置只保留给「可见且已展开」的工作区，其余全部清掉", () => {
  const limits = { "/proj/a": 10, "/proj/b": 15 };
  const retained = retainWorkspaceTaskVisibleLimits(limits, new Set(["/proj/a"]));
  assert.deepEqual(retained, { "/proj/a": 10 }, "不可见的工作区分页进度必须清掉");
  assert.equal(
    retainWorkspaceTaskVisibleLimits(limits, new Set(["/proj/a", "/proj/b"])),
    limits,
    "全部命中时不得重建对象（否则每轮 re-render 都会换引用）",
  );
});

test("可见集合必须覆盖「本次列出的全部行」，不能只有本机 tab", () => {
  // 这条是分页能否在注册表行上生效的前提：retainWorkspaceTaskVisibleLimits 的输入就是它。
  const rows = [
    { workspacePath: "/proj/a", workspaceIdentity: undefined },
    { workspacePath: "/proj/b", workspaceIdentity: undefined },
    { workspacePath: "/srv/c", workspaceIdentity: "ssh://host/srv/c" },
  ];
  const expanded = new Set(["/proj/b", "/srv/c"]);
  const keys = resolveVisibleWorkspaceTaskKeys({
    enabled: true,
    expandedWorkspacePaths: expanded,
    workspaces: rows,
  });
  assert.deepEqual(
    [...keys].sort(),
    [
      buildTaskWorkspaceKey("/proj/b", undefined),
      buildTaskWorkspaceKey("/srv/c", "ssh://host/srv/c"),
    ].sort(),
    "展开的每一行（含远端）都必须进入可见集合",
  );
  assert.equal(
    resolveVisibleWorkspaceTaskKeys({
      enabled: false,
      expandedWorkspacePaths: expanded,
      workspaces: rows,
    }).size,
    0,
    "非 workspace 视图或项目区收起时必须返回空集合（统一重置分页）",
  );
});

test("侧栏把分页接在「全部行」上，而不是只接本机 tab", () => {
  const sidebar = readSource("src/WorkspaceSidebar.tsx");
  assert.ok(
    /workspaces:\s*workspaceRows/.test(sidebar),
    "visibleWorkspaceTaskKeys 的 workspaces 必须是本次列出的全部行（workspaceRows）；" +
      "只给 projectWorkspaceTabs 会让注册表行的分页进度每轮被清掉（点了没反应）",
  );
  assert.ok(
    sidebar.includes("defaultVisibleLimit: WORKSPACE_TASK_PAGE_SIZE"),
    "默认可见上限必须复用既有页大小常量",
  );
  assert.ok(
    sidebar.includes("increaseWorkspaceTaskVisibleLimit(current, workspaceKey)"),
    "「显示更多」必须复用既有的推进函数，不得自造第二套分页状态",
  );
});

test("两类行（有 tab / 纯注册表）都接上 hasMore 与 onShowMore", () => {
  const sidebar = readSource("src/WorkspaceSidebar.tsx");
  const hasMoreSites = sidebar.split("taskListHasMore=").length - 1;
  assert.ok(
    hasMoreSites >= 2,
    "有 tab 的行与纯注册表行都必须传 taskListHasMore（实际 " + hasMoreSites + " 处）",
  );
  assert.equal(
    sidebar.includes("taskListHasMore={false}"),
    false,
    "不得再有硬编码的 taskListHasMore={false}：那会让该行的「显示更多」永不出现",
  );
  const showMoreSites = sidebar.split("handleShowMoreWorkspaceTasks").length - 1;
  assert.ok(
    showMoreSites >= 3,
    "handleShowMoreWorkspaceTasks 必须被定义并接到两类行上（实际 " + showMoreSites + " 处）",
  );
  // hasMore 必须与列表同源：都取自同一个 group。
  assert.ok(
    /const rowTaskItems =\s*taskGroup\?\.items/.test(sidebar) &&
      /taskListHasMore=\{taskGroup\?\.hasMore/.test(sidebar),
    "items 与 hasMore 必须取自同一个 taskGroup，否则会出现「按钮在、点了不动」或反过来",
  );
});

test("TaskList 的「显示更多」入口存在且由 hasMore 控制", () => {
  const taskList = readSource("src/TaskList.tsx");
  assert.ok(
    taskList.includes("hasMore && onShowMore"),
    "「显示更多」必须同时具备 hasMore 与 onShowMore 才渲染（缺一个就是死按钮）",
  );
});
