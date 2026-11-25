// Modified by ZCode: 自上游 zai-org/ZCode v3.18.2 (fec97590, Apache-2.0) 并入本波数据完整性与
// 内容块顺序修复（会话行逐行降级 / blockIndex / 迁移 0023–0026 / schema_too_new 守卫）。
// 0023 只加两列可空列（软删时间与末次结果）。CE 本轮不引入软删语义，两列保持 NULL；
// 补结构是为了让账本与官方 3.18+/4.0 互认：跳过它 CE 库会长期落后，官方打开时再补。
// 幂等性只能靠 apply：两条裸 alter 不可重入（重跑抛 duplicate column name: time_deleted），
// 而改写 SQL 会改 checksum（sha256(sql.trim())）⇒ 官方库打开时报 checksum_mismatch。
import type { DatabaseSync } from "node:sqlite";

export const SESSION_SOFT_DELETE_OUTCOME_MIGRATION_SQL = `
      alter table session add column time_deleted integer;
      alter table session add column last_outcome text;`;

export function applySessionSoftDeleteOutcomeMigration(db: DatabaseSync): void {
  // 半结构（列已在、账本未记账）时只补缺的列，保留既有数据与时间戳。
  const columns = new Set(
    db
      .prepare("pragma table_info(session)")
      .all()
      .map((row) => String(row.name)),
  );
  if (!columns.has("time_deleted")) db.exec("alter table session add column time_deleted integer");
  if (!columns.has("last_outcome")) db.exec("alter table session add column last_outcome text");
}
