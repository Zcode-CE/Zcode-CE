import { randomUUID } from "node:crypto";
import { OAUTH_SESSION_REVISION_KEY, type LocalCredentialService } from "./credential.js";

/**
 * OAuth 会话版本轮换的最小原语（SPEC §7.3）。
 *
 * 版本值只要求「与上一版不同」，不用时间戳：同一毫秒内的两个进程会生成相同时间戳，
 * 而撞版本值会让跨进程登录竞争「看起来没有发生」，后到的旧结果就会覆盖新登录。
 */
export function createCredentialSessionRevision(): string {
  return randomUUID();
}

export interface CommitCredentialSessionChangeOptions {
  /** 锁内复核调用方前提（如「本次登录仍是最新一次」）；抛错即放弃提交且不写盘。 */
  assertCurrent?: () => void;
}

/**
 * 一次带版本轮换的 CAS 提交（登录、刷新、切号、登出、关联补齐、恢复都走它）。
 *
 * snapshot 是变更开始时 loadMany 读到的明文快照（含版本键）。任何键不匹配就返回 false
 * 且不写盘 —— 说明另一进程已经提交过新的登录，本次结果必须丢弃并按当前存储重新读取。
 * 成功提交时版本键必然轮换，使别的进程手里那份旧快照在下一次提交时必定失败。
 * changes 里若也带版本键，以本函数的轮换值为准。
 */
export async function commitCredentialSessionChange(
  service: Pick<LocalCredentialService, "updateMany">,
  snapshot: Readonly<Record<string, string | null>>,
  changes: Readonly<Record<string, string | null>>,
  options: CommitCredentialSessionChangeOptions = {},
): Promise<boolean> {
  return await service.updateMany(
    { ...changes, [OAUTH_SESSION_REVISION_KEY]: createCredentialSessionRevision() },
    options.assertCurrent === undefined
      ? { expected: snapshot }
      : { expected: snapshot, assertCurrent: options.assertCurrent },
  );
}
