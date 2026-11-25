import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { CreateSessionInput, ProjectId, SessionId } from "@zcode/contracts";
import {
  backupSessionDatabaseBeforeMigration,
  readSessionDatabaseBackupManifest,
  SESSION_DATABASE_BACKUP_RETENTION,
} from "../src/storage/session-store/migration-backup.js";
import {
  DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS,
  runSqliteSessionMigrations,
  type SqliteSessionMigrationRunOptions,
} from "../src/storage/session-store/migration-runner.js";
import { SQLITE_MIGRATIONS } from "../src/storage/session-store/migrations.js";
import { applySessionSoftDeleteOutcomeMigration } from "../src/storage/session-store/migrations/0023-session-soft-delete-outcome.js";
import { applySessionPermanentDeletionMigration } from "../src/storage/session-store/migrations/0025-session-permanent-deletion.js";
import { SESSION_DELETING_ERROR_CODE } from "../src/storage/session-store/session-deleting.js";
import {
  createSqliteSessionStore,
  SqliteSessionStore,
} from "../src/storage/session-store/sqlite-session-store.js";

/**
 * 会话库迁移 0023–0026 + schema_too_new 守卫 + 删除凭据可解释错误。
 *
 * 每条用例都对应一个只会在真实用户库上暴露的失效形态：
 * ① 一条迁移写错 ⇒ 新库建不起来（启动即失败）；
 * ② 已是最新库被重复记账/重复备份 ⇒ 每次启动都写盘，多窗口互相等锁；
 * ③ 库比程序新却继续写 ⇒ 在「不理解的结构」上写坏数据（旧版最危险的失效）；
 * ④ 结构已在、账本未记账（官方开发构建或中断） ⇒ 重复 alter/建表直接失败，库打不开；
 * ⑤ 迁移前没有可用备份 ⇒ 「迁完才发现语义不对」时无路可退；
 * ⑥ 官方正在彻底删除某会话 ⇒ 用户看到 SQLite 触发器原文 session-data.deleting。
 */

const KNOWN_MAX_ID = SQLITE_MIGRATIONS.at(-1)?.id ?? "";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "zcode-migration-0023-"));
}

function checksum(sql: string): string {
  return createHash("sha256").update(sql.trim()).digest("hex");
}

function ensureParentDirectory(dbPath: string): void {
  mkdirSync(dirname(dbPath), { recursive: true });
}

/** 造一个「已发布到第 count 条」的库：结构 + 账本都按冻结清单写，等价于该版本发布的库。 */
function createDatabaseAt(dbPath: string, count: number): void {
  ensureParentDirectory(dbPath);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(
      "create table schema_migration (id text primary key, checksum text not null, " +
        "app_version text, time_applied integer not null)",
    );
    db.exec("begin immediate");
    for (const migration of SQLITE_MIGRATIONS.slice(0, count)) {
      if (migration.apply) migration.apply(db);
      else db.exec(migration.sql);
      db.prepare(
        "insert into schema_migration (id, checksum, app_version, time_applied) values (?, ?, ?, ?)",
      ).run(migration.id, checksum(migration.sql), migration.appVersion, Date.now());
    }
    db.exec("commit");
  } finally {
    db.close();
  }
}

function runMigrations(dbPath: string, runOptions: SqliteSessionMigrationRunOptions = {}): void {
  ensureParentDirectory(dbPath);
  const db = new DatabaseSync(dbPath);
  try {
    runSqliteSessionMigrations(db, dbPath, DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS, runOptions);
  } finally {
    db.close();
  }
}

function withReadOnlyDatabase<T>(dbPath: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function ledgerIds(db: DatabaseSync): string[] {
  return db
    .prepare("select id from schema_migration order by id")
    .all()
    .map((row) => String(row.id));
}

function schemaDump(db: DatabaseSync): string[] {
  return db
    .prepare("select type, name, sql from sqlite_master order by type, name")
    .all()
    .map((row) => JSON.stringify(row));
}

function readState(dbPath: string): { ledgerIds: string[]; schema: string[] } {
  return withReadOnlyDatabase(dbPath, (db) => ({
    ledgerIds: ledgerIds(db),
    schema: schemaDump(db),
  }));
}

function snapshotLedger(dbPath: string): Array<{ id: string; checksum: string }> {
  return withReadOnlyDatabase(dbPath, (db) =>
    db
      .prepare("select id, checksum from schema_migration order by id")
      .all()
      .map((row) => ({ id: String(row.id), checksum: String(row.checksum) })),
  );
}

function sessionColumns(dbPath: string): string[] {
  return withReadOnlyDatabase(dbPath, (db) =>
    db
      .prepare("pragma table_info(session)")
      .all()
      .map((row) => String(row.name)),
  );
}

function countTriggers(db: DatabaseSync, prefix: string): number {
  const row = db
    .prepare("select count(*) as n from sqlite_master where type = ? and name like ?")
    .get("trigger", `${prefix}%`) as { n?: unknown } | undefined;
  return Number(row?.n ?? 0);
}

function hasSchemaObject(db: DatabaseSync, type: string, name: string): boolean {
  return Boolean(
    db.prepare("select name from sqlite_master where type = ? and name = ?").get(type, name),
  );
}

function sessionInput(id: string): CreateSessionInput {
  return {
    id: id as SessionId,
    projectID: "project-1" as ProjectId,
    slug: id,
    directory: "/tmp/workspace",
    title: id,
    version: "0.0.0-test",
  };
}

test("① 空库从 0 连续迁到 0026：账本、软删列、删除表与 74 条触发器、父会话索引一次建齐", () => {
  const root = tempDir();
  const dbPath = join(root, "cli", "db", "db.sqlite");
  const backupRootDir = join(root, "backup");
  try {
    runMigrations(dbPath, { backupRootDir });
    const ids = withReadOnlyDatabase(dbPath, (db) => ledgerIds(db));
    assert.equal(ids.at(-1), KNOWN_MAX_ID);
    assert.equal(ids.at(-1), "0026_dwf_run_parent_session_index");
    assert.equal(ids.length, SQLITE_MIGRATIONS.length);
    withReadOnlyDatabase(dbPath, (db) => {
      // 0025 的 74 条触发器是「官方删除中」屏障的全部内容；少一条就有一条写路径漏过。
      assert.equal(countTriggers(db, "session_purge"), 74);
      assert.ok(
        hasSchemaObject(db, "index", "dwf_run_parent_session_idx"),
        "0026 的父会话索引必须存在",
      );
      assert.ok(hasSchemaObject(db, "table", "zcode_database_identity"), "0024 的库身份表必须存在");
    });
    const columns = sessionColumns(dbPath);
    assert.ok(columns.includes("time_deleted"), "0023 的 time_deleted 必须存在");
    assert.ok(columns.includes("last_outcome"), "0023 的 last_outcome 必须存在");
    // 新库没有可丢的数据：不复制备份文件（否则每次安装都多占一份全库体积）。
    assert.equal(existsSync(backupRootDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("② 已到 0026 的库再打开不改账本、不做备份", () => {
  const root = tempDir();
  const dbPath = join(root, "cli", "db", "db.sqlite");
  const backupRootDir = join(root, "backup");
  try {
    runMigrations(dbPath, { backupRootDir });
    const before = snapshotLedger(dbPath);
    const outcomes: string[] = [];
    runMigrations(dbPath, {
      backupRootDir,
      onBackupOutcome: (outcome) => outcomes.push(outcome.kind),
    });
    assert.deepEqual(snapshotLedger(dbPath), before);
    // 没有待执行迁移时连备份都不做：多窗口启动不会各自复制一份多 GB 会话库。
    assert.deepEqual(outcomes, []);
    assert.equal(existsSync(backupRootDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("③ 账本里有更高未知 id ⇒ 抛 schema_too_new，且一行 DDL 都没发生", () => {
  const root = tempDir();
  const dbPath = join(root, "cli", "db", "db.sqlite");
  const backupRootDir = join(root, "backup");
  try {
    // 只到 0022 的库：若守卫缺失，runner 会顺手把 0023–0026 建出来（这是可判别的差异）。
    createDatabaseAt(dbPath, 22);
    const injector = new DatabaseSync(dbPath);
    try {
      injector
        .prepare(
          "insert into schema_migration (id, checksum, app_version, time_applied) values (?, ?, ?, ?)",
        )
        .run("0027_future_migration", "unknown-checksum", "9.9.9", Date.now());
      assert.equal(ledgerIds(injector).length, 23);
    } finally {
      injector.close();
    }
    const before = readState(dbPath);
    assert.throws(
      () => runMigrations(dbPath, { backupRootDir }),
      (error: unknown) => {
        const migrationError = error as { kind?: string; migrationId?: string };
        assert.equal(migrationError.kind, "schema_too_new");
        assert.equal(migrationError.migrationId, "0027_future_migration");
        return true;
      },
    );
    const after = readState(dbPath);
    // 账本没多一行、sqlite_master 没多一个对象：守卫 rollback 后等价于「没打开过」。
    assert.deepEqual(after.ledgerIds, before.ledgerIds);
    assert.deepEqual(after.schema, before.schema);
    assert.equal(after.ledgerIds.includes("0023_session_soft_delete_outcome"), false);
    assert.equal(sessionColumns(dbPath).includes("time_deleted"), false, "失败路径不得留下软删列");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("③b 账本里是 ≤ 本版最大 id 的未知别名（官方开发构建）⇒ 放行，不误伤", () => {
  const root = tempDir();
  const dbPath = join(root, "cli", "db", "db.sqlite");
  const backupRootDir = join(root, "backup");
  try {
    createDatabaseAt(dbPath, 22);
    const injector = new DatabaseSync(dbPath);
    try {
      injector
        .prepare(
          "insert into schema_migration (id, checksum, app_version, time_applied) values (?, ?, ?, ?)",
        )
        .run("0020_session_soft_delete_outcome", "alias-checksum", "0.16.9", Date.now());
    } finally {
      injector.close();
    }
    runMigrations(dbPath, { backupRootDir });
    const ids = snapshotLedger(dbPath).map((row) => row.id);
    assert.equal(ids.at(-1), KNOWN_MAX_ID);
    assert.ok(ids.includes("0020_session_soft_delete_outcome"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("④ 0023/0025 半结构（结构已在、账本未记账）⇒ apply 补齐而非报错", () => {
  const root = tempDir();
  const dbPath = join(root, "cli", "db", "db.sqlite");
  const backupRootDir = join(root, "backup");
  try {
    createDatabaseAt(dbPath, 22);
    const preparer = new DatabaseSync(dbPath);
    try {
      // 模拟「结构已建、账本没记」：先执行 0023/0025 的结构，再把账本留在 0022。
      applySessionSoftDeleteOutcomeMigration(preparer);
      applySessionPermanentDeletionMigration(preparer);
    } finally {
      preparer.close();
    }
    const before = readState(dbPath);
    assert.equal(before.ledgerIds.includes("0023_session_soft_delete_outcome"), false);
    assert.ok(sessionColumns(dbPath).includes("time_deleted"), "半结构前提：列已经在了");
    const outcomes: string[] = [];
    runMigrations(dbPath, {
      backupRootDir,
      onBackupOutcome: (outcome) => outcomes.push(outcome.kind),
    });
    const after = readState(dbPath);
    assert.equal(after.ledgerIds.at(-1), KNOWN_MAX_ID);
    assert.equal(after.ledgerIds.length, SQLITE_MIGRATIONS.length);
    // 半结构库属于 upgrade：迁移前必须先留一份备份（否则「迁完才发现不对」无路可退）。
    assert.equal(outcomes[0], "created");
    withReadOnlyDatabase(dbPath, (db) => {
      assert.equal(countTriggers(db, "session_purge"), 74);
    });
    // 列只加一次：重复 alter 会抛 duplicate column name。
    const columns = sessionColumns(dbPath);
    assert.equal(columns.filter((name) => name === "time_deleted").length, 1);
    assert.equal(columns.filter((name) => name === "last_outcome").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("⑤ 备份：manifest + sha256 + quick_check 自检，只保留最近两份", () => {
  const root = tempDir();
  const dbPath = join(root, "cli", "db", "db.sqlite");
  const backupRootDir = join(root, "backup");
  try {
    runMigrations(dbPath, { backupRootDir });
    const db = new DatabaseSync(dbPath);
    try {
      const appliedMigrationIds = ledgerIds(db);
      const first = backupSessionDatabaseBeforeMigration(db, dbPath, {
        backupRootDir,
        appliedMigrationIds,
      });
      assert.equal(first.kind, "created");
      if (first.kind !== "created") throw new Error("unreachable");
      const manifest = readSessionDatabaseBackupManifest(first.directory);
      assert.ok(manifest, "manifest 必须可解析");
      assert.equal(manifest.databaseLabel, basename(dirname(dirname(dbPath))));
      assert.deepEqual(manifest.migrations, appliedMigrationIds);
      assert.equal(
        manifest.sha256,
        createHash("sha256")
          .update(readFileSync(join(first.directory, "db.sqlite")))
          .digest("hex"),
      );
      assert.ok(manifest.databaseBytes > 0);
      const copy = new DatabaseSync(join(first.directory, "db.sqlite"), { readOnly: true });
      try {
        const row = copy.prepare("pragma quick_check").get() as Record<string, unknown>;
        assert.equal(Object.values(row)[0], "ok");
      } finally {
        copy.close();
      }
      for (let index = 0; index < SESSION_DATABASE_BACKUP_RETENTION; index += 1) {
        backupSessionDatabaseBeforeMigration(db, dbPath, { backupRootDir, appliedMigrationIds });
      }
      // 目录名带毫秒时间 + 随机后缀，同一毫秒内也不会互相覆盖。
      const remaining = readdirSync(backupRootDir).filter((name) => name.startsWith("cli-"));
      assert.equal(remaining.length, SESSION_DATABASE_BACKUP_RETENTION);
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("⑥ 官方删除凭据在库时，写入抛可解释的 SESSION_DELETING 而不是触发器原文", async () => {
  const root = tempDir();
  const dbPath = join(root, "cli", "db", "db.sqlite");
  try {
    runMigrations(dbPath, { backupRootDir: join(root, "backup") });
    const targetSessionId = "sess_official_purging";
    const seeding = new DatabaseSync(dbPath);
    try {
      seeding
        .prepare(
          "insert into session_purge (session_id, root_id, operation_id, retained_artifacts, workspace_path, workspace_identity, state) values (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(targetSessionId, targetSessionId, "op-1", "[]", "/tmp/workspace", null, "deleting");
    } finally {
      seeding.close();
    }
    const store = createSqliteSessionStore({ dbPath, backupRootDir: join(root, "backup") });
    try {
      await assert.rejects(
        () => store.createSession(sessionInput(targetSessionId)),
        (error: unknown) => {
          const mapped = error as { code?: string; message?: string };
          // 稳定 code 让 UI 按 code 本地化（zcode.error.SESSION_DELETING）；触发器原文只留在 cause。
          assert.equal(mapped.code, SESSION_DELETING_ERROR_CODE);
          assert.match(mapped.message ?? "", /newer ZCode version/);
          assert.equal((mapped.message ?? "").includes("session-data.deleting"), false);
          return true;
        },
      );
      // 其他会话不受影响：守卫只换「正在删除」这一种失败。
      const created = await store.createSession(sessionInput("sess_unrelated"));
      assert.equal(created.id, "sess_unrelated");
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("⑦ 异步启动路径（openStartup，Desktop Host/CLI 带进度）同样迁到 0026 并报告 ready", async () => {
  const root = tempDir();
  const dbPath = join(root, "cli", "db", "db.sqlite");
  const backupRootDir = join(root, "backup");
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
    const phases: string[] = [];
    const store = await SqliteSessionStore.openStartup(
      { dbPath, backupRootDir },
      { onProgress: async (progress) => void phases.push(progress.phase) },
    );
    try {
      assert.equal(store.debugMigrationIds().at(-1), "0026_dwf_run_parent_session_index");
    } finally {
      store.close();
    }
    assert.equal(phases.at(-1), "ready");
    assert.ok(phases.includes("migrating"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
