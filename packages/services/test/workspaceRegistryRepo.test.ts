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

test("迁移 0004 只新增表，且同一库重复执行不报错（幂等）", async () => {
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
    assert.equal(again.c, 4, "重复执行不得重复登记迁移");
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
          sources: ["session-store"],
        },
        {
          workspaceKey: "/proj/a",
          workspacePath: "/proj/a",
          firstSeenAt: now - 30 * DAY,
          lastActivityAt: now - DAY,
          sessionCount: 2,
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
        applied.c >= 4,
        "0004 必须登记；既有 0001-0003 的 checksum 必须匹配（否则此处会抛错）",
      );
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
  ]) {
    assert.equal(
      typeof resolveTaskDatabaseMigrationAction(id),
      "function",
      id + " 必须登记显式分派",
    );
  }
});
