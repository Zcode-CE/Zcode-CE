import type { WorkspacePurgeCategoryId, WorkspacePurgeCounts, WorkspaceRef } from "./contract.js";

/**
 * 清理所需的全部外部能力（端口）：数据库、文件、设置、信任记录、运行态、审计。
 *
 * 为什么是端口而不是直接开库/读文件：服务层要能被单测直接驱动（计数、幂等、中断重试、
 * 注册表行最后删都靠注入的假实现验证），真实实现在 `createWorkspaceMaintenance` 的调用方
 * （node.ts）里装配。
 */

/** tasks-index 库里按 workspace_key 直接命中的表。taskGroups 与 registry 单独处理。 */
export type WorkspaceDatabaseCategoryId = Extract<
  WorkspacePurgeCategoryId,
  "tasks" | "automations" | "automationRuns" | "offPeakTasks"
>;

export interface WorkspaceMaintenanceDatabasePort {
  measure(category: WorkspaceDatabaseCategoryId, workspaceKey: string): Promise<number>;
  purge(category: WorkspaceDatabaseCategoryId, workspaceKey: string): Promise<number>;
  /** 删除工作区后，成员已被清空的组（组本身不属于某个工作区）。 */
  measureEmptyTaskGroups(workspaceKey: string): Promise<number>;
  purgeEmptyTaskGroups(workspaceKey: string): Promise<number>;
  /** 注册表行：整条链的最后一步。 */
  measureRegistryRow(workspaceKey: string): Promise<number>;
  purgeRegistryRow(workspaceKey: string): Promise<number>;
}

export interface WorkspaceMaintenanceFilesPort {
  measure(ref: Required<WorkspaceRef>): Promise<{ legacySnapshots: number; checkpoints: number }>;
  purge(ref: Required<WorkspaceRef>): Promise<{ legacySnapshots: number; checkpoints: number }>;
}

/** AppSettings 里以 workspaceKey 为键的字段（展示名、附加目录、上次活动任务）。 */
export interface WorkspaceMaintenanceSettingsPort {
  measure(workspaceKey: string): Promise<number>;
  purge(workspaceKey: string): Promise<number>;
}

/** 工作区 Hook 信任记录（按 workspaceIdentity 记录）。 */
export interface WorkspaceMaintenanceTrustPort {
  measure(workspaceKey: string): Promise<number>;
  purge(workspaceKey: string): Promise<number>;
}

export interface WorkspaceMaintenanceActivityPort {
  /** 有运行中的任务 / 自动化 / 闲时任务 ⇒ 拒绝删除（不提供强制删除）。 */
  hasRunningWork(workspaceKey: string): Promise<boolean>;
}

export interface WorkspaceMaintenanceAuditEntry {
  at: number;
  action: "purge" | "removeFromList";
  workspaceKey: string;
  deleted: WorkspacePurgeCounts;
  completed: boolean;
}

export interface WorkspaceMaintenanceAuditPort {
  record(entry: WorkspaceMaintenanceAuditEntry): Promise<void>;
}

export interface WorkspaceMaintenancePorts {
  database: WorkspaceMaintenanceDatabasePort;
  files?: WorkspaceMaintenanceFilesPort;
  settings?: WorkspaceMaintenanceSettingsPort;
  trust?: WorkspaceMaintenanceTrustPort;
  activity: WorkspaceMaintenanceActivityPort;
  audit: WorkspaceMaintenanceAuditPort;
  now?: () => number;
}
