import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  resolveTaskDatabaseMigrationAction,
  runTasksDatabaseMigrations,
} from "../src/session/tasksDatabase/migrations.js";
import {
  backfillWorkspaceRegistry,
  createWorkspaceRegistryRepo,
  enumerateTaskIndexWorkspaceEntries,
  mergeWorkspaceRegistryEntries,
} from "../src/session/workspaceRegistryRepo.js";

/**
 * 工作区注册表（M1.2）护栏：迁移只增不改、回填两源合并且幂等、真实库副本不受损。
 *
 * 为什么必须钉住：注册表会成为「可见工作区集合」的唯一真相源（docs/development/workspace-registry.md）。
 * 回填若不幂等或丢了归档-only 的 workspace，「会话看起来丢了」会以更难发现的形式回归；
 * 迁移若破坏既有 checksum，用户升级时会被挡在启动阶段。
 */

const DAY = 24 * 60 * 60 * 1000;

function withFreshDb(run: (db: DatabaseSync, dir: string) => void | Promise<void>) {
  return (async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-registry-"));
    const db = new DatabaseSync(join(dir, "index.sqlite"));
    try {
      await run(db, dir);
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  })();
}

function insertTask(
  db: DatabaseSync,
  row: {
    key: string;
    path: string;
    identity?: string;
    taskId: string;
    createdAt: number;
    updatedAt: number;
    archived?: number;
  },
) {
  db.prepare(
    "INSERT INTO tasks (workspace_key, workspace_path, workspace_identity, task_id, title, created_at, updated_at, pinned, archived, deleted) VALUES (?,?,?,?,?,?,?,0,?,0)",
  ).run(
    row.key,
    row.path,
    row.identity ?? null,
    row.taskId,
    row.taskId,
    row.createdAt,
    row.updatedAt,
    row.archived ?? 0,
  );
}

test("迁移 0004/0005 只增不改，且同一库重复执行不报错（幂等）", async () => {
  await withFreshDb((db) => {
    runTasksDatabaseMigrations(db, {});
    const applied = db
      .prepare("SELECT id FROM tasks_schema_migration ORDER BY id")
      .all() as unknown as Array<{ id: string }>;
    assert.deepEqual(
      applied.map((row) => row.id),
      [
        "0001_adopt_task_schema",
        "0002_provider_selection",
        "0003_official_glm_selection",
        "0004_workspace_registry",
        "0005_workspace_registry_active_session_count",
      ],
    );
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type=? AND name=?")
      .get("table", "workspace_registry");
    assert.ok(table, "workspace_registry 表必须由迁移创建");
    runTasksDatabaseMigrations(db, {});
    const again = db
      .prepare("SELECT count(*) AS c FROM tasks_schema_migration")
      .get() as unknown as { c: number };
    assert.equal(again.c, 5, "重复执行不得重复登记迁移");
  });
});

test("回填：两源合并、去重、归档-only 的 workspace 也在册，且重复回填幂等", async () => {
  await withFreshDb((db) => {
    runTasksDatabaseMigrations(db, {});
    const now = 1_800_000_000_000;
    insertTask(db, {
      key: "/proj/a",
      path: "/proj/a",
      taskId: "t1",
      createdAt: now - 5 * DAY,
      updatedAt: now - DAY,
    });
    insertTask(db, {
      key: "/proj/a",
      path: "/proj/a",
      taskId: "t2",
      createdAt: now - 9 * DAY,
      updatedAt: now - 8 * DAY,
      archived: 1,
    });
    insertTask(db, {
      key: "/proj/archived-only",
      path: "/proj/archived-only",
      taskId: "t3",
      createdAt: now - 40 * DAY,
      updatedAt: now - 39 * DAY,
      archived: 1,
    });
    const repo = createWorkspaceRegistryRepo({ database: db });

    const first = backfillWorkspaceRegistry({
      repo,
      database: db,
      now: () => now,
      extraEntries: [
        {
          workspaceKey: "/proj/session-only",
          workspacePath: "/proj/session-only",
          firstSeenAt: now - 3 * DAY,
          lastActivityAt: now - 2 * DAY,
          sessionCount: 4,
          // 会话源不知道归档状态，因此该值不被采信（见 mergeActiveSessionCount）。
          activeSessionCount: 0,
          sources: ["session-store"],
        },
        {
          workspaceKey: "/proj/a",
          workspacePath: "/proj/a",
          firstSeenAt: now - 30 * DAY,
          lastActivityAt: now - DAY,
          sessionCount: 2,
          activeSessionCount: 0,
          sources: ["session-store"],
        },
      ],
    });
    assert.equal(first.written, 3, "三个 workspace：a、archived-only、session-only");
    const entries = repo.list();
    const a = entries.find((entry) => entry.workspaceKey === "/proj/a");
    assert.ok(a);
    assert.deepEqual(a.sources, ["session-store", "task-index"], "同 key 的来源取并集");
    assert.equal(a.firstSeenAt, now - 30 * DAY, "firstSeenAt 取最早（跨源）");
    assert.equal(a.lastActivityAt, now - DAY, "lastActivityAt 取最新");
    assert.equal(a.sessionCount, 2, "sessionCount 取最大");
    assert.ok(
      entries.some((entry) => entry.workspaceKey === "/proj/archived-only"),
      "只有归档任务的 workspace 必须在册（不带 archived 过滤）",
    );

    // 幂等：再回填一次（时间更晚）不得产生重复行，firstSeenAt 不得被刷新。
    const later = now + 7 * DAY;
    backfillWorkspaceRegistry({ repo, database: db, now: () => later });
    const after = repo.list();
    assert.equal(after.length, 3, "重复回填不得产生重复行");
    assert.equal(
      after.find((entry) => entry.workspaceKey === "/proj/a")?.firstSeenAt,
      now - 30 * DAY,
      "firstSeenAt 必须保留首次登记时间",
    );
  });
});

test("合并规则：identity 优先、空白 identity 回落 path；未删除行才参与计数", async () => {
  await withFreshDb((db) => {
    runTasksDatabaseMigrations(db, {});
    const now = 1_800_000_000_000;
    insertTask(db, {
      key: "ssh://host/srv/x",
      path: "/srv/x",
      identity: "ssh://host/srv/x",
      taskId: "t1",
      createdAt: now,
      updatedAt: now,
    });
    db.prepare("UPDATE tasks SET deleted = 1 WHERE task_id = ?").run("t1");
    const indexed = enumerateTaskIndexWorkspaceEntries(db);
    assert.equal(indexed.length, 0, "deleted 行不参与注册表枚举");
    const merged = mergeWorkspaceRegistryEntries([
      {
        workspaceKey: "ssh://host/srv/x",
        workspacePath: "/srv/x",
        workspaceIdentity: "ssh://host/srv/x",
        firstSeenAt: 1,
        lastActivityAt: 2,
        sessionCount: 1,
        sources: ["task-index"],
      },
      {
        workspaceKey: "ssh://host/srv/x",
        workspacePath: "/srv/x",
        firstSeenAt: 3,
        lastActivityAt: 5,
        sessionCount: 2,
        sources: ["session-store"],
      },
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].workspaceIdentity, "ssh://host/srv/x", "identity 必须保留");
    assert.equal(merged[0].firstSeenAt, 1);
    assert.equal(merged[0].lastActivityAt, 5);
  });
});

test("真实库的只读副本上跑迁移：checksum 不冲突、既有数据不变、注册表被填充", async () => {
  const realPath = join(homedir(), ".zcode/v2/tasks-index.sqlite");
  if (!existsSync(realPath)) return;
  const dir = await mkdtemp(join(tmpdir(), "ws-registry-copy-"));
  const copyPath = join(dir, "tasks-index.sqlite");
  try {
    await copyFile(realPath, copyPath);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(realPath + suffix)) await copyFile(realPath + suffix, copyPath + suffix);
    }
    const db = new DatabaseSync(copyPath);
    try {
      const before = db.prepare("SELECT count(*) AS c FROM tasks").get() as unknown as {
        c: number;
      };
      runTasksDatabaseMigrations(db, {});
      const repo = createWorkspaceRegistryRepo({ database: db, now: () => Date.now() });
      const result = backfillWorkspaceRegistry({ repo, database: db, now: () => Date.now() });
      const after = db.prepare("SELECT count(*) AS c FROM tasks").get() as unknown as { c: number };
      assert.equal(after.c, before.c, "迁移不得改动既有任务行");
      assert.ok(result.total >= 1, "真实数据副本上应回填出至少一个 workspace");
      const applied = db
        .prepare("SELECT count(*) AS c FROM tasks_schema_migration")
        .get() as unknown as { c: number };
      assert.ok(
        applied.c >= 5,
        "0004/0005 必须登记；既有 0001-0003 的 checksum 必须匹配（否则此处会抛错）",
      );
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("0005 迁移：老库（只有 0004）升级后新列存在、既有数据不丢、随后被真实计数覆盖", async () => {
  await withFreshDb((db) => {
    // 造出「0004 时代」的库：先跑一次完整迁移建出全部表，写入老数据，
    // 再把 0005 的列与账本行撤掉 —— 撤完的库状态与「用户从 ce.3 升级上来」逐字等价
    // （列不存在、账本里没有 0005），但 0001-0004 的 checksum 是真实的，
    // 因此下一步走的是真实 runner（含 checksum 校验），而不是手工调迁移动作。
    runTasksDatabaseMigrations(db, {});
    const legacyPath = "/proj/legacy";
    db.prepare(
      "INSERT INTO workspace_registry (workspace_key, workspace_path, workspace_identity, first_seen_at, last_activity_at, session_count, active_session_count, sources) VALUES (?,?,NULL,?,?,?,?,?)",
    ).run(legacyPath, legacyPath, 1000, 2000, 7, 7, '["task-index"]');
    db.exec("ALTER TABLE workspace_registry DROP COLUMN active_session_count");
    db.prepare("DELETE FROM tasks_schema_migration WHERE id=?").run(
      "0005_workspace_registry_active_session_count",
    );
    const before = db.prepare("PRAGMA table_info(workspace_registry)").all() as unknown as Array<{
      name: string;
    }>;
    assert.ok(
      !before.some((column) => column.name === "active_session_count"),
      "前置条件：老库必须没有新列（否则本用例没有验证升级路径）",
    );

    // 真实升级。
    runTasksDatabaseMigrations(db, {});

    const applied = db
      .prepare("SELECT id FROM tasks_schema_migration ORDER BY id")
      .all() as unknown as Array<{ id: string }>;
    assert.ok(
      applied.some((row) => row.id === "0005_workspace_registry_active_session_count"),
      "升级后 0005 必须登记进账本",
    );
    const columns = db.prepare("PRAGMA table_info(workspace_registry)").all() as unknown as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const added = columns.find((column) => column.name === "active_session_count");
    assert.ok(added, "老库升级后必须存在 active_session_count 列");
    assert.equal(added.notnull, 1, "新列必须 NOT NULL");
    assert.equal(added.dflt_value, "0", "新列默认值必须是 0（老行取默认值，不丢数据）");

    const repo = createWorkspaceRegistryRepo({ database: db });
    const migrated = repo.list().find((entry) => entry.workspaceKey === legacyPath);
    assert.ok(migrated, "老库既有行必须保留");
    assert.equal(migrated.sessionCount, 7, "老库既有计数不得被迁移改动");
    assert.equal(
      migrated.activeSessionCount,
      0,
      "刚升级时新列为默认值 0（表示尚未计算，由随后的枚举 upsert 覆盖）",
    );

    // 紧接着的枚举 upsert 必须把真实值写进去 —— 这是「0 不是最终答案」的前提。
    insertTask(db, {
      key: legacyPath,
      path: legacyPath,
      taskId: "t-active",
      createdAt: 3000,
      updatedAt: 3000,
    });
    insertTask(db, {
      key: legacyPath,
      path: legacyPath,
      taskId: "t-archived",
      createdAt: 3000,
      updatedAt: 3000,
      archived: 1,
    });
    repo.upsertMany(enumerateTaskIndexWorkspaceEntries(db));
    const refreshed = repo.list().find((entry) => entry.workspaceKey === legacyPath);
    assert.ok(refreshed);
    assert.equal(refreshed.activeSessionCount, 1, "未归档会话数必须被真实值覆盖");
    assert.equal(refreshed.sessionCount, 7, "session_count 沿用 MAX 语义，不得回退");
  });
});

test("只有归档任务的 workspace：session_count > 0 而 activeSessionCount = 0（本任务修的错位）", async () => {
  await withFreshDb((db) => {
    runTasksDatabaseMigrations(db, {});
    const now = 1_800_000_000_000;
    insertTask(db, {
      key: "/proj/archived-only",
      path: "/proj/archived-only",
      taskId: "t1",
      createdAt: now - 40 * DAY,
      updatedAt: now - 39 * DAY,
      archived: 1,
    });
    insertTask(db, {
      key: "/proj/archived-only",
      path: "/proj/archived-only",
      taskId: "t2",
      createdAt: now - 41 * DAY,
      updatedAt: now - 38 * DAY,
      archived: 1,
    });
    insertTask(db, {
      key: "/proj/mixed",
      path: "/proj/mixed",
      taskId: "t3",
      createdAt: now - 2 * DAY,
      updatedAt: now - DAY,
    });
    insertTask(db, {
      key: "/proj/mixed",
      path: "/proj/mixed",
      taskId: "t4",
      createdAt: now - 3 * DAY,
      updatedAt: now - 2 * DAY,
      archived: 1,
    });
    // 置顶未归档也算「点开看得到」，与侧栏 "active" 口径一致（不排除 pinned）。
    db.prepare("UPDATE tasks SET pinned = 1 WHERE task_id = ?").run("t3");

    const repo = createWorkspaceRegistryRepo({ database: db });
    repo.upsertMany(enumerateTaskIndexWorkspaceEntries(db));
    const entries = repo.list();
    const archivedOnly = entries.find((entry) => entry.workspaceKey === "/proj/archived-only");
    const mixed = entries.find((entry) => entry.workspaceKey === "/proj/mixed");
    assert.ok(archivedOnly);
    assert.ok(mixed);
    assert.equal(archivedOnly.sessionCount, 2, "全部会话数仍算上归档（在册理由不变）");
    assert.equal(
      archivedOnly.activeSessionCount,
      0,
      "只有归档任务时未归档计数必须为 0 —— 这正是「说已有 N 个、点开是空的」",
    );
    assert.equal(mixed.sessionCount, 2);
    assert.equal(mixed.activeSessionCount, 1, "混合时只数未归档（含置顶）");
    assert.ok(
      entries.every((entry) => entry.activeSessionCount <= entry.sessionCount),
      "active ≤ all 不变量：两个口径都由同一份行集合聚合而来",
    );
  });
});

test("upsert 幂等：重复写不产生重复行，且未归档计数如实下降（归档一个会话）", async () => {
  await withFreshDb((db) => {
    runTasksDatabaseMigrations(db, {});
    const now = 1_800_000_000_000;
    for (const [index, archived] of [
      ["t1", 0],
      ["t2", 0],
      ["t3", 0],
    ] as const) {
      insertTask(db, {
        key: "/proj/p",
        path: "/proj/p",
        taskId: index,
        createdAt: now,
        updatedAt: now,
        archived,
      });
    }
    const repo = createWorkspaceRegistryRepo({ database: db });
    repo.upsertMany(enumerateTaskIndexWorkspaceEntries(db));
    repo.upsertMany(enumerateTaskIndexWorkspaceEntries(db));
    let entries = repo.list();
    assert.equal(entries.length, 1, "重复写不得产生重复行");
    assert.equal(entries[0].sessionCount, 3);
    assert.equal(entries[0].activeSessionCount, 3);

    // 归档一个会话后：未归档计数必须下降（若沿用 MAX 语义就会被永久冻在 3）。
    db.prepare("UPDATE tasks SET archived = 1 WHERE task_id = ?").run("t1");
    repo.upsertMany(enumerateTaskIndexWorkspaceEntries(db));
    entries = repo.list();
    assert.equal(entries.length, 1, "仍不得产生重复行");
    assert.equal(entries[0].activeSessionCount, 2, "归档一个会话后未归档计数必须下降");
    assert.equal(entries[0].sessionCount, 3, "session_count 保持 MAX 语义不变");

    // 未归档计数独立于 session_count：条目里两个值可以不同。
    assert.notEqual(entries[0].activeSessionCount, entries[0].sessionCount);
  });
});

test("未知迁移 id 必须显式抛错，不得静默执行其它迁移", () => {
  assert.throws(
    () => resolveTaskDatabaseMigrationAction("9999_future_migration"),
    /Unknown task database migration id/,
    "未知 id 必须 fail-closed（原实现会把它执行成官方 GLM 迁移）",
  );
  for (const id of [
    "0001_adopt_task_schema",
    "0002_provider_selection",
    "0003_official_glm_selection",
    "0004_workspace_registry",
    "0005_workspace_registry_active_session_count",
  ]) {
    assert.equal(
      typeof resolveTaskDatabaseMigrationAction(id),
      "function",
      id + " 必须登记显式分派",
    );
  }
});
