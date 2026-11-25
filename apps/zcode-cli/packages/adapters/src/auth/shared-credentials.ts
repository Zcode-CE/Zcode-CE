import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { atomicWritePrivateTextFile, backupCorruptFile } from "@zcode/shared/node";
import {
  captureCredentialGeneration,
  createSystemCredentialCipher,
  mutateCredentialRecordLocked,
  readCredentialRecordWithMigration,
  resolveCredentialsFilePath,
  resolveCredentialsFilePathIn,
  updateCredentialValuesMany,
  type CredentialCipher,
  type CredentialRecordTarget,
} from "@zcode/shared/credential-security";

const ZAI_PROVIDER_ID = "zai";
const credentialChangeListeners = new Map<
  string,
  Set<() => void | Promise<void>>
>();

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

export interface SharedZCodeCredentialStoreOptions {
  baseDir?: string;
  cipher?: CredentialCipher;
  env?: Record<string, string | undefined>;
  filePath?: string;
}

export interface ZaiLoginCredentialUser {
  avatar?: string;
  email?: string;
  name?: string;
  user_id: string;
}

export interface ZaiLoginCredentialPayload {
  accessToken: string;
  jwtToken: string;
  user: ZaiLoginCredentialUser;
}

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
  load(key: string): Promise<string | null>;
  loadMany(keys: readonly string[]): Promise<Record<string, string | null>>;
  onDidChange?(listener: () => void | Promise<void>): () => void;
  save(key: string, value: string): Promise<void>;
  saveMany(entries: Readonly<Record<string, string>>): Promise<void>;
  saveReplacing(key: string, value: string, replacedKeys: readonly string[]): Promise<void>;
  saveZaiLoginCredentials(payload: ZaiLoginCredentialPayload): Promise<void>;
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

    async saveZaiLoginCredentials(payload: ZaiLoginCredentialPayload): Promise<void> {
      const { generation, encrypted } = await encryptWithGeneration({
        [SHARED_ZCODE_CREDENTIAL_KEYS.activeProvider]: ZAI_PROVIDER_ID,
        [SHARED_ZCODE_CREDENTIAL_KEYS.zaiAccessToken]: validateCredentialValue(payload.accessToken),
        [SHARED_ZCODE_CREDENTIAL_KEYS.zcodeJwtToken]: validateCredentialValue(payload.jwtToken),
        [SHARED_ZCODE_CREDENTIAL_KEYS.zaiUserInfo]: JSON.stringify(payload.user),
      });
      await mutate(
        (rawCredentials) => {
          for (const [key, encryptedValue] of Object.entries(encrypted)) {
            rawCredentials[key] = encryptedValue;
          }
        },
        { migrate: true, expectedGeneration: generation },
      );
    },
  };
}

/**
 * 凭据文件路径：与 Host 的服务端解析共用同一条规则（`ZCODE_DATA_BASE_DIR` trim 后 > `HOME` >
 * `homedir()`）。系统密钥条目按该绝对路径命名，两侧路径一旦分叉就会给同一文件造两把密钥，
 * 一半密文永久解不开。
 */
export function resolveSharedZCodeCredentialsPath(
  options: SharedZCodeCredentialStoreOptions = {},
): string {
  if (options.filePath) {
    return resolveUserPath(options.filePath);
  }
  if (options.baseDir !== undefined) {
    return resolveCredentialsFilePathIn(resolveUserPath(options.baseDir));
  }
  return resolveCredentialsFilePath(options.env ?? process.env);
}

async function readRawCredentialRecord(filePath: string): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return {};
    }
    throw new Error(`Unable to read shared ZCode credentials: ${filePath}`, { cause: error });
  }

  try {
    return parseCredentialRecord(JSON.parse(raw));
  } catch (error) {
    // 损坏的凭据文件若被当成空对象继续保存，会一次性抹掉其他进程的全部凭据。
    // 先保留现场再失败，调用方必须显式处理恢复，不能静默覆盖。
    const backupPath = await backupCorruptFile(filePath).catch(() => undefined);
    const evidence = backupPath ? ` Backup: ${backupPath}` : "";
    throw new Error(`Shared ZCode credentials are corrupt: ${filePath}.${evidence}`, {
      cause: error,
    });
  }
}

function parseCredentialRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    throw new Error("Credential record must be an object");
  }

  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new Error(`Credential record value must be a string: ${key}`);
    }
    result[key] = entry;
  }
  return result;
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
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

function resolveUserPath(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }
  return resolve(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
