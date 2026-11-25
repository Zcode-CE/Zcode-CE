// Modified by ZCode: 自上游 zai-org/ZCode v3.18.2 (fec97590, Apache-2.0) 并入本波数据完整性与
// 内容块顺序修复（会话行逐行降级 / blockIndex / 迁移 0023–0026 / schema_too_new 守卫）。
import type { DatabaseSync } from "node:sqlite";

/** 账本出现本版未知且更新的迁移行时的稳定错误类别；启动面板按码本地化，不读错误文案。 */
export const SCHEMA_TOO_NEW_ERROR_KIND = "schema_too_new" as const;

// 账本表名只来自代码常量；仍按白名单形状校验，避免把拼接出的表名送进 SQL。
const LEDGER_TABLE_NAME = /^[a-z][a-z0-9_]{0,63}$/;

export interface SqliteSchemaTooNewOptions {
  ledgerTable: string;
  knownMigrationIds: readonly string[];
  dbPath?: string;
}

export interface SqliteSchemaTooNewErrorOptions extends SqliteSchemaTooNewOptions {
  migrationId: string;
}

/**
 * 库由更新版本（含官方更高版本）写过时的拒绝写错误。
 *
 * 为什么要有它：CE 与官方共用 `~/.zcode`，旧版本遇到不认识的迁移只遍历自己的清单，
 * 于是在「不理解的结构」上继续写（软删会话复活、purge 凭据触发不透明 ABORT）。
 * 有了本错误，旧版本一律 fail-closed：不执行任何 DDL、不写一行账本，读写一起拒绝。
 */
export class SqliteSchemaTooNewError extends Error {
  readonly kind = SCHEMA_TOO_NEW_ERROR_KIND;
  readonly ledgerTable: string;
  readonly migrationId: string;
  readonly knownMigrationIds: readonly string[];

  constructor(options: SqliteSchemaTooNewErrorOptions) {
    const knownUpTo = maxMigrationId(options.knownMigrationIds) ?? "(none)";
    super(
      `SQLite schema is newer than this build: ${options.ledgerTable} has ${options.migrationId}, ` +
        `this build knows up to ${knownUpTo}. Open this database with a newer ZCode version; ` +
        `do not delete ${options.dbPath ?? "the database file"}.`,
    );
    this.name = "SqliteSchemaTooNewError";
    this.ledgerTable = options.ledgerTable;
    this.migrationId = options.migrationId;
    this.knownMigrationIds = [...options.knownMigrationIds];
  }
}

/** 迁移 id 是 `NNNN_name` 零填充，字符串序就是版本序；取最大即本版最高版本。 */
export function maxMigrationId(ids: readonly string[]): string | undefined {
  let max: string | undefined;
  for (const id of ids) if (max === undefined || id > max) max = id;
  return max;
}

/**
 * 找出「本版不认识且比本版最高版本还新」的账本行。
 *
 * 只拦更高 id：≤ 本版最大 id 的未知行必须放行（官方开发构建留下的别名，例如
 * `0020_session_soft_delete_outcome`），否则会误伤本来可以正常打开的库。
 */
export function findNewerUnknownMigrationId(
  appliedIds: readonly string[],
  knownMigrationIds: readonly string[],
): string | undefined {
  const known = new Set(knownMigrationIds);
  const maxKnown = maxMigrationId(knownMigrationIds);
  let newest: string | undefined;
  for (const id of appliedIds) {
    if (known.has(id)) continue;
    if (maxKnown !== undefined && id <= maxKnown) continue;
    if (newest === undefined || id > newest) newest = id;
  }
  return newest;
}

export function readMigrationLedgerIds(db: DatabaseSync, ledgerTable: string): string[] {
  if (!LEDGER_TABLE_NAME.test(ledgerTable))
    throw new Error(`Invalid SQLite migration ledger table: ${ledgerTable}`);
  const rows = db.prepare(`SELECT id FROM ${ledgerTable}`).all();
  const ids: string[] = [];
  for (const row of rows) {
    const id = (row as { id?: unknown }).id;
    if (typeof id === "string") ids.push(id);
  }
  return ids;
}

/**
 * 版本守卫：调用方必须已持有库级事务、账本表已存在、且尚未执行任何版本 DDL。
 * 失败时抛 SqliteSchemaTooNewError，由调用方 rollback ⇒ 等价于「没打开过」。
 */
export function assertSchemaNotTooNew(db: DatabaseSync, options: SqliteSchemaTooNewOptions): void {
  const migrationId = findNewerUnknownMigrationId(
    readMigrationLedgerIds(db, options.ledgerTable),
    options.knownMigrationIds,
  );
  if (migrationId) throw new SqliteSchemaTooNewError({ ...options, migrationId });
}
