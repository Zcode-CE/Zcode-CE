import { withFileLock } from "../node/privateFilePersistence.js";
import { CREDENTIAL_DECRYPT_ERROR_CODE } from "../oauth.js";
import type { CredentialCipher } from "./contract.js";
import { needsCredentialMigration, writeCredentialRecordLocked } from "./credentialFileState.js";
import { isCredentialStorageUnavailableError } from "./credentialFailure.js";

/** 两个读者（CLI store 与 Host 凭据服务）共用的凭据容器读写口。 */
export interface CredentialRecordTarget {
  filePath: string;
  cipher: CredentialCipher;
  /** 读取整组记录（含容器格式校验）；损坏时抛错，由调用方保留既有恢复流程。 */
  read(): Promise<Record<string, string>>;
  /** 原子写整组记录（通常为 atomicWritePrivateTextFile）。 */
  write(record: Record<string, string>): Promise<void>;
}

/**
 * 调用方须在既有凭据文件锁内读、迁移和写；不会修改传入对象，失败时不产生半份迁移。
 *
 * 四条硬规则：整组或零（失败不写盘）、混合容器先验密钥、单条解不开不阻断、
 * 不迁移不可解的值也不删除任何条目（损坏条目留给 P2 的恢复流程）。
 */
export async function migrateCredentialRecord(
  record: Readonly<Record<string, string>>,
  cipher: CredentialCipher,
): Promise<Record<string, string> | null> {
  const needsMigration = cipher.needsMigration;
  if (!needsMigration) return null;
  if (!Object.values(record).some((value) => needsMigration(value))) return null;
  // 混合新旧容器先验证已有新格式的密钥来源；不能迁移一半后才发现原密钥不可用。
  for (const value of Object.values(record)) {
    if (needsMigration(value)) continue;
    try {
      await cipher.decrypt(value);
    } catch (error) {
      if ((error as { code?: unknown })?.code !== CREDENTIAL_DECRYPT_ERROR_CODE) throw error;
    }
  }
  const next = { ...record };
  let changed = false;
  for (const [key, value] of Object.entries(record)) {
    if (!needsMigration(value)) continue;
    let plain: string;
    try {
      plain = await cipher.decrypt(value);
    } catch (error) {
      if ((error as { code?: unknown })?.code === CREDENTIAL_DECRYPT_ERROR_CODE) continue;
      throw error;
    }
    next[key] = await cipher.encrypt(plain);
    changed = true;
  }
  return changed ? next : null;
}

/**
 * 读整组记录并把旧格式值就地升级为 v2。
 *
 * 锁外先读一遍：绝大多数访问没有旧格式，没必要为一次读取去争写锁（慢写入会让登录读取
 * 一直等锁超时）。只有确实存在需要迁移的值才进锁内重读+迁移+写盘，避免用旧快照覆盖
 * 其他进程刚写入的键。
 *
 * 迁移遇到「密钥存储不可用」时回退为未迁移记录：读取本不该因为另一个键的密钥缺失而
 * 整体失败（迁移是机会性的，不迁移不等于降级到弱密钥）。其余错误照常上抛。
 */
export async function readCredentialRecordWithMigration(
  target: CredentialRecordTarget,
): Promise<Record<string, string>> {
  const initial = await target.read();
  if (!Object.values(initial).some((value) => needsCredentialMigration(value))) return initial;
  return await withFileLock(target.filePath, async () => {
    const current = await target.read();
    let migrated: Record<string, string> | null;
    try {
      migrated = await migrateCredentialRecord(current, target.cipher);
    } catch (error) {
      if (isCredentialStorageUnavailableError(error)) return current;
      throw error;
    }
    if (!migrated) return current;
    await writeCredentialRecordLocked(target.filePath, migrated, {
      previous: current,
      write: target.write,
    });
    return migrated;
  });
}

export interface MutateCredentialRecordOptions {
  /** 加密前领取的存储代次；锁内不一致即拒绝写盘。 */
  expectedGeneration?: number;
  /** 写入前是否把整组旧格式值一并升级（纯删除路径可关闭，否则坏密钥会让登出也失败）。 */
  migrate?: boolean;
  mutation(record: Record<string, string>): void | Promise<void>;
}

/**
 * 凭据容器的唯一变更入口：锁内读 → （可选）迁移 → 变更 → 闸门校验 → 原子写。
 *
 * 变更通知必须由调用方在锁外发送：监听器常会启动后台任务，若沿用本次代次，
 * 那些任务会被误判为「基于旧存储」而拒绝写盘。
 */
export async function mutateCredentialRecordLocked(
  target: CredentialRecordTarget,
  options: MutateCredentialRecordOptions,
): Promise<void> {
  await withFileLock(target.filePath, async () => {
    const current = await target.read();
    const record =
      options.migrate === true
        ? ((await migrateCredentialRecord(current, target.cipher)) ?? current)
        : current;
    await options.mutation(record);
    await writeCredentialRecordLocked(target.filePath, record, {
      previous: current,
      expectedGeneration: options.expectedGeneration,
      write: target.write,
    });
  });
}
