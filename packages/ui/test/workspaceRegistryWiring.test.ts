import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import zhCN from "../src/i18n/locales/zh-CN.js";
import enUS from "../src/i18n/locales/en-US.js";
import {
  buildRegistryRowRenderTab,
  buildWorkspaceSidebarRows,
  countHiddenRegistryRows,
} from "../src/hooks/workspaceSidebarRows.js";
import { buildDefaultPersistPatch } from "../src/hooks/useTabPersistence.js";
import type { WorkspaceRegistryEntry } from "@zcode/shared";
import type { TabStoreState, WorkspaceTabState } from "../src/store/tabStore.js";

/**
 * M1.4 侧栏枚举来源切换 + §3.2 诚实未启动态的接线护栏。
 *
 * 为什么用源码/纯函数断言而不是渲染树：这三条约束的回归后果都在**用户观感**上，
 * 类型检查完全看不见：
 *  ① 枚举物化成 tab ⇒ 又变回「客户端设置决定可见集合」（第二份真相源）；
 *  ② 被动订阅丢掉 `existing-only` ⇒ 列出 N 个工作区会拉起 N 个 Agent runtime
 *     （外推 50 个 ≈1 GB + 50 进程，见 PUBLISHER-SCALE-MEASUREMENT.md §2.2）；
 *  ③ 「未启动」被画成「暂无任务」⇒ 用户以为会话丢了（比 M1 之前更糟）。
 */

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

function readSource(relativePath: string): string {
  return readFileSync(join(packageRoot, relativePath), "utf8");
}

const DAY = 24 * 60 * 60 * 1000;

function entry(index: number, overrides: Partial<WorkspaceRegistryEntry> = {}) {
  const now = Date.now();
  return {
    workspaceKey: `/proj/ws-${index}`,
    workspacePath: `/proj/ws-${index}`,
    firstSeenAt: now - 10 * DAY,
    lastActivityAt: now - index * 1_000,
    sessionCount: index + 1,
    activeSessionCount: index + 1,
    sources: ["task-index"] as const,
    ...overrides,
  } satisfies WorkspaceRegistryEntry;
}

function tab(id: string, workspacePath: string): WorkspaceTabState {
  return {
    id,
    kind: "workspace",
    label: workspacePath,
    workspacePath,
    workspacePurpose: "project",
  };
}

/** buildDefaultPersistPatch 只读这几个字段；用显式空态避免断言依赖 store 的其余实现。 */
function emptyTabStoreState(): TabStoreState {
  return {
    tabs: [],
    activeTabId: null,
    activeWorkspacePath: null,
    activeWorkspaceIdentity: null,
    expandedWorkspacePaths: new Set<string>(),
  } as unknown as TabStoreState;
}

test("派生列表以注册表为主序列，本机 tab 只补 tab 字段，且注册表行不物化成 tab", () => {
  const tabs = [tab("tab-a", "/proj/open-here")];
  const entries = [
    entry(0, { workspaceKey: "/proj/open-here", workspacePath: "/proj/open-here" }),
    entry(1),
    entry(2),
  ];
  const rows = buildWorkspaceSidebarRows({ tabs, registryEntries: entries, showAll: false });

  assert.equal(rows.length, 3, "本客户端 tab 与注册表补列都必须在列（能全看）");
  assert.equal(rows[0].source, "client-tab", "tab 行保持原有顺序、排在最前");
  assert.equal(rows[0].tab?.id, "tab-a");
  assert.equal(
    rows[0].registryEntry?.workspaceKey,
    "/proj/open-here",
    "tab 行必须 join 上注册表条目",
  );

  const derived = rows.filter((row) => row.source === "registry");
  assert.equal(derived.length, 2);
  for (const row of derived) {
    assert.equal(row.tab, null, "注册表补出的行不得带 tab（物化会让它写回 lastWorkspaceSession）");
    assert.ok(row.persistedSessionCount !== null, "未启动也必须知道「已有什么」（§3.2）");
  }

  // **枚举绝不写回设置**：可被持久化的 tab 集合必须与本客户端设置里的列表逐一相同。
  // 反向验证：把 registry 行物化成 tab 后，这里会变成 3 ≠ 1 而变红。
  const persistableTabs = rows.flatMap((row) => (row.tab ? [row.tab.id] : []));
  assert.deepEqual(persistableTabs, ["tab-a"], "列出注册表工作区不得改变设置里的工作区列表");
});

test("顺序由注册表决定：按最近活动降序在前，注册表缺口的 tab 追加在后", () => {
  // 口径变化（fix.2 / Task F1）：以前是「tab 一组在前、注册表补列追加在后」，顺序由本机 tab 决定；
  // 现在主序列是注册表（lastActivityAt 降序），本机 tab 只补 tab 字段。因此本机 tab 的顺序
  // 不再影响列出顺序 —— 这正是三端枚举一致的前提，也是拖拽对注册表行变成 no-op 的原因。
  const tabs = [tab("tab-b", "/proj/b"), tab("tab-a", "/proj/a")];
  const rows = buildWorkspaceSidebarRows({
    tabs,
    registryEntries: [
      entry(0, {
        workspaceKey: "/proj/z",
        workspacePath: "/proj/z",
        lastActivityAt: Date.now() - 1_000,
      }),
      entry(1, {
        workspaceKey: "/proj/y",
        workspacePath: "/proj/y",
        lastActivityAt: Date.now() - 5_000,
      }),
    ],
    showAll: false,
  });
  assert.deepEqual(
    rows.map((row) => row.workspacePath),
    ["/proj/z", "/proj/y", "/proj/b", "/proj/a"],
    "注册表按最近活动降序在前；注册表里没有的 tab（缺口）追加在后",
  );
  // rows[0] 是纯注册表行（本机没有它的 tab）⇒ 借用渲染 tab，id 带 registry: 前缀。
  assert.equal(buildRegistryRowRenderTab(rows[0])?.id.startsWith("registry:"), true);
  // 本机已有的 tab 仍复用真 tab（保住可拖拽/可移除），不得被降级成渲染占位。
  assert.equal(buildRegistryRowRenderTab(rows[2])?.id, "tab-b");
});

test("远端条目（带 workspaceIdentity）不补列：缺 remote target 的点开是死路", () => {
  const remoteEntry = entry(9, {
    workspaceKey: "ssh://host/srv/x",
    workspacePath: "/srv/x",
    workspaceIdentity: "ssh://host/srv/x",
  });
  const rows = buildWorkspaceSidebarRows({
    tabs: [],
    registryEntries: [entry(0), remoteEntry],
    showAll: true,
  });
  assert.deepEqual(
    rows.map((row) => row.workspacePath),
    ["/proj/ws-0"],
    "远端工作区只能由带 remote target 的 tab 承载，不得由注册表补列",
  );
  assert.equal(
    countHiddenRegistryRows({ entries: [entry(0), remoteEntry], listedEntries: [] }),
    1,
    "「显示全部」的计数必须与补列口径一致（否则按钮会数不准）",
  );
});

test("「显示全部」的数量与全集一致（判据 1 的可见部分）", () => {
  const tabs = [tab("tab-a", "/proj/ws-0")];
  const entries = [entry(0), entry(1), entry(2)];
  // 口径变化（fix.2 / Task F1）：剩余 = 全集减去「本次已列出的条目」，
  // 不再按本机 tab 算 —— 列出什么已完全由注册表决定（见 countHiddenRegistryRows 的注释）。
  const defaultView = entries.slice(0, 1);
  assert.equal(
    countHiddenRegistryRows({ entries, listedEntries: defaultView }),
    2,
    "本次未列出的条目才算剩余",
  );
  const all = buildWorkspaceSidebarRows({ tabs, registryEntries: entries, showAll: true });
  assert.equal(all.length, 3, "显示全部后必须能列到注册表全集");
  assert.equal(
    countHiddenRegistryRows({ entries, listedEntries: entries }),
    0,
    "已列到全集时剩余必须为 0（否则「显示全部」按钮不会收起）",
  );
});

test("展示的会话数取「未归档」口径：与侧栏展开后实际列出的会话同源", () => {
  // 缺陷背景：注册表 sessionCount 不过滤 archived（有意设计，保证「只有归档任务」的工作区也在册），
  // 而侧栏展开后只列未归档会话 ⇒ 只报 sessionCount 会出现「说已有 N 个会话、点开是空的」。
  // 实测本机 52 个在册工作区里 24 个如此。展示用数字必须取 activeSessionCount。
  const archivedOnly = entry(0, {
    workspaceKey: "/proj/archived-only",
    workspacePath: "/proj/archived-only",
    sessionCount: 12,
    activeSessionCount: 0,
  });
  const mixed = entry(1, {
    workspaceKey: "/proj/mixed",
    workspacePath: "/proj/mixed",
    sessionCount: 9,
    activeSessionCount: 4,
  });
  const rows = buildWorkspaceSidebarRows({
    tabs: [],
    registryEntries: [archivedOnly, mixed],
    showAll: false,
  });
  const byPath = new Map(rows.map((row) => [row.workspacePath, row]));
  assert.equal(
    byPath.get("/proj/archived-only")?.persistedSessionCount,
    0,
    "只有归档会话时必须显示 0（显示 12 就是「点开是空的」那个错位）",
  );
  assert.equal(byPath.get("/proj/mixed")?.persistedSessionCount, 4, "混合时必须只数未归档");
  // 反向验证锚点：把这两处来源改回 sessionCount，上面两条断言立即变红（12 / 9）。
});

test("展示的会话数必须来自注册表条目，不得回落到全部会话数", () => {
  const sidebarRows = readSource("src/hooks/workspaceSidebarRows.ts");
  const assignments = sidebarRows
    .split("\n")
    .filter((line) => line.includes("persistedSessionCount:"))
    .join("\n");
  assert.ok(
    assignments.includes("activeSessionCount"),
    "persistedSessionCount 必须取 activeSessionCount",
  );
  assert.equal(
    /persistedSessionCount:\s*\S*\.sessionCount/.test(assignments),
    false,
    "persistedSessionCount 不得取 sessionCount（含归档，与列表口径不一致）",
  );
});

test("被动订阅必须携带 existing-only：列出 50 个工作区不得拉起 runtime", () => {
  const transport = readSource("src/v4/agentSessionsIndexTransport.ts");
  // 会话索引传输是侧栏/首屏被动订阅的唯一通道：三处调用都必须显式钉住策略。
  for (const method of [
    "subscribeSessionsIndexV4({",
    "unsubscribeSessionsIndexV4({",
    "resyncSessionsIndexV4({",
  ]) {
    const sites = transport.split(method).slice(1);
    assert.ok(sites.length > 0, method + " 的调用点必须存在");
    for (const site of sites) {
      const callBody = site.slice(0, site.indexOf("})"));
      assert.ok(
        callBody.includes('runtimePolicy: "existing-only"'),
        method +
          ' 的每次调用都必须带 runtimePolicy: "existing-only"（否则被动列表会拉起 Agent runtime）',
      );
    }
  }

  // 注册表/未启动态这两条新路径不得出现任何启动型动作或 tab 物化。
  for (const relativePath of [
    "src/hooks/useWorkspaceRegistry.ts",
    "src/hooks/useWorkspaceRuntimeStates.ts",
    "src/hooks/workspaceSidebarRows.ts",
  ]) {
    const source = readSource(relativePath);
    for (const forbidden of [
      "start-if-needed",
      "addTab(",
      "ensureWorkspaceTab",
      "startDraft",
      "prepareWorkspaceWithZCodeSessionService",
    ]) {
      assert.equal(
        source.includes(forbidden),
        false,
        relativePath + " 不得出现启动型/物化型调用：" + forbidden,
      );
    }
  }
});

test("侧栏把 runtime 状态接到行上，且未启动不再落到「暂无任务」", () => {
  const sidebar = readSource("src/WorkspaceSidebar.tsx");
  assert.ok(sidebar.includes("buildWorkspaceSidebarRows("), "侧栏必须用注册表派生列表");
  assert.ok(
    sidebar.includes("useWorkspaceRuntimeStates(") &&
      sidebar.includes("runtimeState={") &&
      sidebar.includes("persistedSessionCount="),
    "每行必须带上 runtime 状态与持久层会话数（§3.2）",
  );

  const item = readSource("src/WorkspaceSidebarItem.tsx");
  // fix.2 / Task F1：行上的「未启动」徽标已移除。
  // 为什么断言它不存在：徽标挂在工作区行上、按行渲染，而 runtime 是按工作区懒启动的，
  // 于是首屏几乎每行都带它（实测 29 行里 28 行，见 M1-CRITERIA-3-4.md:37）。
  // 恒亮且人人有份的徽标不携带信息。诚实未启动态改由展开后的 WorkspaceRuntimeNotice 承载
  // （下面几条断言仍在钉它）。反向验证：把徽标加回去，这条会红。
  assert.equal(
    item.includes("WorkspaceRuntimeBadge"),
    false,
    "行上不得再渲染「未启动」徽标（恒亮徽标是噪音，状态由展开后的 notice 承载）",
  );
  // 运行中圆圈必须保留（官方既有标识，防止「去徽标」误删它）。
  assert.ok(
    item.includes("STATUS_DOT.running"),
    "运行中圆圈必须保留：去徽标不等于去掉所有状态标识",
  );
  assert.ok(
    item.includes("runtimeState={runtimeState}") && item.includes("onStartRuntime="),
    "runtime 状态必须下传到任务列表（点开才启动）",
  );
  assert.ok(
    item.includes("isRegistryDerived") && item.includes("TID_WORKSPACE_CLOSE"),
    "注册表派生行不得提供「移除」（那不是它的 tab）",
  );

  const taskList = readSource("src/TaskList.tsx");
  assert.ok(
    taskList.includes(
      "visibleSourceTasks.length === 0 && isHonestRuntimePlaceholder(runtimeState)",
    ),
    "未启动态必须先于「暂无任务」分支处理（禁止把未启动当空列表）",
  );
  assert.ok(
    /function isHonestRuntimePlaceholder\(state: WorkspaceRuntimeState \| undefined\): boolean \{\s*return state === "not-started" \|\| state === "starting" \|\| state === "failed";/.test(
      taskList,
    ),
    "只有未启动/启动中/失败三种状态占用空列表位置（unknown 与 live 必须落回原有文案）",
  );
  assert.ok(taskList.includes("WorkspaceRuntimeNotice"), "未启动/启动中/失败都必须有明确画面");
});

// F2 待 F1 解除：注册表补列行的会话列表 + 分页一致性
//
// 现状（本文件写就时）：WorkspaceSidebar.tsx:1653 的补列行 taskItems 恒为空数组，
// 且 useWorkspaceTaskLists 的 workspaceTabs 只含 projectWorkspaceTabs（:683），
// 因此补列行没有 group/items/total，taskListHasMore 硬编码 false。
// ⇒ 「已有 N 个会话」在补列行上无法与任何列表对账（132 号报告缺口 A）。
//
// 解除条件（逐字，F1 交付后由 F2 执行）：
//   1) packages/ui/src/WorkspaceSidebar.tsx 里补列行的 taskItems={EMPTY_WORKSPACE_TASK_ITEMS}
//      改为取自 useWorkspaceTaskLists 的 group（即该 hook 的 scopes 覆盖注册表全集）；
//   2) 同文件 taskListHasMore={false} 改为 taskGroup?.hasMore ?? false。
//   两步做完本断言自动转绿，无需改断言本体；若届时仍红，说明接线只做了一半。
//
// 当前状态：红（故意）。交付前若 F1 未落定，本用例改为 { skip: "等 F1 的 scopes 覆盖" }，
// 并在交付摘要里写明「1 条 skip + 解除条件」——不允许红着交付，也不允许放宽断言。
test("注册表补列行的会话列表条数必须与展示的会话数同源（F1 的 scopes 覆盖后转绿）", () => {
  const sidebar = readSource("src/WorkspaceSidebar.tsx");
  assert.equal(
    sidebar.includes("taskItems={EMPTY_WORKSPACE_TASK_ITEMS}"),
    false,
    "补列行的 taskItems 不得恒为空数组：否则「已有 N 个会话」没有可对账的列表（缺口 A）",
  );
  // 上面那条只钉住「字面量没了」，钉不住「scopes 真的覆盖了全集」——
  // 变异验证实测：把 useWorkspaceTaskLists 的入参改回 projectWorkspaceTabs，
  // 仅靠上面那条仍然是绿的（因为行渲染仍写 taskGroup?.items）。因此必须再钉住 scopes 的来源。
  const scopesStart = sidebar.indexOf("const workspaceTaskLists = useWorkspaceTaskLists({");
  assert.ok(scopesStart > 0, "必须能定位 useWorkspaceTaskLists 调用点");
  const scopesCall = sidebar.slice(
    scopesStart,
    sidebar.indexOf("const workspaceTaskGroupByKey", scopesStart),
  );
  assert.ok(
    scopesCall.includes("workspaceTabs: workspaceTaskListTabs"),
    "task scope 必须来自 workspaceRows 派生的 workspaceTaskListTabs（覆盖注册表全集），" +
      "否则补列行没有 group/items/total，「已有 N 个会话」无从对账",
  );
  assert.equal(
    scopesCall.includes("workspaceTabs: projectWorkspaceTabs"),
    false,
    "task scope 不得退回本机 tab：那正是补列行拿不到会话列表的原因（132 号报告缺口 A）",
  );
  // 分页位置必须覆盖注册表行，否则「显示更多」每轮被 retainWorkspaceTaskVisibleLimits 清掉。
  const visibleKeysStart = sidebar.indexOf("const visibleWorkspaceTaskKeys = useMemo(");
  const visibleKeysCall = sidebar.slice(
    visibleKeysStart,
    sidebar.indexOf("useEffect(", visibleKeysStart),
  );
  assert.ok(
    visibleKeysCall.includes("workspaces: workspaceRows"),
    "分页可见集合必须覆盖全部列出行（含注册表行），否则分页位置每轮被清掉",
  );
});

/**
 * fix.2 / Task F1 的核心护栏：点击注册表行不得把工作区写进设置。
 *
 * 为什么这是护栏缺口而不是普通回归：131 号报告第 3 节判定，「点击后消失」的持久化后果来自
 * App.handleStartDraftInWorkspace 走 addTab ⇒ tab store 变化 ⇒ useTabPersistence 的 300ms 防抖
 * 把该路径写进 lastWorkspaceSession。此后它永久不再是注册表行（枚举被设置改写）。
 * 既有护栏只钉住「列出不物化」，点击路径完全没有覆盖（本文件当时的三处源码扫描都不含 App.tsx）。
 *
 * 判据分三层，缺一不可：
 *  ① 补丁层：viewOnly tab 不得出现在 lastWorkspaceSession 里（纯函数，直接断言 patch）；
 *  ② 源码层：点击路径不得再用 addTab（那是「把工作区固定到本客户端」的语义）；
 *  ③ 激活层：过滤不能把「激活」也挡掉，否则变成「点了没反应」—— 那是我们要修的缺陷形态本身。
 */

test("点击注册表行后 lastWorkspaceSession 逐字不变：viewOnly tab 不进持久化补丁", () => {
  const baseTabs: TabStoreState["tabs"] = [
    { id: "tab-a", kind: "workspace", label: "a", workspacePath: "/proj/a" },
  ];
  // 点击注册表行前：补丁里只有用户显式打开过的那条。
  const before = buildDefaultPersistPatch({
    ...emptyTabStoreState(),
    tabs: baseTabs,
    activeWorkspacePath: "/proj/a",
  });
  assert.deepEqual(
    before.lastWorkspaceSession,
    [{ kind: "local", workspacePath: "/proj/a" }],
    "前置：基线里只有显式打开过的工作区",
  );

  // 点击一条注册表行：激活态被承载在一条 viewOnly tab 上（见 activateOrOpenWorkspaceTab）。
  const after = buildDefaultPersistPatch({
    ...emptyTabStoreState(),
    tabs: [
      {
        id: "tab-view",
        kind: "workspace",
        label: "ws-9",
        workspacePath: "/proj/ws-9",
        viewOnly: true,
      },
      ...baseTabs,
    ],
    activeTabId: "tab-view",
    activeWorkspacePath: "/proj/ws-9",
  });

  // ① 逐字不变：条数与内容都必须与点击前一致。
  assert.deepEqual(
    after.lastWorkspaceSession,
    before.lastWorkspaceSession,
    "点击注册表行后 lastWorkspaceSession 必须逐字不变（否则该路径永久变成显示偏好，" +
      "枚举重新由设置决定 —— 正是 131 号报告第 3 节 (d) 判定的缺陷）",
  );
  assert.equal(
    JSON.stringify(after.lastWorkspaceSession),
    JSON.stringify(before.lastWorkspaceSession),
    "逐字比对（含字段顺序）也必须一致",
  );
  // ③ 激活态仍然生效：过滤只作用于持久化，不得把「点了没反应」引进来。
  assert.equal(
    after.lastActiveTabIndex,
    before.lastActiveTabIndex,
    "激活索引必须与持久化列表同口径（viewOnly 行不得把它顶偏）",
  );
});

test("viewOnly 的过滤点必须穷尽：两条写 lastWorkspaceSession 的路径都过滤", () => {
  // 写入点只有两个（其余都经它们）：
  //   1) useTabPersistence.buildDefaultPersistPatch（无自定义 patch 时的默认路径）
  //   2) remoteWorkspaceSessionPersistence.buildRemoteWorkspacePersistPatch（Root 注入的自定义 patch）
  // 漏掉任何一个，viewOnly tab 都会从另一条路径落盘。
  const persistence = readSource("src/hooks/useTabPersistence.ts");
  assert.ok(
    persistence.includes("!tab.viewOnly"),
    "buildDefaultPersistPatch 必须过滤 viewOnly tab",
  );

  const remotePersistence = readSource("src/root/remoteWorkspaceSessionPersistence.ts");
  assert.ok(
    remotePersistence.includes("tab.viewOnly"),
    "buildRemoteWorkspacePersistPatch 必须过滤 viewOnly tab（否则自定义 patch 路径会漏）",
  );
  // 索引必须与持久化列表同口径，否则激活 viewOnly 行时 lastActiveTabIndex 会指错位置。
  assert.ok(
    /const workspaceTabs = persistedTabs\.filter/.test(remotePersistence),
    "lastActiveTabIndex 必须按过滤后的列表计算",
  );
});

test("点击路径不得用 addTab 打开工作区（那会把注册表行物化进设置）", () => {
  const app = readSource("src/App.tsx");
  const start = app.indexOf("const handleStartDraftInWorkspace = useCallback(");
  assert.ok(start > 0, "必须能定位 handleStartDraftInWorkspace");
  const body = app.slice(start, app.indexOf("useWorkspaceShellLifecycle({", start));
  assert.ok(
    body.includes("activateOrOpenWorkspaceTab("),
    "打开一个尚未成为 tab 的工作区必须走 activateOrOpenWorkspaceTab（viewOnly 承载激活态）",
  );

  // 精确到「activateTabByPath 未命中」这条分支：它才是点击注册表行走的路径。
  // 上面的 targetWorkspacePurpose 分支仍用 addTab，那是有意的 ——
  // 「新建对话/对话工作区」是用户显式创建，本来就该持久化。
  const fallbackStart = body.indexOf("!activateTabByPath(");
  assert.ok(fallbackStart > 0, "必须能定位「未命中已有 tab」的兜底分支");
  const fallback = body.slice(
    fallbackStart,
    body.indexOf("useWorkbenchGroupStore.getState()", fallbackStart),
  );
  assert.ok(
    fallback.includes("activateOrOpenWorkspaceTab("),
    "兜底分支必须走 activateOrOpenWorkspaceTab（只承载激活态、不写设置）",
  );
  assert.equal(
    /\baddTab\(/.test(fallback),
    false,
    "兜底分支不得调用 addTab：addTab 的语义是「把工作区固定到本客户端」（会写回设置），" +
      "用它打开注册表行就是「点击后消失」的成因",
  );

  // 反向验证锚点：把兜底分支的 activateOrOpenWorkspaceTab 换回 addTab，本用例立即变红。
});

test("注册表缺口的 tab 仍可见：数据侧没有记录的工作区不得从侧栏消失", () => {
  // 实测本机 3 个目录（/home/sixiao/aicode/fix/ZCode-CE、/tmp/pr1/ws、digital_ecosystemV2/）
  // 只存在于客户端设置，任务索引库与会话库都没有它们。
  // 见 docs/development/workspace-registry.md 第 6 节「未实施项 3」与
  // taskIndexRepo.ts 的 listWorkspaceRegistryEntries 只合并任务索引单源。
  const gapTab = tab("tab-gap", "/proj/only-in-settings");
  const rows = buildWorkspaceSidebarRows({
    tabs: [gapTab],
    registryEntries: [entry(0), entry(1)],
  });
  assert.equal(rows.length, 3, "注册表 2 条 + 缺口 tab 1 条都必须列出");
  const gapRow = rows.find((row) => row.workspacePath === "/proj/only-in-settings");
  assert.ok(gapRow, "缺口 tab 必须仍出现在侧栏（否则用户已打开的工作区凭空消失）");
  assert.equal(gapRow.registryEntry, null, "缺口行没有注册表条目");
  assert.equal(gapRow.source, "client-tab", "缺口行由本机 tab 承载（可移除/可拖拽）");
  assert.equal(gapRow.persistedSessionCount, null, "数据侧没有记录时不得编造会话数");
});

test("同一工作区不得出现两行：尾斜杠不同也必须去重", () => {
  // 注册表与会话库对同一目录的写法不一致（实测本机 28 个目录仅尾斜杠不同，
  // 如 /home/sixiao/aicode/test/test6 与 /home/sixiao/aicode/test/test6/）。
  // 去重键 buildTaskWorkspaceKey 不归一化尾斜杠，只用它会给同一工作区列出两行 ——
  // 那是「点击后消失」的另一种形态。
  const rows = buildWorkspaceSidebarRows({
    tabs: [tab("tab-a", "/proj/same")],
    registryEntries: [
      entry(0, { workspaceKey: "/proj/same/", workspacePath: "/proj/same/" }),
      entry(1),
    ],
  });
  assert.deepEqual(
    rows.map((row) => row.workspacePath),
    ["/proj/same/", "/proj/ws-1"],
    "同一工作区只列一行（注册表那条），不得再补一条 tab 行",
  );
  assert.equal(rows[0].tab?.id, "tab-a", "注册表行必须认领本机已有的 tab（保住拖拽/移除）");

  // 反向验证锚点：把 normalizeWorkspacePathKey 换成恒等函数，本用例立即变成 3 行。
});

test("新增文案在 zh-CN 与 en-US 都存在", () => {
  const keys = [
    // workspaceRuntime.badge.* 已随徽标一并删除（fix.2 / Task F1）：它们只被徽标使用，
    // 留着会成为无人消费的死文案。
    "workspaceRuntime.starting.title",
    "workspaceRuntime.failed.title",
    "workspaceRuntime.failed.reasonUnavailable",
    "workspaceRuntime.failed.retry",
    "workspaceRuntime.notStarted.title",
    "workspaceRuntime.notStarted.persistedSessions",
    "workspaceRuntime.notStarted.noSessions",
    "workspaceRuntime.notStarted.open",
    "workspaceSidebar.registry.showAll",
    "workspaceSidebar.registry.hideAll",
    "workspaceSidebar.registry.loadFailed",
    "workspaceSidebar.registry.retry",
  ];
  for (const key of keys) {
    assert.equal(typeof zhCN[key], "string", "zh-CN 缺文案：" + key);
    assert.equal(typeof enUS[key], "string", "en-US 缺文案：" + key);
  }
});
