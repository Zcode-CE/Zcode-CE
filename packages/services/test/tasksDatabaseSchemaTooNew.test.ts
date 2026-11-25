import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { prepareTasksIndexStorage } from "../src/session/tasksDatabase/startup.js";

/**
 * 任务索引的 schema_too_new 守卫。
 *
 * 为什么必须单独钉住：官方任务索引会追加 0006/0007（本版只知道到 0005），CE 从官方切回时
 * 若静默在官方库上写，任务树两边可见集合漂移，且官方 task_purge 触发器的 ABORT 无 UX。
 * 守卫的判据与会话库同源（`@zcode/shared` 的 assertSchemaNotTooNew），但两条链各自有自己的
 * 账本表名与事务位置，漏接一条就等于没守。
 */

function tempDatabasePath(): { root: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "zcode-tasks-schema-"));
  return { root, dbPath: join(root, "tasks-index.sqlite") };
}

function ledgerIds(db: DatabaseSync): string[] {
  return db
    .prepare("select id from tasks_schema_migration order by id")
    .all()
    .map((row) => String(row.id));
}

function schemaDump(db: DatabaseSync): string[] {
  return db
    .prepare("select type, name, sql from sqlite_master order by type, name")
    .all()
    .map((row) => JSON.stringify(row));
}

function withDatabase<T>(dbPath: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbPath);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function migrate(dbPath: string): void {
  withDatabase(dbPath, (db) => {
    db.exec("pragma foreign_keys = on");
    runTasksDatabaseMigrations(db);
  });
}

function insertLedgerRow(dbPath: string, id: string): void {
  withDatabase(dbPath, (db) => {
    db.prepare(
      "insert into tasks_schema_migration (id, checksum, time_applied) values (?, ?, ?)",
    ).run(id, "unknown-checksum", Date.now());
  });
}

test("⑤ 任务索引账本出现更高未知 id ⇒ 抛 schema_too_new，且不执行任何版本 SQL", () => {
  const { root, dbPath } = tempDatabasePath();
  try {
    migrate(dbPath);
    insertLedgerRow(dbPath, "0006_task_groups");
    const before = withDatabase(dbPath, (db) => ({
      ids: ledgerIds(db),
      schema: schemaDump(db),
    }));
    assert.equal(before.ids.length, 6);
    assert.throws(
      () => migrate(dbPath),
      (error: unknown) => {
        const migrationError = error as { kind?: string; migrationId?: string };
        assert.equal(migrationError.kind, "schema_too_new");
        assert.equal(migrationError.migrationId, "0006_task_groups");
        return true;
      },
    );
    const after = withDatabase(dbPath, (db) => ({
      ids: ledgerIds(db),
      schema: schemaDump(db),
    }));
    assert.deepEqual(after.ids, before.ids);
    assert.deepEqual(after.schema, before.schema);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("⑤b 任务索引账本里是 ≤ 本版最大 id 的未知别名 ⇒ 放行，不误伤", () => {
  const { root, dbPath } = tempDatabasePath();
  try {
    migrate(dbPath);
    insertLedgerRow(dbPath, "0004_workspace_registry_alias");
    // 不抛错即通过：官方开发构建留下的别名行不能触发「库比程序新」。
    migrate(dbPath);
    const ids = withDatabase(dbPath, (db) => ledgerIds(db));
    assert.ok(ids.includes("0005_workspace_registry_active_session_count"));
    assert.ok(ids.includes("0004_workspace_registry_alias"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("⑤c 真实入口 prepareTasksIndexStorage 也把 schema_too_new 交给上游（Host 才能分类）", async () => {
  const { root, dbPath } = tempDatabasePath();
  try {
    await prepareTasksIndexStorage(dbPath, () => {});
    insertLedgerRow(dbPath, "0006_task_groups");
    await assert.rejects(
      () => prepareTasksIndexStorage(dbPath, () => {}),
      (error: unknown) => {
        const migrationError = error as { kind?: string; migrationId?: string };
        assert.equal(migrationError.kind, "schema_too_new");
        assert.equal(migrationError.migrationId, "0006_task_groups");
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
