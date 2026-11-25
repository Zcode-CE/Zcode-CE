// Modified by ZCode: 自上游 zai-org/ZCode v3.18.2 (fec97590, Apache-2.0) 并入本波数据完整性与
// 内容块顺序修复（会话行逐行降级 / blockIndex / 迁移 0023–0026 / schema_too_new 守卫）。
// 0026 是官方 4.0.0 唯一的新增：按父会话查完整活动历史需要该索引，缺它同步扫描其他
// 会话的 run 与 actor。纯索引、if not exists ⇒ 不需要 apply。
export const DWF_RUN_PARENT_SESSION_INDEX_MIGRATION_SQL = `create index if not exists dwf_run_parent_session_idx on dwf_run(parent_session_id);`;
