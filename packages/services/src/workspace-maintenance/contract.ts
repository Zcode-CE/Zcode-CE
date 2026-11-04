import { createServiceDescriptor } from "#src/descriptors.js";
import { ServiceChannels } from "@zcode/shared";

/**
 * 工作区删除与数据清理的对外契约（spec：.local/reports/planning/workspace-purge/SPEC.md）。
 *
 * 单元 = workspaceKey（`workspaceIdentity?.trim() || workspacePath`），不引入 project 实体。
 * 三种操作刻意分开，避免「删一点数据」和「删干净」混成同一个按钮：
 * - measureWorkspace：纯读，产出每项计数（驱动确认框文案与测试）；
 * - purgeWorkspace：彻底删除（不可撤销），注册表行最后删；
 * - removeWorkspaceFromList：只删注册表行，数据保留（重新打开目录即回来）。
 */

/** 可清理项。registry 必须最后删（否则会留下不可见孤儿数据）。 */
export type WorkspacePurgeCategoryId =
  | "tasks"
  | "taskGroups"
  | "automations"
  | "automationRuns"
  | "offPeakTasks"
  | "legacySnapshots"
  | "checkpoints"
  | "workspaceSettings"
  | "hookTrust"
  | "workspaceRegistry";

/** 明确不删的项及原因：既不计数为删除，也不在结果里伪装成已完成。 */
export type WorkspacePurgeSkippedId = "cliSessions" | "subagentTranscripts" | "memory" | "mcpTrust";

export interface WorkspacePurgeCategoryMeasure {
  id: WorkspacePurgeCategoryId;
  /** 该工作区命中的条目数（目录类按文件数）。 */
  count: number;
}

export interface WorkspacePurgeSkipped {
  /**
   * 不删项 id。文案由 UI 按 `settings.workspaceManagement.skipped.<id>` 本地化——
   * 服务层不持有语言。
   */
  id: WorkspacePurgeSkippedId;
}

export interface WorkspacePurgeMeasure {
  workspaceKey: string;
  /** 该工作区是否正在运行（有运行中的任务 / 自动化 / 闲时任务）⇒ 拒绝删除。 */
  running: boolean;
  categories: readonly WorkspacePurgeCategoryMeasure[];
  /** 按 workspaceKey 无法精确命中的数据；这些项不会被本次删除。 */
  skipped: readonly WorkspacePurgeSkipped[];
}

export type WorkspacePurgeCounts = Partial<Record<WorkspacePurgeCategoryId, number>>;

export interface WorkspacePurgeResult {
  workspaceKey: string;
  /** 本次实际删除的计数（幂等重试时第二次为 0）。 */
  deleted: WorkspacePurgeCounts;
  /** 删除后重新测量的剩余计数（全 0 表示已删净）。 */
  remaining: WorkspacePurgeCounts;
  /** 是否已删净（remaining 全 0）。 */
  completed: boolean;
}

export interface WorkspaceRef {
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface IWorkspaceMaintenanceService {
  measureWorkspace(ref: WorkspaceRef): Promise<WorkspacePurgeMeasure>;
  purgeWorkspace(ref: WorkspaceRef): Promise<WorkspacePurgeResult>;
  removeWorkspaceFromList(ref: WorkspaceRef): Promise<{ removed: boolean }>;
}

export const IWorkspaceMaintenanceService = createServiceDescriptor<IWorkspaceMaintenanceService>(
  ServiceChannels.WorkspaceMaintenance,
);
