import type {
  IWorkspaceMaintenanceService,
  WorkspacePurgeCategoryId,
  WorkspacePurgeCounts,
  WorkspacePurgeMeasure,
  WorkspacePurgeResult,
  WorkspacePurgeSkipped,
  WorkspaceRef,
} from "./contract.js";
import type { WorkspaceMaintenancePorts } from "./ports.js";
import { resolveWorkspaceMaintenanceKey } from "./key.js";

/**
 * 清理编排（唯一 owner：本服务）。
 *
 * 顺序（spec §4）：先删所有数据，注册表行最后删。中途失败时数据已删、行还在，
 * 重试幂等；反过来会留下不可见孤儿（不可枚举但占盘，重新打开目录又冒出来）。
 * 全局互斥：同一时刻只允许一个 purge，避免两个窗口同时删同一/不同工作区。
 */
const RUNNING_REASON = "workspace_running";

export function createWorkspaceMaintenance(
  ports: WorkspaceMaintenancePorts,
): IWorkspaceMaintenanceService {
  const now = ports.now ?? (() => Date.now());
  /** 进程内串行：purge 之间互斥（removeFromList 不触碰数据，可并发）。 */
  let purgeInFlight = false;

  // 按 workspaceKey 无法精确命中的项：计划里逐条列出，UI 据此说明"这次不会删什么"。
  const skipped = (): readonly WorkspacePurgeSkipped[] =>
    (["cliSessions", "subagentTranscripts", "memory", "mcpTrust"] as const).map((id) => ({ id }));

  async function measureCategories(ref: Required<WorkspaceRef>): Promise<WorkspacePurgeCounts> {
    const key = resolveWorkspaceMaintenanceKey(ref);
    const database = ports.database;
    const counts: WorkspacePurgeCounts = {
      tasks: await database.measure("tasks", key),
      taskGroups: await database.measureEmptyTaskGroups(key),
      automations: await database.measure("automations", key),
      automationRuns: await database.measure("automationRuns", key),
      offPeakTasks: await database.measure("offPeakTasks", key),
      workspaceRegistry: await database.measureRegistryRow(key),
    };
    if (ports.files) {
      const files = await ports.files.measure(ref);
      counts.legacySnapshots = files.legacySnapshots;
      counts.checkpoints = files.checkpoints;
    }
    if (ports.settings) counts.workspaceSettings = await ports.settings.measure(key);
    if (ports.trust) counts.hookTrust = await ports.trust.measure(key);
    return counts;
  }

  return {
    async measureWorkspace(ref) {
      const resolved = resolveWorkspaceMaintenanceRef(ref);
      const key = resolveWorkspaceMaintenanceKey(resolved);
      const counts = await measureCategories(resolved);
      const measure: WorkspacePurgeMeasure = {
        workspaceKey: key,
        running: await ports.activity.hasRunningWork(key),
        categories: Object.entries(counts)
          .filter(([, count]) => (count ?? 0) > 0)
          .map(([id, count]) => ({ id: id as WorkspacePurgeCategoryId, count: count ?? 0 })),
        skipped: skipped(),
      };
      return measure;
    },

    async purgeWorkspace(ref) {
      const resolved = resolveWorkspaceMaintenanceRef(ref);
      const key = resolveWorkspaceMaintenanceKey(resolved);
      // 互斥必须在任何 await 之前就位：先 await 运行态再置位会留下一个可重入窗口，
      // 两个窗口能同时通过检查、各自删一半。
      if (purgeInFlight) throw new Error("workspace_purge_in_progress");
      purgeInFlight = true;
      const deleted: WorkspacePurgeCounts = {};
      try {
        if (await ports.activity.hasRunningWork(key)) throw new Error(RUNNING_REASON);
        // ① 数据（不含注册表行）。每一步都幂等：已删过的项第二次返回 0。
        for (const category of [
          "tasks",
          "taskGroups",
          "automations",
          "automationRuns",
          "offPeakTasks",
        ] as const) {
          deleted[category] =
            category === "taskGroups"
              ? await ports.database.purgeEmptyTaskGroups(key)
              : await ports.database.purge(category, key);
        }
        if (ports.files) {
          const files = await ports.files.purge(resolved);
          deleted.legacySnapshots = files.legacySnapshots;
          deleted.checkpoints = files.checkpoints;
        }
        if (ports.settings) deleted.workspaceSettings = await ports.settings.purge(key);
        if (ports.trust) deleted.hookTrust = await ports.trust.purge(key);
        // ② 注册表行最后删。
        deleted.workspaceRegistry = await ports.database.purgeRegistryRow(key);
      } finally {
        purgeInFlight = false;
      }
      const remaining = await measureCategories(resolved);
      const completed = Object.values(remaining).every((count) => (count ?? 0) === 0);
      await ports.audit.record({
        at: now(),
        action: "purge",
        workspaceKey: key,
        deleted,
        completed,
      });
      const result: WorkspacePurgeResult = { workspaceKey: key, deleted, remaining, completed };
      return result;
    },

    async removeWorkspaceFromList(ref) {
      const resolved = resolveWorkspaceMaintenanceRef(ref);
      const key = resolveWorkspaceMaintenanceKey(resolved);
      // 只删注册表行：数据保留，用户重新打开该目录即回来（spec §5 第一步）。
      const removed = (await ports.database.purgeRegistryRow(key)) > 0;
      await ports.audit.record({
        at: now(),
        action: "removeFromList",
        workspaceKey: key,
        deleted: { workspaceRegistry: removed ? 1 : 0 },
        completed: true,
      });
      return { removed };
    },
  };
}

function resolveWorkspaceMaintenanceRef(ref: WorkspaceRef): Required<WorkspaceRef> {
  return {
    workspacePath: ref.workspacePath,
    workspaceIdentity: ref.workspaceIdentity?.trim() ?? "",
  };
}
