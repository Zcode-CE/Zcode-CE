import { z } from "zod";

/**
 * 工作区注册表（M1.1/M1.2）：服务端持有「可见工作区集合」的唯一真相源。
 *
 * 背景与决策见 docs/development/workspace-registry.md：现在可见集合来自客户端设置
 * （lastWorkspaceSession 23 条），而服务端数据侧有 52/53 个 workspace，导致「会话看起来丢了」
 * 与多客户端不一致。本模块只定义数据形状与纯选择规则，不含任何读写实现，便于两侧复用。
 */

/** 注册表条目的来源标记（可多源并存，合并时取并集）。 */
export const WORKSPACE_REGISTRY_SOURCES = [
  "task-index",
  "session-store",
  "settings-migrated",
] as const;

export const workspaceRegistrySourceSchema = z.enum(WORKSPACE_REGISTRY_SOURCES);

export const workspaceRegistryEntrySchema = z.object({
  /** 身份键：workspaceIdentity?.trim() || workspacePath（与仓库既有口径一致）。 */
  workspaceKey: z.string().trim().min(1),
  workspacePath: z.string().trim().min(1),
  workspaceIdentity: z.string().trim().min(1).optional(),
  firstSeenAt: z.number().int().nonnegative(),
  lastActivityAt: z.number().int().nonnegative(),
  /** 持久层的可见会话/任务条数（不依赖 runtime，用于「未启动」时也能如实显示有什么）。 */
  sessionCount: z.number().int().nonnegative(),
  /**
   * 其中未归档的会话条数 —— 与侧栏会话列表（只列未归档）同一口径。
   *
   * 为什么两个口径并存：sessionCount 不过滤 archived 是有意设计（保证「只有归档任务」的
   * workspace 也在注册表里，见 workspaceRegistryRepo.ts 顶部注释），而侧栏展开后只显示未归档
   * 会话。若只报 sessionCount，就会出现「说已有 N 个会话、点开是空的」（实测本机 52 个在册
   * 工作区里 24 个如此）。因此展示用的数字必须取本字段。
   *
   * 口径取舍（有意接受，不是漏算）：本字段数的是 archived = 0，含置顶；侧栏 workspace 视图的
   * 列表走 timeline 口径（!pinned && !archived）。因此用户置顶某会话时，本字段会比该视图的列表多 1。
   * 不改成排除 pinned 的理由：置顶会话在「置顶区」里本来就可见；反过来若排除 pinned 就会出现
   * 「注册表说 0 个、展开后置顶区有一条」——把「说多了」换成「说少了」，而说 0 会让用户以为会话
   * 丢了，正是本能力要消灭的观感（workspace-registry.md §1）。两害相权取其轻。
   *
   * 兼容：老库升级后该列为 0，由随后的枚举 upsert 用 tasks 表真实计数覆盖（见 0005 迁移注释）。
   */
  activeSessionCount: z.number().int().nonnegative(),
  sources: z.array(workspaceRegistrySourceSchema).min(1),
});

export type WorkspaceRegistrySource = z.infer<typeof workspaceRegistrySourceSchema>;
export type WorkspaceRegistryEntry = z.infer<typeof workspaceRegistryEntrySchema>;

/** 身份键规则：与 AGENTS.md 「Workspace Identity」一致，避免第二套 key 规则。 */
export function resolveWorkspaceRegistryKey(params: {
  workspacePath: string;
  workspaceIdentity?: string | null;
}): string {
  return params.workspaceIdentity?.trim() || params.workspacePath.trim();
}

/**
 * 注册表列表结果（M1.3）——RPC 与 /api/server-info 的共同载荷。
 *
 * `defaultView` 由服务端用同一份纯规则算出，客户端不得自行改变口径：否则 web 与桌面会看到
 * 不同的「默认视图」，那正是本任务要消灭的多客户端不一致。
 */
export const workspaceRegistryListResultSchema = z.object({
  /** 注册表全集（按最近活动降序）。 */
  entries: z.array(workspaceRegistryEntrySchema),
  /** 默认视图 = 最近活跃窗口 ∪ 置顶（服务端计算，客户端只渲染）。 */
  defaultView: z.array(workspaceRegistryEntrySchema),
  /** 本次使用的活跃窗口天数（便于客户端展示与排查口径差异）。 */
  windowDays: z.number().int().positive(),
  generatedAt: z.number().int().nonnegative(),
});

export type WorkspaceRegistryListResult = z.infer<typeof workspaceRegistryListResultSchema>;

/** 默认视图窗口（产品决定：30 天）。 */
export const WORKSPACE_REGISTRY_DEFAULT_VIEW_WINDOW_DAYS = 30;

export interface WorkspaceRegistryDefaultViewOptions {
  now: number;
  /** 显式置顶的 workspaceKey（来自客户端显示偏好，不参与枚举）。 */
  pinnedKeys?: readonly string[];
  windowDays?: number;
}

/**
 * 「能全看、不默认全看」的默认视图：最近活跃窗口内的条目 ∪ 置顶条目。
 * 纯函数：不读库、不看设置，便于两侧（服务端 RPC 与客户端渲染）用同一口径。
 */
export function selectWorkspaceRegistryDefaultView(
  entries: readonly WorkspaceRegistryEntry[],
  options: WorkspaceRegistryDefaultViewOptions,
): WorkspaceRegistryEntry[] {
  const windowDays = options.windowDays ?? WORKSPACE_REGISTRY_DEFAULT_VIEW_WINDOW_DAYS;
  const cutoff = options.now - windowDays * 24 * 60 * 60 * 1000;
  const pinned = new Set(options.pinnedKeys ?? []);
  return entries
    .filter((entry) => entry.lastActivityAt >= cutoff || pinned.has(entry.workspaceKey))
    .sort((left, right) => right.lastActivityAt - left.lastActivityAt);
}
