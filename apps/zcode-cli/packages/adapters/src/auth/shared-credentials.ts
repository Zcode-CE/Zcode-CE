import { atomicWritePrivateTextFile } from "@zcode/shared/node";
import {
  captureCredentialGeneration,
  createSystemCredentialCipher,
  deleteUnreadableCredentialValues,
  mutateCredentialRecordLocked,
  readCredentialRecordWithMigration,
  recoverUnreadableCredentialValue,
  updateCredentialValuesMany,
  type CredentialCipher,
  type CredentialRecordTarget,
  type DeleteUnreadableCredentialOptions,
} from "@zcode/shared/credential-security";
import {
  readRawCredentialRecord,
  resolveSharedZCodeCredentialsPath,
  type SharedZCodeCredentialsPathOptions,
} from "./shared-credentials-file.js";

// 公开面保持不变：`auth/index.ts` 按 export * 转出，调用方仍从本模块取路径解析。
export { resolveSharedZCodeCredentialsPath } from "./shared-credentials-file.js";

const ZAI_PROVIDER_ID = "zai";
const credentialChangeListeners = new Map<string, Set<() => void | Promise<void>>>();

export const SHARED_ZCODE_CREDENTIAL_KEYS = {
  activeProvider: "oauth:active_provider",
  bigmodelAccessToken: "oauth:bigmodel:access_token",
  bigmodelRefreshToken: "oauth:bigmodel:refresh_token",
  bigmodelUserInfo: "oauth:bigmodel:user_info",
  zaiAccessToken: "oauth:zai:access_token",
  zaiRefreshToken: "oauth:zai:refresh_token",
  zaiUserInfo: "oauth:zai:user_info",
  zcodeJwtToken: "zcodejwttoken",
  /**
   * OAuth 会话版本键：与 Host 侧同名同义（SPEC §7.3）。Host 每次 OAuth 提交都在同一批次里轮换它；
   * CLI store 提供 updateMany 的整组 CAS 以便按同一代次提交，登出时它随共享键一起被清掉。
   */
  sessionRevision: "oauth:session_revision",
} as const;

export interface SharedZCodeCredentialStoreOptions extends SharedZCodeCredentialsPathOptions {
  cipher?: CredentialCipher;
}

/** deleteUnreadable 的选项：与 Host 侧 DeleteUnreadableOptions 同义（SPEC §7.1）。 */
export type SharedDeleteUnreadableOptions = DeleteUnreadableCredentialOptions;

/** updateMany 的整组 CAS 选项（与 Host 侧 UpdateManyOptions 同义，SPEC §7.1）。 */
export interface SharedCredentialUpdateOptions {
  /** 整组期望值（明文；null = 必须不存在）。任一键不等就一个都不写。 */
  expected?: Readonly<Record<string, string | null>>;
  /** 锁内复核调用方前提；抛错即放弃提交且不写盘。 */
  assertCurrent?: () => void;
}

export interface SharedZCodeCredentialStore {
  readonly filePath: string;
  clearZaiLoginCredentials(): Promise<void>;
  delete(key: string): Promise<void>;
  deleteIfValue(key: string, expectedValue: string): Promise<boolean>;
  deleteIfValues(
    expectedValues: Readonly<Record<string, string>>,
  ): Promise<Record<string, boolean>>;
  deleteManyIfValue(
    guardKey: string,
    expectedGuardValue: string,
    keysToDelete: readonly string[],
  ): Promise<boolean>;
  /**
   * 只清理锁内仍解不开的键（SPEC §7.1 deleteUnreadable）：可读的键不删，
   * 另一进程已修好时返回 false 且不写盘；true = 本次提交了删除或替换并已发一次通知。
   */
  deleteUnreadable(
    keys: readonly string[],
    options?: SharedDeleteUnreadableOptions,
  ): Promise<boolean>;
  load(key: string): Promise<string | null>;
  loadMany(keys: readonly string[]): Promise<Record<string, string | null>>;
  onDidChange?(listener: () => void | Promise<void>): () => void;
  /** 读取并修复单个不可读键；assertCurrent 在锁内复核调用方前提，抛错即不写盘。 */
  recoverUnreadable(key: string, assertCurrent: () => void): Promise<string | null>;
  save(key: string, value: string): Promise<void>;
  saveMany(entries: Readonly<Record<string, string>>): Promise<void>;
  saveReplacing(key: string, value: string, replacedKeys: readonly string[]): Promise<void>;
  /**
   * 整组条件写：expected 全部相等才应用 changes（null = 删除该键）。
   * 返回 false = CAS 失败且未写盘（正常竞态，不抛错）；true = 已提交并发一次变更通知。
   */
  updateMany(
    changes: Readonly<Record<string, string | null>>,
    options?: SharedCredentialUpdateOptions,
  ): Promise<boolean>;
}

export function createSharedZCodeCredentialStore(
  options: SharedZCodeCredentialStoreOptions = {},
): SharedZCodeCredentialStore {
  const env = options.env ?? process.env;
  const filePath = resolveSharedZCodeCredentialsPath(options);
  // 与 Desktop Host 共用同一份凭据文件；密钥来源与格式必须由同一实现决定，
  // 否则 Get/Copy 两侧会各写一种密文，另一半读者只能读到密文本身。
  const cipher = options.cipher ?? createSystemCredentialCipher({ filePath, env });
  const recordTarget: CredentialRecordTarget = {
    filePath,
    cipher,
    read: () => readRawCredentialRecord(filePath),
    write: (record) => atomicWritePrivateTextFile(filePath, `${JSON.stringify(record, null, 2)}\n`),
  };

  /**
   * 变更通知（锁外发送）：同进程的 Registry Source 需要在登录返回前观察到新凭据；
   * 单个监听者失败不应把已经原子落盘的 Credential 伪装成写入失败。
   */
  const notifyChangeListeners = async (): Promise<void> => {
    const listeners = [...(credentialChangeListeners.get(filePath) ?? [])];
    await Promise.allSettled(listeners.map((listener) => listener()));
  };

  /**
   * 变更入口：锁内读 →（可选）迁移 → 变更 → 写闸门 → 原子写；通知在锁外发送。
   * 纯删除路径不迁移：密钥不可用时登出仍必须成功（否则用户连退出都做不到）。
   */
  const mutate = async (
    mutation: (value: Record<string, string>) => void | Promise<void>,
    settings: { migrate?: boolean; expectedGeneration?: number } = {},
  ): Promise<void> => {
    await mutateCredentialRecordLocked(recordTarget, { ...settings, mutation });
    await notifyChangeListeners();
  };

  /** 加密前领代次：锁内写盘时复核，跨恢复/重置的在途写不会被当成新值覆盖。 */
  const encryptWithGeneration = async (
    entries: Readonly<Record<string, string>>,
  ): Promise<{ generation: number; encrypted: Record<string, string> }> => {
    const generation = await captureCredentialGeneration(filePath);
    const encrypted = Object.fromEntries(
      await Promise.all(
        Object.entries(entries).map(
          async ([key, value]) => [key, await cipher.encrypt(value)] as const,
        ),
      ),
    );
    return { generation, encrypted };
  };

  return {
    filePath,

    async clearZaiLoginCredentials(): Promise<void> {
      await mutate(async (rawCredentials) => {
        const activeProviderRaw = rawCredentials[SHARED_ZCODE_CREDENTIAL_KEYS.activeProvider];
        const activeProvider = activeProviderRaw ? await cipher.decrypt(activeProviderRaw) : null;
        delete rawCredentials[SHARED_ZCODE_CREDENTIAL_KEYS.zaiAccessToken];
        delete rawCredentials[SHARED_ZCODE_CREDENTIAL_KEYS.zaiRefreshToken];
        delete rawCredentials[SHARED_ZCODE_CREDENTIAL_KEYS.zaiUserInfo];
        delete rawCredentials[SHARED_ZCODE_CREDENTIAL_KEYS.zcodeJwtToken];
        if (activeProvider === ZAI_PROVIDER_ID) {
          delete rawCredentials[SHARED_ZCODE_CREDENTIAL_KEYS.activeProvider];
        }
      });
    },

    async delete(key: string): Promise<void> {
      const validatedKey = validateCredentialKey(key);
      await mutate((rawCredentials) => {
        delete rawCredentials[validatedKey];
      });
    },

    async deleteIfValue(key: string, expectedValue: string): Promise<boolean> {
      const validatedKey = validateCredentialKey(key);
      const validatedExpectedValue = validateCredentialValue(expectedValue);
      let deleted = false;
      await mutate(async (rawCredentials) => {
        const encryptedValue = rawCredentials[validatedKey];
        if (
          encryptedValue === undefined ||
          (await cipher.decrypt(encryptedValue)) !== validatedExpectedValue
        ) {
          return;
        }
        delete rawCredentials[validatedKey];
        deleted = true;
      });
      return deleted;
    },

    async deleteIfValues(
      expectedValues: Readonly<Record<string, string>>,
    ): Promise<Record<string, boolean>> {
      const validatedEntries = Object.entries(expectedValues).map(
        ([key, value]) => [validateCredentialKey(key), validateCredentialValue(value)] as const,
      );
      if (validatedEntries.length === 0) return {};
      const deleted: Record<string, boolean> = {};
      await mutate(async (rawCredentials) => {
        for (const [key, expectedValue] of validatedEntries) {
          const encryptedValue = rawCredentials[key];
          const matches =
            encryptedValue !== undefined &&
            (await cipher.decrypt(encryptedValue)) === expectedValue;
          deleted[key] = matches;
          if (matches) delete rawCredentials[key];
        }
      });
      return deleted;
    },

    /**
     * 条件事务：`guardKey` 当前值与期望值相等才删除 `keysToDelete` 全部 key，否则一个都不删。
     *
     * `deleteIfValues` 是逐 key 比较、逐 key 删除，无法表达「canonical generation 匹配
     * 才整体失效」——canonical 比较失败时 legacy 镜像仍可能被删掉，反之亦然。OAuth 凭据失效必须
     * 是整对的：stale 事务不能删掉 winner 的 canonical，也不能只删掉它的一半镜像。
     */
    async deleteManyIfValue(
      guardKey: string,
      expectedGuardValue: string,
      keysToDelete: readonly string[],
    ): Promise<boolean> {
      const validatedGuardKey = validateCredentialKey(guardKey);
      const validatedExpectedValue = validateCredentialValue(expectedGuardValue);
      const validatedKeys = keysToDelete.map(validateCredentialKey);
      let deleted = false;
      await mutate(async (rawCredentials) => {
        const encryptedGuard = rawCredentials[validatedGuardKey];
        if (
          encryptedGuard === undefined ||
          (await cipher.decrypt(encryptedGuard)) !== validatedExpectedValue
        ) {
          return;
        }
        for (const key of validatedKeys) delete rawCredentials[key];
        deleted = true;
      });
      return deleted;
    },

    /**
     * 批量清理不可读密文：共享层在锁内逐键解密复检，这里只做键值校验与一次通知。
     * 读侧一旦遇到解不开的值（如账号连接组）就能删掉它再继续，不必整组永久失败。
     */
    async deleteUnreadable(
      keys: readonly string[],
      options: SharedDeleteUnreadableOptions = {},
    ): Promise<boolean> {
      const affected = await deleteUnreadableCredentialValues(
        recordTarget,
        keys.map(validateCredentialKey),
        {
          expected:
            options.expected === undefined
              ? undefined
              : validateCredentialChanges(options.expected),
          removeKeys: options.removeKeys?.map(validateCredentialKey),
          replacements:
            options.replacements === undefined
              ? undefined
              : validateCredentialValues(options.replacements),
        },
      );
      if (affected === null) return false;
      await notifyChangeListeners();
      return true;
    },

    async load(key: string): Promise<string | null> {
      const rawCredentials = await readCredentialRecordWithMigration(recordTarget);
      const rawValue = rawCredentials[validateCredentialKey(key)];
      if (rawValue === undefined) {
        return null;
      }
      return await cipher.decrypt(rawValue);
    },

    async loadMany(keys: readonly string[]): Promise<Record<string, string | null>> {
      const validatedKeys = keys.map(validateCredentialKey);
      const rawCredentials = await readCredentialRecordWithMigration(recordTarget);
      return Object.fromEntries(
        await Promise.all(
          validatedKeys.map(async (key) => {
            const rawValue = rawCredentials[key];
            return [key, rawValue === undefined ? null : await cipher.decrypt(rawValue)] as const;
          }),
        ),
      );
    },

    onDidChange(listener: () => void | Promise<void>): () => void {
      let listeners = credentialChangeListeners.get(filePath);
      if (!listeners) {
        listeners = new Set();
        credentialChangeListeners.set(filePath, listeners);
      }
      listeners.add(listener);
      return () => {
        listeners?.delete(listener);
        if (listeners?.size === 0) credentialChangeListeners.delete(filePath);
      };
    },

    /**
     * 单键恢复：可读时只返回原值不动盘，不可读时删掉该键并返回 null。
     * assertCurrent 由共享层在锁内执行两次（读后与删除前），前提失效即不写盘。
     */
    async recoverUnreadable(key: string, assertCurrent: () => void): Promise<string | null> {
      const result = await recoverUnreadableCredentialValue(
        recordTarget,
        validateCredentialKey(key),
        assertCurrent,
      );
      if (result.removed) await notifyChangeListeners();
      return result.value;
    },

    async save(key: string, value: string): Promise<void> {
      const validatedKey = validateCredentialKey(key);
      const { generation, encrypted } = await encryptWithGeneration({
        [validatedKey]: validateCredentialValue(value),
      });
      await mutate(
        (rawCredentials) => {
          rawCredentials[validatedKey] = encrypted[validatedKey]!;
        },
        { migrate: true, expectedGeneration: generation },
      );
    },

    async saveMany(entries: Readonly<Record<string, string>>): Promise<void> {
      const validatedEntries = Object.fromEntries(
        Object.entries(entries).map(([key, value]) => [
          validateCredentialKey(key),
          validateCredentialValue(value),
        ]),
      );
      const { generation, encrypted } = await encryptWithGeneration(validatedEntries);
      await mutate(
        (rawCredentials) => {
          for (const [key, encryptedValue] of Object.entries(encrypted)) {
            rawCredentials[key] = encryptedValue;
          }
        },
        { migrate: true, expectedGeneration: generation },
      );
    },

    async saveReplacing(
      key: string,
      value: string,
      replacedKeys: readonly string[],
    ): Promise<void> {
      const validatedKey = validateCredentialKey(key);
      const validatedReplacedKeys = replacedKeys.map(validateCredentialKey);
      const { generation, encrypted } = await encryptWithGeneration({
        [validatedKey]: validateCredentialValue(value),
      });
      await mutate(
        (rawCredentials) => {
          rawCredentials[validatedKey] = encrypted[validatedKey]!;
          for (const replacedKey of validatedReplacedKeys) {
            if (replacedKey !== validatedKey) delete rawCredentials[replacedKey];
          }
        },
        { migrate: true, expectedGeneration: generation },
      );
    },

    /**
     * 整组条件写（SPEC §7.1 updateMany）：读写语义只在共享层实现（CAS、代次闸门、锁序），
     * 这里只做键值校验与一次变更通知。返回 false 表示 CAS 失败且未写盘，不是错误。
     */
    async updateMany(
      changes: Readonly<Record<string, string | null>>,
      options: SharedCredentialUpdateOptions = {},
    ): Promise<boolean> {
      const validatedChanges = validateCredentialChanges(changes);
      const committed = await updateCredentialValuesMany(recordTarget, validatedChanges, {
        expected:
          options.expected === undefined ? undefined : validateCredentialChanges(options.expected),
        assertCurrent: options.assertCurrent,
      });
      if (committed && Object.keys(validatedChanges).length > 0) {
        await notifyChangeListeners();
      }
      return committed;
    },
  };
}

function validateCredentialKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length === 0) {
    throw new Error("Credential key must not be empty");
  }
  return trimmed;
}

function validateCredentialValue(value: string): string {
  if (value.length === 0) {
    throw new Error("Credential value must not be empty");
  }
  return value;
}

/** 替换值与写入值共用同一套非空校验；键名同样 trim。 */
function validateCredentialValues(
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      validateCredentialKey(key),
      validateCredentialValue(value),
    ]),
  );
}

/** 变更/期望值共用同一套校验；null 保留为「必须不存在 / 删除」，不是空值。 */
function validateCredentialChanges(
  changes: Readonly<Record<string, string | null>>,
): Record<string, string | null> {
  return Object.fromEntries(
    Object.entries(changes).map(([key, value]) => [
      validateCredentialKey(key),
      value === null ? null : validateCredentialValue(value),
    ]),
  );
}
