import {
  ServiceChannels,
  WORKSPACE_REGISTRY_DEFAULT_VIEW_WINDOW_DAYS,
  selectWorkspaceRegistryDefaultView,
  workspaceRegistryEntrySchema,
  workspaceRegistryListResultSchema,
  type WorkspaceRegistryEntry,
  type WorkspaceRegistryListResult,
} from "@zcode/shared";
import { createServiceDescriptor } from "#src/descriptors.js";

/**
 * 工作区注册表 RPC（M1.3）——可见工作区集合的唯一真相源，**只读面**。
 *
 * 为什么必须有这一层：M1 之前侧栏的可见集合来自每个客户端自己的设置
 * （实测设置 23 条 vs 索引库 52 个 workspace），于是「会话看起来丢了」与「两个客户端不一致」
 * 是同一个根因。RPC 把枚举搬到服务端后，所有客户端读同一份注册表。
 *
 * **架构不变式（不是优化建议）**：本服务是纯读——列出全部工作区**绝不**拉起任何 Agent runtime。
 * runtime 只允许由用户主动打开工作区（或显式会话入口）时按需启动，成本模型见
 * docs/development/workspace-registry.md §3.1 与 .reverse/40-remote-control/PUBLISHER-SCALE-MEASUREMENT.md。
 */

export interface WorkspaceRegistryListParams {
  /** 本客户端显式置顶的 workspaceKey（显示偏好，不参与枚举，只影响默认视图取并集）。 */
  pinnedKeys?: readonly string[];
  /** 覆盖活跃窗口天数；缺省用产品默认（30 天）。 */
  windowDays?: number;
}

export interface IWorkspaceRegistryService {
  /**
   * 返回注册表全集与「默认视图」（最近活跃窗口 ∪ 置顶）。
   * 只读、无副作用、不启动任何 workspace 的 runtime。
   */
  listWorkspaceRegistry(params?: WorkspaceRegistryListParams): Promise<WorkspaceRegistryListResult>;
}

export const IWorkspaceRegistryService = createServiceDescriptor<IWorkspaceRegistryService>(
  ServiceChannels.WorkspaceRegistry,
);

/**
 * 注册表服务实现。
 *
 * 刻意把「怎么拿到条目」注入进来（`listEntries`），而不是在这里开数据库：宿主已持有
 * tasks-index 的连接（`TaskIndexRepo`），新开句柄会多一份 WAL 写者与关闭职责。
 * 本函数自身是纯计算，便于单测直接验证默认视图口径。
 */
export function createWorkspaceRegistryService(params: {
  listEntries: () => Promise<readonly WorkspaceRegistryEntry[]>;
  now?: () => number;
}): IWorkspaceRegistryService {
  const now = params.now ?? (() => Date.now());
  return {
    async listWorkspaceRegistry(listParams) {
      const entries = [...(await params.listEntries())];
      // 越界的行不得静默进入列表：注册表是跨客户端的共享事实，坏行应显式丢弃而不是渲染出
      // 「点开没反应」的幽灵工作区。这里只丢行、不抛错（抛错会让整个侧栏变空，比丢一行更糟）。
      const valid = entries.filter(
        (entry) => workspaceRegistryEntrySchema.safeParse(entry).success,
      );
      const windowDays =
        listParams?.windowDays && listParams.windowDays > 0
          ? listParams.windowDays
          : WORKSPACE_REGISTRY_DEFAULT_VIEW_WINDOW_DAYS;
      const defaultView = selectWorkspaceRegistryDefaultView(valid, {
        now: now(),
        pinnedKeys: listParams?.pinnedKeys ?? [],
        windowDays,
      });
      return workspaceRegistryListResultSchema.parse({
        entries: valid,
        defaultView,
        windowDays,
        generatedAt: now(),
      });
    },
  };
}
