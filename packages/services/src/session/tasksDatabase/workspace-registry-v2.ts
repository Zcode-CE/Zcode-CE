// 0005 workspace_registry 增加「未归档会话数」列（active_session_count）。
//
// 为什么必须新增一列而不是改 0004：0004 已发布，它的 checksum 冻结在用户库里，
// 改动会让所有已升级用户卡在 checksum mismatch（migrations.ts 的 runner 会直接抛错）。
// 同时 0004 的 session_count 语义（不过滤 archived）是有意设计 —— 保证「只有归档任务」
// 的 workspace 也在注册表里（见 workspaceRegistryRepo.ts 顶部注释）；本迁移只新增一个口径，
// 不触碰旧列的语义。
//
// 背景缺陷：侧栏只显示未归档会话，而注册表只报 session_count（含归档），
// 于是出现「说已有 N 个会话、点开是空的」。新列让 UI 能如实报「点开后能看到几个」。
//
// 兼容策略（老库已有 0004，升级后不得丢数据、不得卡启动）：
//  1. 只 ADD COLUMN，不改既有列、不重建表；SQLite 的 ADD COLUMN 是纯元数据变更，既有行数据不动。
//  2. 新列声明 NOT NULL DEFAULT 0 —— 老库既有行自动取 0，这里不做历史值回填：
//     注册表由服务端自己写入，随后的枚举 upsert 会用 tasks 表的真实计数覆盖它
//     （repo 的 upsert 语义是「同 key 取最大值」）。因此 0 表示「尚未计算」，不是「确实没有会话」；
//     这条前提由 workspaceRegistryRepo 的 upsert 保证（该处有对应的幂等测试）。
//  3. 不加索引：该列只用于列表展示，注册表总量在几十条量级，索引没有收益。
export const WORKSPACE_REGISTRY_ACTIVE_SESSION_COUNT_MIGRATION_SQL = `
  ALTER TABLE workspace_registry ADD COLUMN active_session_count INTEGER NOT NULL DEFAULT 0;
`;
