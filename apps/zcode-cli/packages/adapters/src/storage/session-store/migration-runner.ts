// Modified by ZCode: 自上游 zai-org/ZCode v3.18.2 (fec97590, Apache-2.0) 并入本波数据完整性与
// 内容块顺序修复（会话行逐行降级 / blockIndex / 迁移 0023–0026 / schema_too_new 守卫）。
import {
  assertSchemaNotTooNew,
  classifyDatabaseStartupError,
  databaseMigrationIdSchema,
  databaseStartupErrorDetails,
  SqliteSchemaTooNewError,
  type DatabaseMigrationFacts,
} from "@zcode/shared";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { SqliteSessionMigrationError } from "./errors.js";
import {
  backupSessionDatabaseBeforeMigration,
  type SessionDatabaseBackupOutcome,
} from "./migration-backup.js";
import { SQLITE_MIGRATIONS } from "./migrations.js";
import type { SchemaMigrationRow } from "./rows.js";

const SCHEMA_MIGRATION_LEDGER_TABLE = "schema_migration";
const KNOWN_MIGRATION_IDS = SQLITE_MIGRATIONS.map((migration) => migration.id);

export const DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS = 5_000;

const SQLITE_BUSY = 5;
const WAL_RETRY_INITIAL_DELAY_MS = 10;
const WAL_RETRY_MAX_DELAY_MS = 200;
const waitBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export type SqliteMigrationPhase =
  | "checking"
  | "waiting_for_lock"
  | "migrating"
  | "committing"
  | "ready"
  | "failed";

export interface SqliteMigrationProgress {
  phase: SqliteMigrationPhase;
  migration?: DatabaseMigrationFacts;
  elapsedMs: number;
  migrationId?: string;
  completed?: number;
  total?: number;
  errorCode?: string;
  sqliteCode?: number;
  systemCode?: string;
}

export interface SqliteSessionMigrationRunOptions {
  /** 备份根目录；生产用 `~/.zcode/backup`，测试与桌面 Host 可覆盖。 */
  backupRootDir?: string;
  /** 备份结果回调：本模块不做日志，由调用方决定 warn / 启动面板提示。 */
  onBackupOutcome?: (outcome: SessionDatabaseBackupOutcome) => void;
}

export interface AsyncSqliteMigrationOptions extends SqliteSessionMigrationRunOptions {
  lockWaitTimeoutMs?: number;
  onProgress?: (progress: SqliteMigrationProgress) => Promise<void>;
}

const DEFAULT_SQLITE_MIGRATION_WAIT_MS = 60 * 60_000;
const ASYNC_NATIVE_BUSY_TIMEOUT_MS = 25;
type MigrationStep = SqliteMigrationProgress | { delayMs: number };

export function runSqliteSessionMigrations(
  db: DatabaseSync,
  dbPath: string,
  lockTimeoutMs = DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS,
  runOptions: SqliteSessionMigrationRunOptions = {},
): void {
  for (const step of migrationSteps(db, dbPath, lockTimeoutMs, runOptions)) {
    if ("delayMs" in step) waitSync(step.delayMs);
  }
}

export async function runSqliteSessionMigrationsAsync(
  db: DatabaseSync,
  dbPath: string,
  options: AsyncSqliteMigrationOptions = {},
): Promise<void> {
  // 同步 SQLite 仅短暂等待一次；真正的启动等待让出事件循环，通知可以先 flush。
  // 业务连接不能继承升级的一小时等待预算。迁移结束（含失败）恢复原有 5 秒策略。
  db.exec(`pragma busy_timeout = ${ASYNC_NATIVE_BUSY_TIMEOUT_MS}`);
  const steps = migrationSteps(
    db,
    dbPath,
    options.lockWaitTimeoutMs ?? DEFAULT_SQLITE_MIGRATION_WAIT_MS,
    options,
  );
  let failed = false;
  try {
    for (const step of steps) {
      if ("delayMs" in step)
        await new Promise<void>((resolve) => setTimeout(resolve, step.delayMs));
      else if (step.phase === "failed") {
        try {
          await options.onProgress?.(step);
        } catch {
          /* 错误通知失败不能覆盖原数据库异常。 */
        }
      } else await options.onProgress?.(step);
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // 通知传输失败也会关闭 generator 的事务，不能将半迁移连接交给业务。
    try {
      steps.return();
      db.exec(`pragma busy_timeout = ${DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS}`);
    } catch (error) {
      if (!failed) throw error;
    }
  }
}

function* migrationSteps(
  db: DatabaseSync,
  dbPath: string,
  lockTimeoutMs: number,
  runOptions: SqliteSessionMigrationRunOptions,
): Generator<MigrationStep, void> {
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(0, lockTimeoutMs);
  let migrationFacts: DatabaseMigrationFacts | undefined;
  const progress = (phase: SqliteMigrationPhase): SqliteMigrationProgress => ({
    phase,
    elapsedMs: Date.now() - startedAt,
    ...(migrationFacts ? { migration: { ...migrationFacts } } : {}),
  });
  let transactionStarted = false;
  function* acquire(operation: () => void): Generator<MigrationStep, void> {
    // 每个拿锁阶段独立报告：预检前的未知等待不能吞掉确认迁移后的等待。
    let waitingReported = false;
    let retryDelayMs = WAL_RETRY_INITIAL_DELAY_MS;
    while (true) {
      try {
        operation();
        return;
      } catch (error) {
        // SQLITE_LOCKED 常指同连接/共享缓存冲突；只重试外部写者竞争的 SQLITE_BUSY。
        if (!isSqliteBusyError(error)) throw error;
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) throw lockTimeoutError(error, dbPath);
        if (!waitingReported) {
          waitingReported = true;
          yield progress("waiting_for_lock");
        }
        yield { delayMs: Math.min(remainingMs, retryDelayMs) };
        retryDelayMs = Math.min(WAL_RETRY_MAX_DELAY_MS, retryDelayMs * 2);
      }
    }
  }
  try {
    yield progress("checking");
    db.exec("pragma foreign_keys = on");
    yield* acquire(() => {
      const current = readJournalMode(db);
      if (current === "wal" || isMemoryJournalMode(dbPath, current)) return;
      const mode = readJournalMode(db, true);
      if (mode !== "wal" && !isMemoryJournalMode(dbPath, mode)) {
        throw new SqliteSessionMigrationError(
          `SQLite refused WAL journal mode for ${dbPath}; received ${mode}`,
          { dbPath, kind: "sql_failed" },
        );
      }
    });
    // 预检只决定展示；真正执行仍在拿锁后逐项核对，其他窗口完成后不会重复迁移。
    yield* acquire(() => {
      migrationFacts = {
        kind: inspectMigrationKind(db, dbPath),
        executedCount: 0,
        committedCount: 0,
      };
    });
    yield progress("checking");
    // 升级前留一份文件级备份：整链回滚只保护「SQL 失败」，保护不了「迁完之后语义不对」。
    // 新建空库没有可丢的数据、已是最新库也没有可改的结构，都不复制文件（避免每次启动
    // 复制多 GB 会话库）。备份拿锁之前做，不占写锁。
    if (migrationFacts?.kind === "upgrade") {
      const outcome = backupSessionDatabaseBeforeMigration(db, dbPath, {
        backupRootDir: runOptions.backupRootDir,
        appliedMigrationIds: appliedMigrationIds(db),
      });
      // 通知失败不能覆盖备份结果，也不能阻断迁移（磁盘满只跳过、由调用方提示）。
      try {
        runOptions.onBackupOutcome?.(outcome);
      } catch {
        /* 日志/面板通道的问题不是数据库问题。 */
      }
    }
    // SQLite 是唯一协调者；拿锁后读取真实账本，等待者不会重复迁移已提交项。
    yield* acquire(() => db.exec("begin immediate"));
    transactionStarted = true;
    db.exec(`create table if not exists schema_migration (
      id text primary key, checksum text not null, app_version text, time_applied integer not null
    )`);
    // 版本守卫：账本出现「本版不认识且比本版最高版本还新」的行 ⇒ 库由更新版本写过。
    // 位置在拿锁之后、任何版本 DDL 之前；抛错即 rollback，等价于「没打开过」，读写一起拒绝。
    // ≤ 本版最高版本 id 的未知行必须放行（官方开发构建的别名），否则会误伤本来能用的库。
    assertSchemaNotTooNew(db, {
      ledgerTable: SCHEMA_MIGRATION_LEDGER_TABLE,
      knownMigrationIds: KNOWN_MIGRATION_IDS,
      dbPath,
    });
    // 拿锁后记录起点，避免预检时其他写者尚未提交；后续迁移不得覆盖它。
    const baseline = db.prepare("SELECT id FROM schema_migration ORDER BY id DESC LIMIT 1").get();
    if (migrationFacts)
      migrationFacts.lastAppliedMigrationId = baseline
        ? databaseMigrationIdSchema.safeParse(baseline.id).data
        : null;
    let completed = 0;
    for (const migration of SQLITE_MIGRATIONS) {
      try {
        const checksum = migrationChecksum(migration.sql);
        const applied = readAppliedMigration(db, migration.id);
        if (applied) {
          ensureMigrationChecksum(migration.id, applied.checksum, checksum, dbPath);
          completed++;
          continue;
        }
        // 预检后出现新待执行项时，以锁内账本为准提升种类，不能带 none 执行 SQL。
        if (migrationFacts?.kind === "none") migrationFacts.kind = "upgrade";
        yield {
          ...progress("migrating"),
          migrationId: migration.id,
          completed,
          total: SQLITE_MIGRATIONS.length,
        };
        // 本 hotfix 只调整启动等待；执行与账本校验共用冻结原 SQL，避免维护两套转换语义。
        // 已发布的 0023/0025 只能靠 apply 做到可重入：改写 SQL 会改 checksum（共用账本）。
        if (migration.apply) migration.apply(db);
        else db.exec(migration.sql);
        if (migrationFacts) migrationFacts.executedCount++;
        db.prepare(
          "insert into schema_migration (id, checksum, app_version, time_applied) values (?, ?, ?, ?)",
        ).run(migration.id, checksum, migration.appVersion, Date.now());
        completed++;
      } catch (error) {
        throw normalizeMigrationError(error, dbPath, migration.id);
      }
    }
    yield progress("committing");
    db.exec("commit");
    transactionStarted = false;
    if (migrationFacts) migrationFacts.committedCount = migrationFacts.executedCount;
    yield progress("ready");
  } catch (error) {
    // 先回滚，再通知失败；通知不能让业务看到仍在事务内的 failed。
    if (transactionStarted && db.isTransaction) {
      try {
        db.exec("rollback");
      } catch {
        /* 关闭连接时恢复，保留原始异常。 */
      }
    }
    transactionStarted = false;
    const normalized = normalizeMigrationError(error, dbPath);
    yield {
      ...progress("failed"),
      errorCode: normalized.kind,
      ...databaseStartupErrorDetails(normalized),
      migrationId: normalized.migrationId,
    };
    throw normalized;
  } finally {
    if (transactionStarted && db.isTransaction) {
      try {
        db.exec("rollback");
      } catch {
        /* 调用方关闭连接，保留原始异常。 */
      }
    }
  }
}

function isSqliteBusyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "errcode" in error &&
    typeof error.errcode === "number" &&
    (error.errcode & 0xff) === SQLITE_BUSY
  );
}

function isMemoryJournalMode(dbPath: string, journalMode: string): boolean {
  return dbPath === ":memory:" && journalMode === "memory";
}

function readJournalMode(db: DatabaseSync, enableWal = false): string {
  const row = db.prepare(enableWal ? "pragma journal_mode = wal" : "pragma journal_mode").get() as
    | Record<string, unknown>
    | undefined;
  const mode = row?.journal_mode;
  return typeof mode === "string" ? mode.toLowerCase() : "unknown";
}

function waitSync(delayMs: number): void {
  Atomics.wait(waitBuffer, 0, 0, Math.max(1, Math.ceil(delayMs)));
}

function normalizeMigrationError(
  error: unknown,
  dbPath: string,
  migrationId?: string,
): SqliteSessionMigrationError {
  if (error instanceof SqliteSessionMigrationError) return error;
  if (isSqliteBusyError(error)) return lockTimeoutError(error, dbPath, migrationId);
  return new SqliteSessionMigrationError(
    migrationId
      ? `SQLite migration ${migrationId} failed for ${dbPath}`
      : `SQLite migration initialization failed for ${dbPath}`,
    {
      cause: error,
      dbPath,
      kind: classifyDatabaseStartupError(error),
      // 版本守卫在逐条迁移之前抛错，越界的那条未知 id 只能从错误本身取，
      // 否则失败进度里不会带出「是哪条未来迁移把库升上去的」。
      migrationId:
        migrationId ?? (error instanceof SqliteSchemaTooNewError ? error.migrationId : undefined),
    },
  );
}

function lockTimeoutError(
  cause: unknown,
  dbPath: string,
  migrationId?: string,
): SqliteSessionMigrationError {
  return new SqliteSessionMigrationError(
    `Timed out waiting for SQLite migration lock at ${dbPath}`,
    { cause, dbPath, kind: "lock_timeout", migrationId },
  );
}

/** 备份 manifest 里记录的「迁移前账本」：只读 id，不扫描业务表。 */
function appliedMigrationIds(db: DatabaseSync): string[] {
  const rows = db.prepare("SELECT id FROM schema_migration ORDER BY id").all();
  const ids: string[] = [];
  for (const row of rows) if (typeof row.id === "string") ids.push(row.id);
  return ids;
}

function readAppliedMigration(db: DatabaseSync, id: string): SchemaMigrationRow | undefined {
  return db.prepare("select id, checksum from schema_migration where id = ?").get(id) as
    | SchemaMigrationRow
    | undefined;
}

function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql.trim()).digest("hex");
}

function ensureMigrationChecksum(
  id: string,
  applied: string,
  current: string,
  dbPath: string,
): void {
  if (applied === current) return;
  throw new SqliteSessionMigrationError(
    `SQLite migration checksum mismatch for ${id}. Historical migrations are immutable; add a new migration instead.`,
    {
      dbPath,
      kind: "checksum_mismatch",
      migrationId: id,
    },
  );
}

/** 只读小型迁移账本，不扫描消息表；存在表但无账本的历史库属于升级。 */
function inspectMigrationKind(db: DatabaseSync, dbPath: string): DatabaseMigrationFacts["kind"] {
  const hasLedger = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migration'")
    .get();
  let pending = false;
  for (const migration of SQLITE_MIGRATIONS) {
    const row = hasLedger ? readAppliedMigration(db, migration.id) : undefined;
    if (row)
      ensureMigrationChecksum(migration.id, row.checksum, migrationChecksum(migration.sql), dbPath);
    else pending = true;
  }
  if (!pending) return "none";
  const hasDataTables = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT IN ('schema_migration', 'sqlite_sequence') LIMIT 1",
    )
    .get();
  return hasDataTables ? "upgrade" : "initialize";
}
