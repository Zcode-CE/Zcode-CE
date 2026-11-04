import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
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

/**
 * 真实 schema 上的适配器验证：建库走真实迁移路径（runTasksDatabaseMigrations），
 * 不手写 CREATE TABLE。
 *
 * 这条约束是被真实事故换来的：早先的夹具手写了上游列 `off_peak_tasks.dispatch_status`，
 * 于是单测绿、真机 `no such column`。手写 CREATE TABLE 等于把「我以为的 schema」当成事实，
 * 它永远比真实迁移乐观。因此这里的每个用例都在迁移出来的库上跑。
 */
function createMigratedDatabase(): { databasePath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "zcode-workspace-maintenance-"));
  const databasePath = join(dir, "tasks-index.sqlite");
  const db = new DatabaseSync(databasePath);
  runTasksDatabaseMigrations(db);
  db.close();
  return {
    databasePath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function openDatabase(databasePath: string): DatabaseSync {
  return new DatabaseSync(databasePath);
}

test("迁移后的真实 schema：每一项 measure 的 SQL 都能执行（列名护栏）", async () => {
  const { databasePath, cleanup } = createMigratedDatabase();
  const port = createSqliteWorkspaceMaintenancePort({ databasePath });
  try {
    // 五处按 workspace_key 的统计 + 分组统计 + 注册表行 + 运行态判定：任何一处引用了
    // 真实库里不存在的列，这里都会以 no such column 失败——这正是真机上炸掉的那一类错误。
    for (const category of ["tasks", "automations", "automationRuns", "offPeakTasks"] as const) {
      assert.equal(await port.measure(category, KEY), 0);
    }
    assert.equal(await port.measureEmptyTaskGroups(KEY), 0);
    assert.equal(await port.measureRegistryRow(KEY), 0);
    assert.equal(await port.hasRunningWork(KEY), false);
  } finally {
    port.close();
    cleanup();
  }
});

test("真实 schema：按 workspace_key 精确命中，另一个工作区不受影响", async () => {
  const { databasePath, cleanup } = createMigratedDatabase();
  const now = Date.now();
  const db = openDatabase(databasePath);
  db.exec(`
    INSERT INTO tasks (workspace_key, workspace_path, task_id, task_status, created_at, updated_at)
      VALUES ('${KEY}','${KEY}','t1','completed',${now},${now}), ('${KEY}','${KEY}','t2','completed',${now},${now}), ('${OTHER}','${OTHER}','t3','completed',${now},${now});
    INSERT INTO task_groups (group_id, title, created_at, updated_at) VALUES ('own','Own',${now},${now}), ('shared','Shared',${now},${now});
    INSERT INTO task_group_members (group_id, workspace_key, workspace_path, task_id, added_at, created_at, updated_at)
      VALUES ('own','${KEY}','${KEY}','t1',${now},${now},${now}), ('shared','${KEY}','${KEY}','t2',${now},${now},${now}), ('shared','${OTHER}','${OTHER}','t3',${now},${now},${now});
    INSERT INTO task_group_workspace_bootstraps (workspace_key, created_at, updated_at) VALUES ('${KEY}',${now},${now});
    INSERT INTO automations (automation_id, title, cron_expr, prompt, workspace_key, workspace_path, created_at, updated_at)
      VALUES ('a1','A','0 * * * *','p','${KEY}','${KEY}',${now},${now});
    INSERT INTO automation_runs (run_id, automation_id, workspace_key, created_at, updated_at) VALUES ('r1','a1','${KEY}',${now},${now});
    INSERT INTO off_peak_tasks (off_peak_task_id, prompt, permission_mode, workspace_key, workspace_path, status, queued_at, created_at, updated_at)
      VALUES ('o1','p','build','${KEY}','${KEY}','queued',${now},${now},${now});
    INSERT INTO workspace_registry (workspace_key, workspace_path, first_seen_at, last_activity_at, session_count, sources)
      VALUES ('${KEY}','${KEY}',${now},${now},2,'[]'), ('${OTHER}','${OTHER}',${now},${now},1,'[]');
  `);
  db.close();

  const port = createSqliteWorkspaceMaintenancePort({ databasePath });
  const service = createWorkspaceMaintenance({
    database: port,
    activity: port,
    audit: { record: async () => {} },
  });
  try {
    const measure = await service.measureWorkspace({ workspacePath: KEY });
    const byId = Object.fromEntries(measure.categories.map((item) => [item.id, item.count]));
    assert.equal(byId.tasks, 2);
    assert.equal(byId.automations, 1);
    assert.equal(byId.automationRuns, 1);
    assert.equal(byId.offPeakTasks, 1);
    assert.equal(measure.running, false);

    const result = await service.purgeWorkspace({ workspacePath: KEY });
    assert.equal(result.completed, true);

    const verify = openDatabase(databasePath);
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
  } finally {
    port.close();
    cleanup();
  }
});

test("真实 schema：运行中的任务 / 已认领的闲时任务 / 运行中的自动化都让删除被拒", async () => {
  const { databasePath, cleanup } = createMigratedDatabase();
  const now = Date.now();
  const db = openDatabase(databasePath);

  const port = createSqliteWorkspaceMaintenancePort({ databasePath });
  try {
    assert.equal(await port.hasRunningWork(KEY), false, "空库不算运行中");

    db.exec(`INSERT INTO tasks (workspace_key, workspace_path, task_id, task_status, created_at, updated_at)
      VALUES ('${KEY}','${KEY}','t1','running',${now},${now});`);
    assert.equal(await port.hasRunningWork(KEY), true, "任务 running");

    db.exec("DELETE FROM tasks");
    db.exec(`INSERT INTO off_peak_tasks (off_peak_task_id, prompt, permission_mode, workspace_key, workspace_path, status, queued_at, created_at, updated_at)
      VALUES ('o1','p','build','${KEY}','${KEY}','queued',${now},${now},${now});`);
    db.exec("UPDATE off_peak_tasks SET claim_running = 1 WHERE off_peak_task_id = 'o1'");
    assert.equal(await port.hasRunningWork(KEY), true, "闲时任务已认领");

    db.exec("DELETE FROM off_peak_tasks");
    db.exec(`INSERT INTO automations (automation_id, title, cron_expr, prompt, workspace_key, workspace_path, running, created_at, updated_at)
      VALUES ('a1','A','0 * * * *','p','${KEY}','${KEY}',1,${now},${now});`);
    assert.equal(await port.hasRunningWork(KEY), true, "自动化 running");

    await assert.rejects(
      () =>
        createWorkspaceMaintenance({
          database: port,
          activity: port,
          audit: { record: async () => {} },
        }).purgeWorkspace({ workspacePath: KEY }),
      /workspace_running/,
    );
  } finally {
    db.close();
    port.close();
    cleanup();
  }
});
