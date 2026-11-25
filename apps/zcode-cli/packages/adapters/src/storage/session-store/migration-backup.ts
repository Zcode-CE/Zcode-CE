// 迁移前的文件级备份。
//
// 为什么需要：迁移整链在一个 `begin immediate` 里，失败会 rollback（库不变），但「迁移成功之后
// 才发现语义不对」（例如官方把库升到更高版本、CE 写坏理解不了的结构）只能靠备份回到旧文件。
// 为什么不搬官方 shared 的表级备份：那套要做行级哈希 + restore + 给 26 条迁移都标 touchedTables，
// 会把 CLI 启动编排整体改写；这里先解决「升级前留一份可自检的文件副本」。
//
// 顺序（必须发生在拿写锁之前）：checkpoint → 复制 → 写 manifest → quick_check 自检 → 按份数清理。
// manifest 最后写：没有 manifest 的目录视为半成品，清理时不删、启动时也不认。
import { ZCODE_VERSION } from "@zcode/shared";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, parse, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteSessionMigrationError } from "./errors.js";

/** 保留最近几份备份；旧的按 manifest 自清理。 */
export const SESSION_DATABASE_BACKUP_RETENTION = 2;
export const DEFAULT_SESSION_DATABASE_BACKUP_ROOT = join(homedir(), ".zcode", "backup");

const BACKUP_FILE_NAME = "db.sqlite";
const BACKUP_MANIFEST_NAME = "manifest.json";
const BACKUP_MANIFEST_SCHEMA_VERSION = 1;

export type SessionDatabaseBackupSkipReason =
  | "memory_database"
  | "missing_source_file"
  | "insufficient_space";

export type SessionDatabaseBackupOutcome =
  | { kind: "created"; directory: string; bytes: number }
  | { kind: "skipped"; reason: SessionDatabaseBackupSkipReason };

export interface SessionDatabaseBackupOptions {
  backupRootDir?: string;
  /** 备份时刻的账本内容，写进 manifest 供恢复时对照。 */
  appliedMigrationIds: readonly string[];
}

interface SessionDatabaseBackupManifest {
  schemaVersion: number;
  tool: "zcode-ce";
  toolVersion: string;
  reason: "pre_migration";
  createdAt: string;
  databaseLabel: string;
  databasePath: string;
  databaseBytes: number;
  sha256: string;
  migrations: readonly string[];
}

/**
 * 复制会话库文件并自检；失败按 IO/权限阻断迁移，磁盘满只跳过（不静默）。
 *
 * 调用方必须已确认「本次运行真的要改结构」（预检 kind=upgrade）且尚未 begin immediate。
 */
export function backupSessionDatabaseBeforeMigration(
  db: DatabaseSync,
  dbPath: string,
  options: SessionDatabaseBackupOptions,
): SessionDatabaseBackupOutcome {
  if (dbPath === ":memory:") return { kind: "skipped", reason: "memory_database" };
  if (!existsSync(dbPath) || statSync(dbPath).size === 0)
    return { kind: "skipped", reason: "missing_source_file" };

  const backupRootDir = options.backupRootDir ?? DEFAULT_SESSION_DATABASE_BACKUP_ROOT;
  const databaseLabel = resolveBackupLabel(dbPath);
  const sourcePath = resolve(dbPath);
  // 目录名带毫秒时间 + 随机后缀：同名冲突会互相覆盖，而备份是「没有第二份就没了」的东西。
  const directory = join(
    backupRootDir,
    `${databaseLabel}-${backupTimestamp(new Date())}-${randomUUID().slice(0, 8)}`,
  );
  const backupPath = join(directory, BACKUP_FILE_NAME);
  let created = false;
  try {
    // WAL 下只有 checkpoint 之后的主库文件才是完整快照；checkpoint 失败时主库仍是
    // 一个自洽的旧快照（新提交还在 -wal 里），因此只做尽力而为，不因它阻断。
    checkpointIfWal(db);
    mkdirSync(directory, { recursive: true });
    created = true;
    copyFileSync(dbPath, backupPath);
    const bytes = statSync(backupPath).size;
    if (bytes === 0) throw new Error(`Session database backup is empty: ${backupPath}`);
    const sha256 = createHash("sha256").update(readFileSync(backupPath)).digest("hex");
    // 备份必须自己能被打开、且 quick_check 通过，否则它是假的恢复手段。
    verifyBackupDatabase(backupPath);
    const manifest: SessionDatabaseBackupManifest = {
      schemaVersion: BACKUP_MANIFEST_SCHEMA_VERSION,
      tool: "zcode-ce",
      toolVersion: ZCODE_VERSION,
      reason: "pre_migration",
      createdAt: new Date().toISOString(),
      databaseLabel,
      databasePath: sourcePath,
      databaseBytes: bytes,
      sha256,
      migrations: [...options.appliedMigrationIds],
    };
    writeFileSync(join(directory, BACKUP_MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
    pruneSessionDatabaseBackups(backupRootDir, databaseLabel, sourcePath);
    return { kind: "created", directory, bytes };
  } catch (error) {
    // 半成品目录不能留在备份根里冒充可用备份。
    if (created) removeBackupDirectory(directory);
    if (isStorageFullError(error)) return { kind: "skipped", reason: "insufficient_space" };
    throw new SqliteSessionMigrationError(
      `Failed to back up SQLite session database to ${directory}`,
      {
        cause: error,
        dbPath,
        kind: isPermissionError(error) ? "permission_denied" : "io_error",
      },
    );
  }
}

/** 恢复演练/诊断用：解析某份备份的 manifest，缺文件或格式不符返回 undefined。 */
export function readSessionDatabaseBackupManifest(
  directory: string,
): SessionDatabaseBackupManifest | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(join(directory, BACKUP_MANIFEST_NAME), "utf8"),
    ) as Partial<SessionDatabaseBackupManifest>;
    return parsed.schemaVersion === BACKUP_MANIFEST_SCHEMA_VERSION &&
      typeof parsed.databaseLabel === "string" &&
      typeof parsed.databasePath === "string" &&
      typeof parsed.sha256 === "string"
      ? (parsed as SessionDatabaseBackupManifest)
      : undefined;
  } catch {
    return undefined;
  }
}

function checkpointIfWal(db: DatabaseSync): void {
  try {
    const mode = db.prepare("pragma journal_mode").get() as { journal_mode?: unknown } | undefined;
    if (typeof mode?.journal_mode !== "string" || mode.journal_mode.toLowerCase() !== "wal") return;
    db.exec("pragma wal_checkpoint(truncate)");
  } catch {
    // 其他连接正在读时 checkpoint 会忙；此时主库文件仍是自洽的旧快照，继续复制。
  }
}

function verifyBackupDatabase(backupPath: string): void {
  const copy = new DatabaseSync(backupPath, { readOnly: true });
  try {
    const row = copy.prepare("pragma quick_check").get() as Record<string, unknown> | undefined;
    const result = row ? Object.values(row)[0] : undefined;
    if (result !== "ok")
      throw new Error(`Session database backup failed quick_check: ${String(result)}`);
  } finally {
    copy.close();
  }
}

/**
 * 只清理「本模块生成、manifest 完整、且记录的是同一个库」的目录。
 * 清理失败不影响迁移：多留几份旧备份，比因为删不掉而启动失败好。
 */
function pruneSessionDatabaseBackups(
  backupRootDir: string,
  databaseLabel: string,
  dbPath: string,
): void {
  let names: string[];
  try {
    names = readdirSync(backupRootDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${databaseLabel}-`))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return;
  }
  // 目录名以 ISO 时间结尾：升序里最前面的是最旧的，只保留最后 N 份。
  for (const name of names.slice(
    0,
    Math.max(0, names.length - SESSION_DATABASE_BACKUP_RETENTION),
  )) {
    const directory = join(backupRootDir, name);
    const manifest = readSessionDatabaseBackupManifest(directory);
    if (
      !manifest ||
      manifest.databaseLabel !== databaseLabel ||
      resolve(manifest.databasePath) !== dbPath
    )
      continue;
    removeBackupDirectory(directory);
  }
}

function removeBackupDirectory(directory: string): void {
  try {
    rmSync(directory, { force: true, recursive: true });
  } catch {
    // 保留目录只会多占空间，不影响迁移正确性。
  }
}

/** 目录名形如 `cli-2026-11-25T11-40-00-000Z`：取库目录的上一级（cli）作为标签。 */
function resolveBackupLabel(dbPath: string): string {
  const scope = basename(dirname(dirname(dbPath)));
  const label =
    scope && scope !== "." && scope !== parse(dbPath).root
      ? scope
      : basename(dbPath, extname(dbPath));
  return label.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "database";
}

function backupTimestamp(date: Date): string {
  // Windows 不允许文件名里的冒号；ISO 时间换成 `-` 后仍可按字典序排序。
  return date.toISOString().replace(/[:.]/g, "-");
}

function readErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function isStorageFullError(error: unknown): boolean {
  const code = readErrorCode(error);
  return code === "ENOSPC" || code === "EDQUOT";
}

function isPermissionError(error: unknown): boolean {
  const code = readErrorCode(error);
  return code === "EACCES" || code === "EPERM";
}
