import { z } from "zod";

/**
 * 工作区注册表（M1.1/M1.2）：服务端持有「可见工作区集合」的唯一真相源。
 *
 * 背景与决策见 docs/development/workspace-registry.md：现在可见集合来自客户端设置
 * （lastWorkspaceSession 23 条），而服务端数据侧有 52/53 个 workspace，导致「会话看起来丢了」
 * 与多客户端不一致。本模块只定义**数据形状**与**纯选择规则**，不含任何读写实现，便于两侧复用。
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
