// 官方（更新版本）的彻底删除会在 session_purge 留下「删除凭据」，随后 0025 的 74 条触发器用
// raise(abort, 'session-data.deleting') 挡住对同一会话的所有写入。CE 没有删除流程，这些触发器
// 只会在「与官方共用 ~/.zcode」时被踩到；不处理的话用户看到的是 SQLite 触发器原文。
//
// 做法：在会话库连接的写语句边界（prepare 出来的 run / exec）把这条 ABORT 换成稳定 code +
// 可解释文案。选择语句边界而不是逐个 Repo 调用点，是因为触发器覆盖 session / message / part /
// todo / usage / dwf_* 等 20 多张表 —— 逐点包会漏；这里一次覆盖全部写入，读路径不受影响。
import type { DatabaseSync } from "node:sqlite";

/** SQLite 触发器 ABORT 的原文；只在识别时使用，绝不进入用户可见文案。 */
export const SESSION_DELETING_ABORT_MESSAGE = "session-data.deleting";
/** 稳定错误码：UI 按 `zcode.error.<code>` 本地化，不依赖 message 文本。 */
export const SESSION_DELETING_ERROR_CODE = "SESSION_DELETING";

// 只有写语句会触发 before insert/update 触发器；读语句保持原样，免得给读路径加包装开销。
const WRITE_STATEMENT = /^\s*(?:insert|update|delete|replace)\b/i;
const guardedDatabases = new WeakSet<object>();

export class SessionDeletingError extends Error {
  readonly code = SESSION_DELETING_ERROR_CODE;

  constructor(cause: unknown) {
    super(
      "This session is being deleted by a newer ZCode version, so this build will not write to it. " +
        "Open the session with that version, or let it finish deleting, then retry.",
      { cause },
    );
    this.name = "SessionDeletingError";
  }
}

export function isSessionDeletingAbort(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message.includes(SESSION_DELETING_ABORT_MESSAGE);
}

/** 只换「正在删除」这一种失败，其余 SQLite 错误原样抛出（调用方仍按原语义处理）。 */
export function translateSessionDeletingAbort(error: unknown): unknown {
  return isSessionDeletingAbort(error) ? new SessionDeletingError(error) : error;
}

/** 在连接上安装写边界守卫；重复调用是空操作。 */
export function guardSessionStoreWrites(db: DatabaseSync): void {
  if (guardedDatabases.has(db)) return;
  guardedDatabases.add(db);
  const prepare = db.prepare.bind(db);
  const exec = db.exec.bind(db);
  const statementPrototype = Object.getPrototypeOf(prepare("select 1")) as Record<string, unknown>;
  const runStatement = statementPrototype.run as (this: unknown, ...args: unknown[]) => unknown;
  Object.defineProperty(db, "prepare", {
    configurable: true,
    writable: true,
    value: (sql: string) => {
      const statement = prepare(sql);
      if (!WRITE_STATEMENT.test(sql)) return statement;
      Object.defineProperty(statement, "run", {
        configurable: true,
        writable: true,
        value: (...args: unknown[]) => {
          try {
            return runStatement.apply(statement, args);
          } catch (error) {
            throw translateSessionDeletingAbort(error);
          }
        },
      });
      return statement;
    },
  });
  Object.defineProperty(db, "exec", {
    configurable: true,
    writable: true,
    value: (sql: string) => {
      try {
        return exec(sql);
      } catch (error) {
        throw translateSessionDeletingAbort(error);
      }
    },
  });
}
