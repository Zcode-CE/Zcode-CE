import { createRequire } from "node:module";
import { getTasksIndexDatabasePath } from "#src/paths.js";
import type {
  WorkspaceDatabaseCategoryId,
  WorkspaceMaintenanceActivityPort,
  WorkspaceMaintenanceDatabasePort,
} from "./ports.js";

const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

/** 每张表按 workspace_key 命中；task_groups 是全局表，见 orphan 处理。 */
const TABLE_BY_CATEGORY: Record<WorkspaceDatabaseCategoryId, string> = {
  tasks: "tasks",
  automations: "automations",
  automationRuns: "automation_runs",
  offPeakTasks: "off_peak_tasks",
};

export interface SqliteWorkspaceMaintenancePort
  extends WorkspaceMaintenanceDatabasePort, WorkspaceMaintenanceActivityPort {
  close(): void;
}

/**
 * tasks-index 库的真实读写面。
 *
 * 这是一次性破坏性操作，不是高频读路径，因此这里自持一个句柄：`busy_timeout` + 既有 WAL
 * 让它在与宿主连接并存时安全，做完即关。之所以不复用 taskIndexRepo 的连接：那个句柄是私有的，
 * 为一处删除去打开它的封装会把「注册表只读面」的边界拆掉。
 */
export function createSqliteWorkspaceMaintenancePort(params?: {
  databasePath?: string;
}): SqliteWorkspaceMaintenancePort {
  const path = params?.databasePath ?? getTasksIndexDatabasePath();
  const db: DatabaseSyncInstance = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");

  const count = (sql: string, key: string): number => {
    const row = db.prepare(sql).get(key) as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  };
  const run = (sql: string, key: string): number => {
    const result = db.prepare(sql).run(key);
    return Number(result.changes ?? 0);
  };
  const transaction = <T>(fn: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  /** 该 workspace 的成员所在组里，删完成员后会变成空组的那些组 id。 */
  const groupIdsOwnedOnlyBy = (workspaceKey: string): string[] =>
    (
      db
        .prepare(
          `SELECT DISTINCT m.group_id AS groupId FROM task_group_members m
           WHERE m.workspace_key = ?
             AND NOT EXISTS (
               SELECT 1 FROM task_group_members other
               WHERE other.group_id = m.group_id AND other.workspace_key <> ?
             )`,
        )
        .all(workspaceKey, workspaceKey) as Array<{ groupId: string }>
    ).map((row) => row.groupId);

  return {
    async measure(category, workspaceKey) {
      return count(
        `SELECT COUNT(*) AS count FROM ${TABLE_BY_CATEGORY[category]} WHERE workspace_key = ?`,
        workspaceKey,
      );
    },
    async purge(category, workspaceKey) {
      return transaction(() =>
        run(`DELETE FROM ${TABLE_BY_CATEGORY[category]} WHERE workspace_key = ?`, workspaceKey),
      );
    },
    async measureEmptyTaskGroups(workspaceKey) {
      const members = count(
        "SELECT COUNT(*) AS count FROM task_group_members WHERE workspace_key = ?",
        workspaceKey,
      );
      return members + groupIdsOwnedOnlyBy(workspaceKey).length;
    },
    async purgeEmptyTaskGroups(workspaceKey) {
      return transaction(() => {
        const groupIds = groupIdsOwnedOnlyBy(workspaceKey);
        let changes = run("DELETE FROM task_group_members WHERE workspace_key = ?", workspaceKey);
        changes += run(
          "DELETE FROM task_group_workspace_bootstraps WHERE workspace_key = ?",
          workspaceKey,
        );
        for (const groupId of groupIds) {
          changes += run("DELETE FROM task_groups WHERE group_id = ?", groupId);
          // 组的排序记录按 (node_type, node_key) 存；节点键与组 id 不一定同形，两种形状都清。
          for (const nodeKey of [groupId, `group:${groupId}`]) {
            changes += db
              .prepare("DELETE FROM task_group_view_node_orders WHERE node_key = ?")
              .run(nodeKey).changes as number;
          }
        }
        return changes;
      });
    },
    async measureRegistryRow(workspaceKey) {
      return count(
        "SELECT COUNT(*) AS count FROM workspace_registry WHERE workspace_key = ?",
        workspaceKey,
      );
    },
    async purgeRegistryRow(workspaceKey) {
      return transaction(() =>
        run("DELETE FROM workspace_registry WHERE workspace_key = ?", workspaceKey),
      );
    },
    /**
     * 运行中判定：任务行处于 running/pending，或闲时任务已被 claim（正在跑）。
     * 自动化本身是调度器：它真的在跑时会在 `tasks` 里产生一条运行中的任务行，因此不单独判定。
     */
    async hasRunningWork(workspaceKey) {
      const tasks = count(
        "SELECT COUNT(*) AS count FROM tasks WHERE workspace_key = ? AND task_status IN ('running','pending')",
        workspaceKey,
      );
      const offPeak = count(
        "SELECT COUNT(*) AS count FROM off_peak_tasks WHERE workspace_key = ? AND dispatch_status = 'claimed'",
        workspaceKey,
      );
      return tasks + offPeak > 0;
    },
    close() {
      db.close();
    },
  };
}
