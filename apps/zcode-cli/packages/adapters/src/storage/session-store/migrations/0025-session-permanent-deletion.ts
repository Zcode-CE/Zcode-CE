// Modified by ZCode: 自上游 zai-org/ZCode v3.18.2 (fec97590, Apache-2.0) 并入本波数据完整性与
// 内容块顺序修复（会话行逐行降级 / blockIndex / 迁移 0023–0026 / schema_too_new 守卫）。
// 0025 建 session_purge / session_runtime_presence 两张表与 74 条触发器：触发器用
// raise(abort, 'session-data.deleting') 在「官方正在彻底删除某会话」时挡住写入。
// SQL 由数组模板拼出、与官方 4.0.0 逐字节一致（缩进、顺序、换行都在 checksum 里）。
// SQL 内 time_deleted / last_outcome 0 命中 ⇒ 补它不需要引入软删语义。
// 幂等性只能靠 apply：裸 SQL 重跑抛 table session_purge already exists。
import type { DatabaseSync } from "node:sqlite";

export const SESSION_PERMANENT_DELETION_MIGRATION_SQL = `
      create table session_purge (
        session_id text primary key,
        root_id text not null,
        operation_id text not null,
        retained_artifacts text not null,
        workspace_path text not null,
        workspace_identity text,
        state text not null check(state in ('deleting', 'deleted'))
      );
      create index session_purge_root_idx on session_purge(root_id);
      create table session_runtime_presence (
        session_id text not null,
        owner_id text not null,
        process_id integer not null,
        primary key(session_id, owner_id)
      );
      create trigger session_purge_insert_guard before insert on session
      when exists(select 1 from session_purge where session_id=new.id)
      begin select raise(abort, 'session-data.deleting'); end;
      create trigger session_purge_child_guard before insert on session
      when exists(select 1 from session_purge where session_id=new.parent_id)
      begin select raise(abort, 'session-data.deleting'); end;
      create trigger session_purge_update_guard before update on session
      when exists(select 1 from session_purge where session_id=new.id or (new.parent_id is not old.parent_id and session_id=new.parent_id))
      begin select raise(abort, 'session-data.deleting'); end;
      ${["insert", "update"]
        .map(
          (action) => `
        create trigger session_purge_link_${action} before ${action} on session_task_link
        when ${action === "update" ? "(new.parent_session_id is not old.parent_session_id or new.child_session_id is not old.child_session_id) and new.parent_session_id is not null and" : ""} exists(select 1 from session_purge where session_id=new.parent_session_id or session_id=new.child_session_id)
        begin select raise(abort, 'session-data.deleting'); end;
      `,
        )
        .join("\n")}
      create trigger session_purge_runtime_guard before insert on session_runtime_presence
      when exists(select 1 from session_purge where session_id=new.session_id)
      begin select raise(abort, 'session-data.deleting'); end;
      ${[
        "message",
        "part",
        "session_input",
        "session_entry",
        "todo",
        "model_usage",
        "session_target",
        "turn_usage",
        "tool_usage",
        "input_history",
      ]
        .flatMap((table) =>
          ["insert", "update"].map(
            (action) => `
        create trigger session_purge_${table}_${action} before ${action} on ${table}
        when exists(select 1 from session_purge where session_id=new.session_id)
        begin select raise(abort, 'session-data.deleting'); end;
      `,
          ),
        )
        .join("\n")}
      ${["dwf_run", "workflow_run"]
        .flatMap((table) =>
          ["insert", "update"].map(
            (action) => `
        create trigger session_purge_owner_${table}_${action} before ${action} on ${table}
        when new.parent_session_id is not null and exists(select 1 from session_purge where session_id=new.parent_session_id)
        begin select raise(abort, 'session-data.deleting'); end;
      `,
          ),
        )
        .join("\n")}
      ${[
        ["dwf_run", "args_json"],
        ["dwf_run", "result_json"],
        ["dwf_run", "failure_json"],
        ["workflow_run", "args_json"],
        ["workflow_run", "stats_json"],
        ["workflow_run", "failure_json"],
        ["dwf_node", "input_json"],
        ["dwf_node", "result_json"],
        ["dwf_node", "error_json"],
        ["dwf_event", "payload_json"],
        ["dwf_actor", "persona_json"],
        ["workflow_activity", "prompt"],
        ["workflow_activity", "opts_json"],
        ["workflow_activity", "result_json"],
        ["workflow_activity", "error_json"],
        ["workflow_event", "payload_json"],
        ["part", "data"],
        ["message", "data"],
        ["session_entry", "data"],
        ["session_input", "payload"],
        ["session", "revert"],
        ["input_history", "attachments"],
      ]
        .flatMap(([table, column]) =>
          ["insert", "update"].map(
            (action) => `
        create trigger session_purge_reference_${table}_${column}_${action} before ${action}${action === "update" ? ` of ${column}` : ""} on ${table}
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.${column}, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      `,
          ),
        )
        .join("\n")}`;

export function applySessionPermanentDeletionMigration(db: DatabaseSync): void {
  // 结构已存在但迁移未记账时，只补缺失对象，保留删除凭据和现有触发器。
  // 原 SQL 已发布且参与 checksum，守卫仅用于执行，避免已升级数据库校验失败。
  db.exec(
    SESSION_PERMANENT_DELETION_MIGRATION_SQL.replaceAll(
      /create (table|index|trigger) /g,
      "create $1 if not exists ",
    ),
  );
}
