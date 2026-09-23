// 0004 workspace_registry：服务端持有的「可见工作区」唯一真相源（docs/development/workspace-registry.md）。
// 只增不改：不改既有表，仅新增表与索引；由 runTasksDatabaseMigrations 统一执行与 checksum 校验。
export const WORKSPACE_REGISTRY_MIGRATION_SQL = `
  CREATE TABLE IF NOT EXISTS workspace_registry (
    workspace_key TEXT PRIMARY KEY,
    workspace_path TEXT NOT NULL,
    workspace_identity TEXT,
    first_seen_at INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL,
    session_count INTEGER NOT NULL DEFAULT 0,
    sources TEXT NOT NULL DEFAULT '[]'
  );

  CREATE INDEX IF NOT EXISTS idx_workspace_registry_activity
  ON workspace_registry (last_activity_at DESC);
`;
