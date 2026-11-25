import { withFileLock } from "../node/privateFilePersistence.js";
import { isCredentialDecryptError } from "../oauth.js";
import type { CredentialCipher } from "./contract.js";
import { writeCredentialRecordLocked } from "./credentialFileState.js";
import { assertCredentialGeneration } from "./credentialGeneration.js";
import {
  captureCredentialRecoveryGuard,
  currentCredentialGeneration,
  withCredentialGenerationScope,
  type CredentialFileGuard,
} from "./credentialGenerationScope.js";
import {
  migrateCredentialRecord,
  readCredentialRecordWithMigration,
  type CredentialRecordTarget,
} from "./credentialRecordStore.js";

/**
 * 凭据批量读写（SPEC §7 的唯一变更入口）。
 *
 * 这一层只定义「读多键 / 整组条件写 / 条件删」的语义，不认识业务键名；Host 服务与 CLI 各自
 * 把键值校验叠在上层。四条不可协商的性质：
 * 1. CAS 是整组的：expected 里任一键不等就一个都不写、磁盘字节不变，返回 false 而不是抛错
 *    ——「别人先改了」是正常竞态，不是故障（SPEC §7.4）。
 * 2. 比较在锁内、解密后：期望值是明文；密文解不开按「不等」处理，密钥来源不可用则上抛
 *    （前者是数据问题可以等下一次修复，后者必须让调用方看见「存储坏了」）。
 * 3. 加密在领取代次之后、文件锁之外完成：主密钥可能来自系统凭据库，不能在锁内等它。
 * 4. 通知不在这里发：变更通知必须由调用方在锁外发送，否则监听器派生的后台任务会沿用本次
 *    代次并被误判为「基于旧存储」而拒绝写盘。
 */

/** 明文比较结果；UNREADABLE 代表「当前密文解不开」，按不相等处理。 */
const UNREADABLE = Symbol("credential-unreadable");

type ComparableValue = string | null | typeof UNREADABLE;

async function comparableValue(
  cipher: CredentialCipher,
  encrypted: string | undefined,
): Promise<ComparableValue> {
  if (encrypted === undefined) return null;
  try {
    return await cipher.decrypt(encrypted);
  } catch (error) {
    if (isCredentialDecryptError(error)) return UNREADABLE;
    throw error;
  }
}

async function expectedValuesMatch(
  cipher: CredentialCipher,
  record: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string | null>>,
): Promise<boolean> {
  for (const [key, wanted] of Object.entries(expected)) {
    const actual = await comparableValue(cipher, record[key]);
    if (actual === UNREADABLE || actual !== wanted) return false;
  }
  return true;
}

async function someValueUnreadable(
  cipher: CredentialCipher,
  record: Readonly<Record<string, string>>,
  keys: readonly string[],
): Promise<boolean> {
  for (const key of keys) {
    const encrypted = record[key];
    if (encrypted === undefined) continue;
    try {
      await cipher.decrypt(encrypted);
    } catch (error) {
      if (!isCredentialDecryptError(error)) throw error;
      return true;
    }
  }
  return false;
}

interface LockedRecord {
  /** 磁盘上的原样记录，用于写闸门区分「本次新产生的 os 密文」。 */
  current: Record<string, string>;
  /** 尽力迁移后的记录（迁移失败按原样），后续变更与写盘都用它。 */
  record: Record<string, string>;
  migrated: boolean;
}

/** 调用方须持有凭据文件锁：读整组记录并把旧格式值就地升级（不迁移不可解的值）。 */
async function readLocked(target: CredentialRecordTarget): Promise<LockedRecord> {
  const current = await target.read();
  const migrated = await migrateCredentialRecord(current, target.cipher);
  return { current, record: migrated ?? current, migrated: migrated !== null };
}

/**
 * 一次读多键（SPEC §7.1）。普通读取不取写锁：旧格式值由读时迁移在需要时进锁处理，
 * 读取前后代次校验负责拒绝「读到一半发生重置」的结果。
 *
 * 返回值里 null 只表示「键不存在」，空字符串表示「存在且值为空」——两者不能混用，
 * 否则调用方会把「已登出」误判成「登录了但值为空」。
 */
export async function loadManyCredentialValues(
  target: CredentialRecordTarget,
  keys: readonly string[],
): Promise<Record<string, string | null>> {
  const generation = await currentCredentialGeneration(target.filePath);
  const record = await readCredentialRecordWithMigration(target);
  // 读取期间发生过恢复/重置时，读到的可能已是被替换前的存储：拒绝旧结果，由调用方重试。
  await assertCredentialGeneration(target.filePath, generation);
  const result: Record<string, string | null> = {};
  for (const key of keys) {
    const encrypted = record[key];
    result[key] = encrypted === undefined ? null : await target.cipher.decrypt(encrypted);
  }
  return result;
}

export interface UpdateCredentialValuesOptions {
  /** 整组 CAS 期望值（明文；null = 必须不存在）。 */
  expected?: Readonly<Record<string, string | null>>;
  /** 锁内复核调用方前提（如 session revision 未变）；抛错即放弃本次提交且不写盘。 */
  assertCurrent?: () => void;
}

/**
 * 整组条件写（SPEC §7.1 updateMany）：expected 全部相等才应用 changes（null = 删除）。
 * 返回 false 表示 CAS 失败且未写盘（不是错误）；返回 true 表示已提交。
 */
export async function updateCredentialValuesMany(
  target: CredentialRecordTarget,
  changes: Readonly<Record<string, string | null>>,
  options: UpdateCredentialValuesOptions = {},
): Promise<boolean> {
  return await withCredentialGenerationScope(target.filePath, async () => {
    const expectedGeneration = await currentCredentialGeneration(target.filePath);
    const encrypted = await Promise.all(
      Object.entries(changes).map(
        async ([key, value]) =>
          [key, value === null ? null : await target.cipher.encrypt(value)] as const,
      ),
    );
    return await withFileLock(target.filePath, async () => {
      const { current, record, migrated } = await readLocked(target);
      if (!(await expectedValuesMatch(target.cipher, record, options.expected ?? {}))) return false;
      options.assertCurrent?.();
      for (const [key, value] of encrypted) {
        if (value === null) delete record[key];
        else record[key] = value;
      }
      // 没有变更且没有迁移时不必写盘：CAS 成功但磁盘内容不会变。
      if (encrypted.length === 0 && !migrated) return true;
      await writeCredentialRecordLocked(target.filePath, record, {
        previous: current,
        expectedGeneration,
        write: target.write,
      });
      return true;
    });
  });
}

export interface DeleteUnreadableCredentialOptions {
  /** 整组 CAS 期望值；不匹配则一个都不删（别人已经修好了就交给它）。 */
  expected?: Readonly<Record<string, string | null>>;
  /** 成功提交时一并删除的键，默认就是 keys。 */
  removeKeys?: readonly string[];
  /** 成功提交时写入的明文替换值（如重新下发的 JWT）。 */
  replacements?: Readonly<Record<string, string>>;
}

/**
 * 只清理「锁内仍解不开」的键（SPEC §7.1 deleteUnreadable）。
 * 返回本次提交受影响（删除 + 替换）的去重键集合；null 表示没有提交（CAS 不匹配，或
 * 锁内复核时这些键已经可读）。
 */
export async function deleteUnreadableCredentialValues(
  target: CredentialRecordTarget,
  keys: readonly string[],
  options: DeleteUnreadableCredentialOptions = {},
): Promise<readonly string[] | null> {
  return await withCredentialGenerationScope(target.filePath, async () => {
    const expectedGeneration = await currentCredentialGeneration(target.filePath);
    const removals = options.removeKeys ?? keys;
    const encryptedReplacements = await Promise.all(
      Object.entries(options.replacements ?? {}).map(
        async ([key, value]) => [key, await target.cipher.encrypt(value)] as const,
      ),
    );
    return await withFileLock(target.filePath, async () => {
      const { current, record } = await readLocked(target);
      if (!(await expectedValuesMatch(target.cipher, record, options.expected ?? {}))) return null;
      // 只有 keys 里仍有解不开的值才提交；已被别的进程修好时保持磁盘不变。
      if (!(await someValueUnreadable(target.cipher, record, keys))) return null;
      for (const key of removals) delete record[key];
      for (const [key, value] of encryptedReplacements) record[key] = value;
      await writeCredentialRecordLocked(target.filePath, record, {
        previous: current,
        expectedGeneration,
        write: target.write,
      });
      return [...new Set([...removals, ...encryptedReplacements.map(([key]) => key)])];
    });
  });
}

export interface SaveIfAbsentResult {
  /** 提交后该键的实际明文值（可能是先写入者的值）。 */
  value: string;
  /** true = 本次写入；false = 已存在，返回的是现有值（此时不得再发变更通知）。 */
  written: boolean;
}

/**
 * 锁内「没有才写」，返回最终值（SPEC §7.1 saveIfAbsent）。
 * 多 Host 并发时收敛到先写入者：后到者读到已存在的值就原样返回，不覆盖。
 * 已存在但解不开时抛 ZCODE_CREDENTIAL_DECRYPT_FAILED —— 无法确认现有值时不能假装
 * 「不存在」去覆盖，否则会把另一个进程刚写的条目当成自己的。
 */
export async function saveCredentialValueIfAbsent(
  target: CredentialRecordTarget,
  key: string,
  value: string,
): Promise<SaveIfAbsentResult> {
  return await withCredentialGenerationScope(target.filePath, async () => {
    const expectedGeneration = await currentCredentialGeneration(target.filePath);
    // 先加密再进锁：主密钥可能来自系统凭据库，不能在锁内等它。竞争失败只是白加密一次，
    // 比让其他进程排在慢密钥后端后面等锁便宜。
    const encrypted = await target.cipher.encrypt(value);
    return await withFileLock(target.filePath, async () => {
      const { current, record } = await readLocked(target);
      const existing = record[key];
      if (existing !== undefined) {
        return { value: await target.cipher.decrypt(existing), written: false };
      }
      record[key] = encrypted;
      await writeCredentialRecordLocked(target.filePath, record, {
        previous: current,
        expectedGeneration,
        write: target.write,
      });
      return { value, written: true };
    });
  });
}

/**
 * 锁内比较后删除，只删仍等于 expected 的值（SPEC §7.1 deleteIfEquals）。
 * 解不开的值按「不等于」处理：无法证明相等就不能删，调用方可下次重试。
 */
export async function deleteCredentialValueIfEquals(
  target: CredentialRecordTarget,
  key: string,
  expected: string,
): Promise<boolean> {
  return await withCredentialGenerationScope(target.filePath, async () => {
    const expectedGeneration = await currentCredentialGeneration(target.filePath);
    return await withFileLock(target.filePath, async () => {
      const { current, record } = await readLocked(target);
      const existing = record[key];
      if (existing === undefined) return false;
      let plain: string;
      try {
        plain = await target.cipher.decrypt(existing);
      } catch (error) {
        if (isCredentialDecryptError(error)) return false;
        throw error;
      }
      if (plain !== expected) return false;
      delete record[key];
      await writeCredentialRecordLocked(target.filePath, record, {
        previous: current,
        expectedGeneration,
        write: target.write,
      });
      return true;
    });
  });
}

export interface RecoverUnreadableResult {
  /** 修复后该键的值；null = 键不存在，或原本不可读、已在锁内删除。 */
  value: string | null;
  /** true = 本次删除了一个不可读的键（调用方据此发恢复通知）。 */
  removed: boolean;
}

/**
 * 读取并修复单个不可读键（SPEC §7.1 recoverUnreadable）。
 * assertCurrent 在锁内执行：调用方用它复核「本次恢复仍是最新一次」，抛错即不写盘。
 * 可读时只返回值、不动盘；不可读时删掉该键并返回 null —— 留着它会让每次登录读取都失败。
 */
export async function recoverUnreadableCredentialValue(
  target: CredentialRecordTarget,
  key: string,
  assertCurrent: () => void,
): Promise<RecoverUnreadableResult> {
  return await withCredentialGenerationScope(target.filePath, async () => {
    const expectedGeneration = await currentCredentialGeneration(target.filePath);
    return await withFileLock(target.filePath, async () => {
      assertCurrent();
      const { current, record } = await readLocked(target);
      const existing = record[key];
      if (existing === undefined) return { value: null, removed: false };
      try {
        return { value: await target.cipher.decrypt(existing), removed: false };
      } catch (error) {
        if (!isCredentialDecryptError(error)) throw error;
      }
      assertCurrent();
      delete record[key];
      await writeCredentialRecordLocked(target.filePath, record, {
        previous: current,
        expectedGeneration,
        write: target.write,
      });
      return { value: null, removed: true };
    });
  });
}

/** 把读-改-写包成代次作用域（SPEC §7.1 captureRecoveryGuard）；登录等长事务的入口。 */
export async function captureCredentialGuard(
  target: CredentialRecordTarget,
): Promise<CredentialFileGuard> {
  return await captureCredentialRecoveryGuard(target.filePath);
}
