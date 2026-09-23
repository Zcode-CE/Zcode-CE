import type { WorkspaceRegistryEntry } from "@zcode/shared";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";

/**
 * 侧栏工作区行 = 「本客户端显式列出的 tab」∪「服务端注册表默认视图」（M1.4）。
 *
 * 三条不可动摇的约束：
 * ① **派生列表，不物化**：注册表补出来的行 `tab === null`，绝不写进 tab store，
 *    因而 `useTabPersistence` 不会把它写回 `lastWorkspaceSession`。一旦物化，枚举就重新变成
 *    「客户端设置决定」，等于我们自己造出第二份真相源（Lead 拍定，见 workspace-registry.md §2.3）。
 * ② **本客户端已有的行保持原顺序**：tab 行沿用 tabs 数组顺序，注册表补列只追加在后面，
 *    因此侧栏既有的排序 / 拖拽语义完全不变。
 * ③ **桌面不得因此变少**：注册表是并集来源，tab 行无论是否在注册表里都必须保留。
 */

export type WorkspaceSidebarRowSource = "client-tab" | "registry";

export interface WorkspaceSidebarRow {
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  /** 本客户端设置里显式列出的 tab；注册表补列的行为 null。 */
  tab: WorkspaceTabState | null;
  /** 注册表条目；tab 行可能没有（本客户端开过但数据侧没有记录）。 */
  registryEntry: WorkspaceRegistryEntry | null;
  /** 持久层会话数：runtime 未启动时用它如实显示「有什么」（§3.2）。 */
  persistedSessionCount: number | null;
  /** 持久层最近活动时间（毫秒）；用于补列行的排序与展示。 */
  lastActivityAt: number | null;
  source: WorkspaceSidebarRowSource;
}

function tabIdentityOf(tab: WorkspaceTabState): string | undefined {
  return tab.workspaceIdentity?.trim() || undefined;
}

/**
 * @param params.tabs 本客户端显式列出的 project tabs（已是侧栏顺序）
 * @param params.registryEntries 注册表条目：`showAll=false` 时传默认视图，`true` 时传全集
 * @param params.showAll 是否已展开「显示全部」
 */
export function buildWorkspaceSidebarRows(params: {
  tabs: readonly WorkspaceTabState[];
  registryEntries: readonly WorkspaceRegistryEntry[];
  showAll: boolean;
}): WorkspaceSidebarRow[] {
  const entryByKey = new Map(params.registryEntries.map((entry) => [entry.workspaceKey, entry]));
  const tabKeys = new Set(
    params.tabs.map((tab) => buildTaskWorkspaceKey(tab.workspacePath, tabIdentityOf(tab))),
  );
  const rows: WorkspaceSidebarRow[] = [];
  for (const tab of params.tabs) {
    const workspaceIdentity = tabIdentityOf(tab);
    const workspaceKey = buildTaskWorkspaceKey(tab.workspacePath, workspaceIdentity);
    const registryEntry = entryByKey.get(workspaceKey) ?? null;
    rows.push({
      workspaceKey,
      workspacePath: tab.workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      tab,
      registryEntry,
      persistedSessionCount: registryEntry?.sessionCount ?? null,
      lastActivityAt: registryEntry?.lastActivityAt ?? null,
      source: "client-tab",
    });
  }
  const derived = params.registryEntries
    .filter((entry) => !tabKeys.has(entry.workspaceKey))
    .filter((entry) => isLocallyOpenableRegistryEntry(entry))
    .sort((left, right) => right.lastActivityAt - left.lastActivityAt);
  for (const entry of derived) {
    rows.push({
      workspaceKey: entry.workspaceKey,
      workspacePath: entry.workspacePath,
      ...(entry.workspaceIdentity ? { workspaceIdentity: entry.workspaceIdentity } : {}),
      tab: null,
      registryEntry: entry,
      persistedSessionCount: entry.sessionCount,
      lastActivityAt: entry.lastActivityAt,
      source: "registry",
    });
  }
  return rows;
}

/** 「显示全部」的剩余数量：注册表全集里还没被列出的行数。 */
export function countHiddenRegistryRows(params: {
  tabs: readonly WorkspaceTabState[];
  entries: readonly WorkspaceRegistryEntry[];
}): number {
  const tabKeys = new Set(
    params.tabs.map((tab) => buildTaskWorkspaceKey(tab.workspacePath, tabIdentityOf(tab))),
  );
  return params.entries.filter(
    (entry) => !tabKeys.has(entry.workspaceKey) && isLocallyOpenableRegistryEntry(entry),
  ).length;
}

/**
 * 只有本地（无 `workspaceIdentity`）的注册表条目才补列进侧栏。
 *
 * 为什么必须排除远端条目：远端工作区在本客户端要能「点开」，需要一条真实的 remote target
 * （`remoteTarget` / `remoteSessionId`），而注册表只记 workspaceKey 与路径 —— 补出来的远端行会落到
 * 既有的「远端未连接」渲染分支，点「重新连接」也因缺 target 而无处可连，正好是 §3.2 禁止的
 * 「点开是死路」。远端工作区仍由本客户端自己的 tab（带 target）承载，因此排除它**不会**让桌面变少。
 */
function isLocallyOpenableRegistryEntry(entry: WorkspaceRegistryEntry): boolean {
  return !entry.workspaceIdentity;
}

/** 侧栏渲染需要的最小 tab 形状：注册表补列行不能成为真 tab，只能借用同一套行渲染。 */
export function buildRegistryRowRenderTab(row: WorkspaceSidebarRow): WorkspaceTabState | null {
  if (row.tab) return row.tab;
  if (row.source !== "registry") return null;
  // 只用于渲染（label / 路径 / 展开态），**不得**进入 tab store：
  // id 前缀 `registry:` 让任何误把它当成真 tab 的路径（closeTab/activateTab）立刻可见地失败，
  // 而不是静默地在设置里留下一条枚举残留。
  return {
    id: `registry:${row.workspaceKey}`,
    kind: "workspace",
    label: row.workspacePath,
    workspacePath: row.workspacePath,
    ...(row.workspaceIdentity ? { workspaceIdentity: row.workspaceIdentity } : {}),
    workspacePurpose: "project",
  } as WorkspaceTabState;
}
