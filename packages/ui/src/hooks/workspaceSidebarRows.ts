import type { WorkspaceRegistryEntry } from "@zcode/shared";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";

/**
 * 侧栏工作区行的派生规则（fix.2 / Task F1 改了枚举口径）。
 *
 * 枚举的唯一来源是服务端注册表；本机 tab 只用来给行补 tab 字段（激活态与远端连接身份），
 * 不再决定列出什么。因此三端列出的是同一份集合。
 *
 * 为什么必须改（旧口径是「本机 tab 并集 注册表」）：
 * ① 同一份数据在不同客户端列出不同集合（实测桌面 38 行、手机 23 行）；
 * ② 注册表补列行点击后会被 addTab 物化成 tab，随即被 tabKeys 过滤掉，
 *    用户看到的是「点击后消失」（docs/development/131-workspace-path-titled-entries.md 第 3 节）。
 *
 * 两条不可动摇的约束：
 * ① 主序列只由注册表决定：行的存在与顺序都来自注册表条目（lastActivityAt 降序）。
 * ② 注册表缺口的 tab 必须补列在后面（见下方 gap tabs 一段）：实测本机有 3 个目录
 *    （/home/sixiao/aicode/fix/ZCode-CE、/tmp/pr1/ws、digital_ecosystemV2/）只存在于客户端设置，
 *    任务索引库与会话库都没有它们。纯注册表枚举会让用户已经打开的工作区从侧栏消失。
 *    这是服务端枚举的已知缺口，不是「tab 决定枚举」：
 *    docs/development/workspace-registry.md 第 6 节「未实施项 3：只有会话、没有任务行的工作区尚不在册」；
 *    根因是 packages/services/src/session/taskIndexRepo.ts 的 listWorkspaceRegistryEntries
 *    只合并了任务索引单源，而会话库那一源由调用方以 extraEntries 传入、从未传入。
 *    缺口补齐后这段兜底可以整段删掉。
 */

export type WorkspaceSidebarRowSource = "client-tab" | "registry";

export interface WorkspaceSidebarRow {
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  /** 本客户端已打开该工作区的 tab；纯注册表行的该字段为 null。 */
  tab: WorkspaceTabState | null;
  /** 注册表条目；注册表缺口的 tab 行为 null。 */
  registryEntry: WorkspaceRegistryEntry | null;
  /**
   * 持久层会话数：runtime 未启动时用它如实显示「有什么」（第 3.2 节）。
   *
   * 取注册表的 activeSessionCount（未归档），不取 sessionCount（全部）：
   * 侧栏展开后只列未归档会话，报全部会造成「说已有 N 个会话、点开是空的」
   * （实测本机 52 个在册工作区里 24 个如此，见 workspace-registry.ts 的字段注释）。
   */
  persistedSessionCount: number | null;
  /** 持久层最近活动时间（毫秒）；用于排序与展示。 */
  lastActivityAt: number | null;
  source: WorkspaceSidebarRowSource;
}

function tabIdentityOf(tab: WorkspaceTabState): string | undefined {
  return tab.workspaceIdentity?.trim() || undefined;
}

/**
 * 尾斜杠归一化键：只用于「两行是不是同一个工作区」的判定，不改变 workspaceKey 本身。
 *
 * 为什么需要它：注册表与会话库对同一目录的写法不一致。实测本机会话库里
 * /home/sixiao/aicode/test/test6 与注册表里的 /home/sixiao/aicode/test/test6/ 是同一个目录，
 * 仅尾斜杠不同，这样的目录有 28 个。去重键 buildTaskWorkspaceKey 不归一化尾斜杠
 * （口径按根 AGENTS.md 的 Workspace Identity 一节，这里不改它），直接用它会为同一个工作区
 * 列出两行 —— 那是「点击后消失」的另一种形态。
 *
 * 本机 tab 与注册表比对时实测 0 条仅尾斜杠不同（两侧恰好同口径），但会话库那一侧有 28 条，
 * 所以判定必须归一化，不能依赖「恰好一致」。
 */
function normalizeWorkspacePathKey(workspacePath: string): string {
  const trimmed = workspacePath.trim();
  const withoutTrailingSeparator = trimmed.replace(/[\\/]+$/, "");
  return withoutTrailingSeparator.length > 0 ? withoutTrailingSeparator : trimmed;
}

/**
 * @param params.tabs 本客户端已打开的工作区 tab：只用于给注册表行补 tab 字段，
 *   不决定列出什么。调用方必须排除「仅承载激活态的 viewOnly tab」，它只是当前激活项的载体。
 * @param params.registryEntries 本次要列出的注册表条目（侧栏默认视图或全集）
 * @param params.showAll 已不再影响结果：列出什么完全由 registryEntries 决定。
 *   保留该参数只为兼容既有调用点，避免同批改动扩大面。
 */
export function buildWorkspaceSidebarRows(params: {
  tabs: readonly WorkspaceTabState[];
  registryEntries: readonly WorkspaceRegistryEntry[];
  showAll: boolean;
}): WorkspaceSidebarRow[] {
  const tabByNormalizedPath = new Map<string, WorkspaceTabState>();
  for (const tab of params.tabs) {
    const normalizedPath = normalizeWorkspacePathKey(tab.workspacePath);
    if (!tabByNormalizedPath.has(normalizedPath)) {
      tabByNormalizedPath.set(normalizedPath, tab);
    }
  }

  const rows: WorkspaceSidebarRow[] = [];
  const listedNormalizedPaths = new Set<string>();
  // 主序列：注册表条目，按最近活动降序。远端条目排除的理由见 isLocallyOpenableRegistryEntry。
  const listedEntries = params.registryEntries
    .filter((entry) => isLocallyOpenableRegistryEntry(entry))
    .sort((left, right) => right.lastActivityAt - left.lastActivityAt);
  for (const entry of listedEntries) {
    const normalizedPath = normalizeWorkspacePathKey(entry.workspacePath);
    const tab = tabByNormalizedPath.get(normalizedPath) ?? null;
    listedNormalizedPaths.add(normalizedPath);
    rows.push({
      workspaceKey: entry.workspaceKey,
      workspacePath: entry.workspacePath,
      ...(entry.workspaceIdentity ? { workspaceIdentity: entry.workspaceIdentity } : {}),
      tab,
      registryEntry: entry,
      persistedSessionCount: entry.activeSessionCount,
      lastActivityAt: entry.lastActivityAt,
      source: tab ? "client-tab" : "registry",
    });
  }

  // 注册表缺口：数据侧没有记录、但本客户端已经打开的工作区。见文件头 ②。
  for (const tab of params.tabs) {
    const normalizedPath = normalizeWorkspacePathKey(tab.workspacePath);
    if (listedNormalizedPaths.has(normalizedPath)) {
      continue;
    }
    listedNormalizedPaths.add(normalizedPath);
    const workspaceIdentity = tabIdentityOf(tab);
    rows.push({
      workspaceKey: buildTaskWorkspaceKey(tab.workspacePath, workspaceIdentity),
      workspacePath: tab.workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      tab,
      registryEntry: null,
      persistedSessionCount: null,
      lastActivityAt: null,
      source: "client-tab",
    });
  }
  return rows;
}

/**
 * 「显示全部」的剩余数量 = 注册表全集里本次没有列出的条目数。
 *
 * 口径变化（fix.2）：以前「列出的集合」由本机 tab 决定，所以剩余要扣掉 tab 覆盖的条目；
 * 现在列出的集合完全由 listedEntries 给出，本机 tab 不参与，参数里的 tabs 因此被移除。
 */
export function countHiddenRegistryRows(params: {
  entries: readonly WorkspaceRegistryEntry[];
  listedEntries: readonly WorkspaceRegistryEntry[];
}): number {
  const listedKeys = new Set(params.listedEntries.map((entry) => entry.workspaceKey));
  return params.entries.filter(
    (entry) => !listedKeys.has(entry.workspaceKey) && isLocallyOpenableRegistryEntry(entry),
  ).length;
}

/**
 * 只有本地（无 workspaceIdentity）的注册表条目才列进侧栏。
 *
 * 为什么必须排除远端条目：远端工作区在本客户端要能「点开」，需要一条真实的 remote target
 * （remoteTarget / remoteSessionId），而注册表只记 workspaceKey 与路径 —— 列出来的远端行会落到
 * 既有的「远端未连接」渲染分支，点「重新连接」也因缺 target 而无处可连，正好是第 3.2 节禁止的
 * 「点开是死路」。远端工作区仍由本客户端自己的 tab（带 target）承载，因此排除它不会让桌面变少。
 */
function isLocallyOpenableRegistryEntry(entry: WorkspaceRegistryEntry): boolean {
  return !entry.workspaceIdentity;
}

/** 侧栏渲染需要的最小 tab 形状：纯注册表行不能成为真 tab，只能借用同一套行渲染。 */
export function buildRegistryRowRenderTab(row: WorkspaceSidebarRow): WorkspaceTabState | null {
  if (row.tab) return row.tab;
  if (row.source !== "registry") return null;
  // 只用于渲染（label / 路径 / 展开态），不得进入 tab store：
  // id 前缀 registry: 让任何误把它当成真 tab 的路径（closeTab/activateTab）立刻可见地失败，
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
