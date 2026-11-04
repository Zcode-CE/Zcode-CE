import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createSqliteWorkspaceMaintenancePort,
  createWorkspaceMaintenance,
  type WorkspaceMaintenancePorts,
} from "../src/workspace-maintenance/index.js";

/**
 * 工作区删除与数据清理（F7 后半，spec：.local/reports/planning/workspace-purge/SPEC.md）。
 *
 * 这批断言针对的是不可撤销的操作，所以覆盖的是「删错」与「删不干净」两个方向：
 * 计数驱动确认框文案；purge 必须幂等、注册表行最后删、运行中拒绝、互斥。
 */

const KEY = "/repo/a";
const OTHER = "/repo/b";

type Call = string;

function fakePorts(overrides: Partial<WorkspaceMaintenancePorts> = {}) {
  const calls: Call[] = [];
  const tables: Record<string, number> = {
    tasks: 3,
    automations: 1,
    automationRuns: 2,
    offPeakTasks: 1,
  };
  let groups = 2;
  let registry = 1;
  let settingsRemaining = 2;
  let legacySnapshots = 4;
  let checkpoints = 2;
  let running = false;
  let failOn: string | null = null;
  const ports: WorkspaceMaintenancePorts = {
    database: {
      async measure(category) {
        return tables[category] ?? 0;
      },
      async purge(category, workspaceKey) {
        calls.push(`db:${category}:${workspaceKey}`);
        if (failOn === category) {
          failOn = null;
          throw new Error("interrupted");
        }
        const count = tables[category] ?? 0;
        tables[category] = 0;
        return count;
      },
      async measureEmptyTaskGroups() {
        return groups;
      },
      async purgeEmptyTaskGroups(workspaceKey) {
        calls.push(`db:taskGroups:${workspaceKey}`);
        const count = groups;
        groups = 0;
        return count;
      },
      async measureRegistryRow() {
        return registry;
      },
      async purgeRegistryRow(workspaceKey) {
        calls.push(`db:registry:${workspaceKey}`);
        const count = registry;
        registry = 0;
        return count;
      },
    },
    files: {
      async measure() {
        return { legacySnapshots, checkpoints };
      },
      async purge() {
        calls.push("files");
        const deleted = { legacySnapshots, checkpoints };
        legacySnapshots = 0;
        checkpoints = 0;
        return deleted;
      },
    },
    settings: {
      async measure() {
        return settingsRemaining;
      },
      async purge() {
        calls.push("settings");
        const count = settingsRemaining;
        settingsRemaining = 0;
        return count;
      },
    },
    activity: {
      async hasRunningWork() {
        return running;
      },
    },
    audit: {
      async record(entry) {
        calls.push(`audit:${entry.action}`);
      },
    },
    ...overrides,
  };
  return {
    ports,
    calls,
    setRunning(value: boolean) {
      running = value;
    },
    failNext(category: string) {
      failOn = category;
    },
  };
}

test("measure 汇总每项计数，并列出不删项", async () => {
  const harness = fakePorts();
  const service = createWorkspaceMaintenance(harness.ports);
  const measure = await service.measureWorkspace({ workspacePath: KEY });

  assert.equal(measure.workspaceKey, KEY);
  assert.equal(measure.running, false);
  const byId = Object.fromEntries(measure.categories.map((item) => [item.id, item.count]));
  assert.equal(byId.tasks, 3);
  assert.equal(byId.automations, 1);
  assert.equal(byId.automationRuns, 2);
  assert.equal(byId.offPeakTasks, 1);
  assert.equal(byId.taskGroups, 2);
  assert.equal(byId.legacySnapshots, 4);
  assert.equal(byId.checkpoints, 2);
  assert.equal(byId.workspaceSettings, 2);
  // 0 计数的项不进列表：确认框不该列「删除 0 条」。
  assert.equal(byId.workspaceRegistry, 1);
  assert.deepEqual(
    measure.skipped.map((item) => item.id),
    ["cliSessions", "subagentTranscripts", "memory", "mcpTrust"],
  );
});

test("identity 存在时以 identity 为单元（不是路径）", async () => {
  const harness = fakePorts();
  const service = createWorkspaceMaintenance(harness.ports);
  const measure = await service.measureWorkspace({
    workspacePath: "/local/folder",
    workspaceIdentity: "ssh://host/repo ",
  });
  assert.equal(measure.workspaceKey, "ssh://host/repo");
});

test("purge 顺序：数据 → 设置/文件 → 注册表行最后，且结果自洽", async () => {
  const harness = fakePorts();
  const service = createWorkspaceMaintenance(harness.ports);
  const result = await service.purgeWorkspace({ workspacePath: KEY });

  assert.equal(result.completed, true);
  assert.equal(result.deleted.tasks, 3);
  assert.equal(result.deleted.workspaceRegistry, 1);
  assert.deepEqual(result.remaining, {
    tasks: 0,
    taskGroups: 0,
    automations: 0,
    automationRuns: 0,
    offPeakTasks: 0,
    workspaceRegistry: 0,
    legacySnapshots: 0,
    checkpoints: 0,
    workspaceSettings: 0,
  });
  // 注册表行必须是最后一个写操作（审计在它之后写）。
  const deletes = harness.calls.filter((call) => call !== "audit:purge");
  assert.equal(deletes.at(-1), `db:registry:${KEY}`);
});

test("purge 幂等：第二次全 0，仍判为 completed", async () => {
  const harness = fakePorts();
  const service = createWorkspaceMaintenance(harness.ports);
  await service.purgeWorkspace({ workspacePath: KEY });
  const second = await service.purgeWorkspace({ workspacePath: KEY });
  assert.deepEqual(
    Object.values(second.deleted).filter((count) => (count ?? 0) > 0),
    [],
  );
  assert.equal(second.completed, true);
});

test("中断后重试：失败时不删注册表行，重试可完成", async () => {
  const harness = fakePorts();
  const service = createWorkspaceMaintenance(harness.ports);
  harness.failNext("automations");
  await assert.rejects(() => service.purgeWorkspace({ workspacePath: KEY }));
  assert.equal(
    harness.calls.some((call) => call.startsWith("db:registry:")),
    false,
    "中途失败时不能先删注册表行（否则留下不可见孤儿）",
  );
  const retry = await service.purgeWorkspace({ workspacePath: KEY });
  assert.equal(retry.completed, true);
  assert.equal(retry.deleted.workspaceRegistry, 1);
});

test("运行中的工作区拒绝删除，且不产生任何删除", async () => {
  const harness = fakePorts();
  harness.setRunning(true);
  const service = createWorkspaceMaintenance(harness.ports);
  await assert.rejects(() => service.purgeWorkspace({ workspacePath: KEY }), /workspace_running/);
  assert.deepEqual(
    harness.calls.filter((call) => call.startsWith("db:")),
    [],
  );
});

test("全局互斥：purge 进行中再次 purge 被拒", async () => {
  const harness = fakePorts();
  const service = createWorkspaceMaintenance(harness.ports);
  const first = service.purgeWorkspace({ workspacePath: KEY });
  await assert.rejects(
    () => service.purgeWorkspace({ workspacePath: OTHER }),
    /workspace_purge_in_progress/,
  );
  await first;
});

test("removeFromList 只删注册表行，不动数据", async () => {
  const harness = fakePorts();
  const service = createWorkspaceMaintenance(harness.ports);
  const result = await service.removeWorkspaceFromList({ workspacePath: KEY });
  assert.equal(result.removed, true);
  assert.deepEqual(harness.calls, [`db:registry:${KEY}`, "audit:removeFromList"]);
});

test("真实 sqlite 适配器：按 workspace_key 精确命中，另一个工作区不受影响", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zcode-workspace-maintenance-"));
  const databasePath = join(dir, "tasks-index.sqlite");
  const db = new DatabaseSync(databasePath);
  db.exec(`
    CREATE TABLE tasks (workspace_key TEXT NOT NULL, workspace_path TEXT NOT NULL, task_id TEXT NOT NULL,
      task_status TEXT, archived INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY (workspace_key, task_id));
    CREATE TABLE task_groups (group_id TEXT PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE task_group_members (group_id TEXT NOT NULL, workspace_key TEXT NOT NULL, task_id TEXT NOT NULL,
      PRIMARY KEY (workspace_key, task_id));
    CREATE TABLE task_group_view_node_orders (node_type TEXT NOT NULL, node_key TEXT NOT NULL,
      sort_order INTEGER NOT NULL, PRIMARY KEY (node_type, node_key));
    CREATE TABLE task_group_workspace_bootstraps (workspace_key TEXT PRIMARY KEY, group_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE automations (automation_id TEXT PRIMARY KEY, workspace_key TEXT NOT NULL);
    CREATE TABLE automation_runs (run_id TEXT PRIMARY KEY, workspace_key TEXT NOT NULL);
    CREATE TABLE off_peak_tasks (task_id TEXT PRIMARY KEY, workspace_key TEXT NOT NULL, status TEXT NOT NULL, dispatch_status TEXT NOT NULL DEFAULT 'idle');
    CREATE TABLE workspace_registry (workspace_key TEXT PRIMARY KEY, workspace_path TEXT NOT NULL, last_activity_at INTEGER NOT NULL);
  `);
  db.exec(`
    INSERT INTO tasks VALUES ('${KEY}','${KEY}','t1','complete',0,1), ('${KEY}','${KEY}','t2','complete',0,2), ('${OTHER}','${OTHER}','t3','complete',0,3);
    INSERT INTO task_groups VALUES ('own','Own'), ('shared','Shared');
    INSERT INTO task_group_members VALUES ('own','${KEY}','t1'), ('shared','${KEY}','t2'), ('shared','${OTHER}','t3');
    INSERT INTO task_group_workspace_bootstraps VALUES ('${KEY}',NULL,1,1);
    INSERT INTO automations VALUES ('a1','${KEY}');
    INSERT INTO automation_runs VALUES ('r1','${KEY}');
    INSERT INTO off_peak_tasks VALUES ('o1','${KEY}','queued','idle');
    INSERT INTO workspace_registry VALUES ('${KEY}','${KEY}',1), ('${OTHER}','${OTHER}',2);
  `);
  db.close();

  const port = createSqliteWorkspaceMaintenancePort({ databasePath });
  const service = createWorkspaceMaintenance({
    database: port,
    activity: port,
    audit: { record: async () => {} },
  });

  const measure = await service.measureWorkspace({ workspacePath: KEY });
  const byId = Object.fromEntries(measure.categories.map((item) => [item.id, item.count]));
  assert.equal(byId.tasks, 2);
  assert.equal(byId.automations, 1);
  assert.equal(measure.running, false);

  const result = await service.purgeWorkspace({ workspacePath: KEY });
  assert.equal(result.completed, true);

  // 另一个工作区的数据必须原样保留；共享组因为还有成员而保留，独占组被删。
  const verify = new DatabaseSync(databasePath);
  const countOf = (sql: string, key: string) =>
    Number((verify.prepare(sql).get(key) as { count: number }).count);
  assert.equal(countOf("SELECT COUNT(*) AS count FROM tasks WHERE workspace_key = ?", OTHER), 1);
  assert.equal(countOf("SELECT COUNT(*) AS count FROM tasks WHERE workspace_key = ?", KEY), 0);
  assert.equal(
    countOf("SELECT COUNT(*) AS count FROM workspace_registry WHERE workspace_key = ?", KEY),
    0,
  );
  assert.equal(
    countOf("SELECT COUNT(*) AS count FROM workspace_registry WHERE workspace_key = ?", OTHER),
    1,
  );
  const groups = verify
    .prepare("SELECT group_id FROM task_groups ORDER BY group_id")
    .all() as Array<{ group_id: string }>;
  assert.deepEqual(
    groups.map((row) => row.group_id),
    ["shared"],
  );
  verify.close();
  port.close();
  rmSync(dir, { recursive: true, force: true });
});

test("真实 sqlite 适配器：运行中的任务让 purge 被拒", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zcode-workspace-running-"));
  const databasePath = join(dir, "tasks-index.sqlite");
  const db = new DatabaseSync(databasePath);
  db.exec(`
    CREATE TABLE tasks (workspace_key TEXT NOT NULL, workspace_path TEXT NOT NULL, task_id TEXT NOT NULL,
      task_status TEXT, archived INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY (workspace_key, task_id));
    CREATE TABLE off_peak_tasks (task_id TEXT PRIMARY KEY, workspace_key TEXT NOT NULL, status TEXT NOT NULL, dispatch_status TEXT NOT NULL DEFAULT 'idle');
    CREATE TABLE workspace_registry (workspace_key TEXT PRIMARY KEY, workspace_path TEXT NOT NULL, last_activity_at INTEGER NOT NULL);
  `);
  db.exec(`INSERT INTO tasks VALUES ('${KEY}','${KEY}','t1','running',0,1);`);
  db.close();
  const port = createSqliteWorkspaceMaintenancePort({ databasePath });
  assert.equal(await port.hasRunningWork(KEY), true);
  port.close();
  writeFileSync(join(dir, "keep.txt"), "keep");
  rmSync(dir, { recursive: true, force: true });
});
