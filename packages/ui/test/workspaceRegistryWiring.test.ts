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
import type { WorkspaceRegistryEntry } from "@zcode/shared";
import type { WorkspaceTabState } from "../src/store/tabStore.js";

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

test("派生列表 = 本客户端 tab ∪ 注册表默认视图，且注册表行**不物化成 tab**", () => {
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

test("排序稳定性：补列行按最近活动降序追加，tab 顺序原样保留", () => {
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
    ["/proj/b", "/proj/a", "/proj/z", "/proj/y"],
    "既有排序/拖拽语义不得被补列打乱",
  );
  assert.equal(buildRegistryRowRenderTab(rows[2])?.id.startsWith("registry:"), true);
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
    countHiddenRegistryRows({ tabs: [], entries: [entry(0), remoteEntry] }),
    1,
    "「显示全部」的计数必须与补列口径一致（否则按钮会数不准）",
  );
});

test("「显示全部」的数量与全集一致（判据 1 的可见部分）", () => {
  const tabs = [tab("tab-a", "/proj/ws-0")];
  const entries = [entry(0), entry(1), entry(2)];
  assert.equal(countHiddenRegistryRows({ tabs, entries }), 2, "已在本客户端列出的不计入剩余");
  const all = buildWorkspaceSidebarRows({ tabs, registryEntries: entries, showAll: true });
  assert.equal(all.length, 3, "显示全部后必须能列到注册表全集");
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
  assert.ok(item.includes("WorkspaceRuntimeBadge"), "行上必须有「未启动」徽标");
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

test("新增文案在 zh-CN 与 en-US 都存在", () => {
  const keys = [
    "workspaceRuntime.badge.notStarted",
    "workspaceRuntime.badge.starting",
    "workspaceRuntime.badge.failed",
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
