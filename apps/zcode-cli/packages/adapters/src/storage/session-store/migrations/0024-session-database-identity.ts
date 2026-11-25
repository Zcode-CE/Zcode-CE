// Modified by ZCode: 自上游 zai-org/ZCode v3.18.2 (fec97590, Apache-2.0) 并入本波数据完整性与
// 内容块顺序修复（会话行逐行降级 / blockIndex / 迁移 0023–0026 / schema_too_new 守卫）。
// 0024 的 SQL 逐字节取自官方 `packages/shared/src/sqlite-migrations/legacy.ts`
// （SESSION_DATABASE_IDENTITY_MIGRATION）：checksum 参与共用账本，SQL 与 app_version 都冻结。
// 末条 SELECT 是为了让建表在同一 exec 里被读到，属官方原文，不要删。
export const SESSION_DATABASE_IDENTITY_MIGRATION_SQL = `
    CREATE TABLE IF NOT EXISTS zcode_database_identity (
      scope TEXT PRIMARY KEY,
      identity TEXT NOT NULL
    );
    SELECT scope, identity FROM zcode_database_identity WHERE 0;`;
