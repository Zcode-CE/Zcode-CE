import { readFile } from "node:fs/promises";
import { atomicWritePrivateTextFile, backupCorruptFile } from "@zcode/shared/node";
import {
  credentialKeySchema,
  credentialRecordSchema,
  credentialValueSchema,
  formatZodError,
} from "@zcode/shared";
import {
  captureCredentialGuard,
  createCredentialCipherByPath,
  deleteCredentialValueIfEquals,
  deleteUnreadableCredentialValues,
  loadManyCredentialValues,
  mutateCredentialRecordLocked,
  readCredentialRecordWithMigration,
  recoverUnreadableCredentialValue,
  saveCredentialValueIfAbsent,
  updateCredentialValuesMany,
  type CredentialCipher,
  type CredentialRecordTarget,
} from "@zcode/shared/credential-security";
import type {
  CredentialMutationEvent,
  DeleteUnreadableOptions,
  LocalCredentialService,
  UpdateManyOptions,
} from "./credential.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { getCredentialsFilePath } from "../paths.js";

/**
 * 凭据存储
 *
 * 持久化格式仍是 JSON，但每个 value 是 `enc:v2:` 密文：主密钥为 32 字节随机值，
 * 优先存系统凭据库、失败时回退同目录 0600 `credential-secret`（见 @zcode/shared/credential-security）。
 * 拿到 `credentials.json` 副本不再等于拿到 token —— 主密钥不在副本里。
 *
 * 批量方法（loadMany/updateMany/deleteUnreadable/...，SPEC §7）只做键值校验与变更通知，
 * 读写语义全部落在共享层的 credentialBatchStore：CAS、代次闸门、锁序只有一处实现。
 */
const logger = createServiceLogger("credentialService");

function getCredentialsFile() {
  // 路径必须跟随数据根（setDataBaseDir 生效时用新根），且与 CLI 逐字节相等。
  return getCredentialsFilePath();
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

async function readAll(credentialsFile: string): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await readFile(credentialsFile, "utf-8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return {};
    }
    throw new Error(`Unable to read ZCode credentials: ${credentialsFile}`, { cause: error });
  }

  try {
    const rawValue = JSON.parse(raw);
    const result = credentialRecordSchema.safeParse(rawValue);
    if (!result.success) {
      throw new Error(formatZodError(result.error));
    }
    return result.data;
  } catch (error) {
    // 把损坏 JSON/schema 当成空 store 后继续 save 会清空其他 OAuth 与登录凭据。
    // 保留损坏文件证据并向上传递错误，禁止自动覆盖。
    const backupPath = await backupCorruptFile(credentialsFile).catch(() => undefined);
    // 服务层日志必须统一经过分级 logger，确保生产环境的损坏凭据告警
    // 进入相同的落盘/采集策略，同时不记录凭据内容。
    logger.warn(undefined, "read failed; refusing to overwrite corrupt credential store", {
      backupPath,
      credentialsFile,
    });
    throw new Error(`ZCode credentials are corrupt: ${credentialsFile}`, { cause: error });
  }
}

async function writeAll(credentialsFile: string, data: Record<string, string>): Promise<void> {
  // 凭据路径之前在模块加载时就绑定到 homedir()，
  // Windows 测试里即使切换 HOME 也会继续写真实用户目录，导致隔离失效。
  await atomicWritePrivateTextFile(credentialsFile, `${JSON.stringify(data, null, 2)}\n`);
}

/** CAS 期望值与写入值走同一套校验；null 保留为「必须不存在」。 */
function validateChanges(
  changes: Readonly<Record<string, string | null>>,
): Record<string, string | null> {
  return Object.fromEntries(
    Object.entries(changes).map(([key, value]) => [
      credentialKeySchema.parse(key),
      value === null ? null : credentialValueSchema.parse(value),
    ]),
  );
}

function validateExpected(
  expected: Readonly<Record<string, string | null>> | undefined,
): Record<string, string | null> | undefined {
  return expected === undefined ? undefined : validateChanges(expected);
}

function validateValues(
  values: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined {
  if (values === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      credentialKeySchema.parse(key),
      credentialValueSchema.parse(value),
    ]),
  );
}

interface CredentialServiceDependencies {
  /** 注入的加密后端；默认是本机系统凭据库（keyring 优先、私有文件兜底）。 */
  cipher?: CredentialCipher;
  /**
   * Host 私有的持久化成功通知；不进入 Renderer/RPC 凭据接口。
   * 批量提交一次只发一个事件并带完整 keys —— 通知必须在锁外发（见 credentialBatchStore）。
   */
  onDidMutate?: (event: CredentialMutationEvent) => void;
}

export function createCredentialService(
  dependencies: CredentialServiceDependencies = {},
): LocalCredentialService {
  // 数据存储路径可在运行期切换，而密钥条目按凭据文件路径命名：cipher 必须按当前路径取，
  // 否则切换后的新根会继续用旧根的密钥。
  const cipherByPath = createCredentialCipherByPath();
  const cipherFor = (filePath: string) => dependencies.cipher ?? cipherByPath(filePath);
  const recordTarget = (filePath: string): CredentialRecordTarget => ({
    filePath,
    cipher: cipherFor(filePath),
    read: () => readAll(filePath),
    write: (record) => writeAll(filePath, record),
  });
  const notify = (event: CredentialMutationEvent): void => {
    if (event.keys.length === 0) return;
    dependencies.onDidMutate?.(event);
  };

  return {
    async load(key: string): Promise<string | null> {
      const validatedKey = credentialKeySchema.parse(key);
      const credentialsFile = getCredentialsFile();
      // 读时迁移旧格式：老用户升级后不掉登录，且旧值在下一次读取时就变成 v2。
      const creds = await readCredentialRecordWithMigration(recordTarget(credentialsFile));
      const rawValue = creds[validatedKey];
      if (rawValue === undefined) {
        return null;
      }

      return await cipherFor(credentialsFile).decrypt(rawValue);
    },

    async save(key: string, value: string): Promise<void> {
      const validatedKey = credentialKeySchema.parse(key);
      const validatedValue = credentialValueSchema.parse(value);
      const credentialsFile = getCredentialsFile();
      // 单键写入就是「整组条件写只有一个变更」：加密在锁外、代次在锁内复核。
      await updateCredentialValuesMany(recordTarget(credentialsFile), {
        [validatedKey]: validatedValue,
      });
      notify({ operation: "save", keys: [validatedKey] });
    },

    async delete(key: string): Promise<void> {
      const validatedKey = credentialKeySchema.parse(key);
      const credentialsFile = getCredentialsFile();
      // 纯删除不迁移：密钥不可用时登出仍必须成功（恢复流程属 P2），也不产生新密文，
      // 因此不需要代次闸门（闸门保护的是「加密结果基于旧存储」，删除没有加密结果）。
      await mutateCredentialRecordLocked(recordTarget(credentialsFile), {
        mutation: (creds) => {
          delete creds[validatedKey];
        },
      });
      notify({ operation: "delete", keys: [validatedKey] });
    },

    async loadMany(keys: readonly string[]): Promise<Record<string, string | null>> {
      const validatedKeys = keys.map((key) => credentialKeySchema.parse(key));
      return await loadManyCredentialValues(recordTarget(getCredentialsFile()), validatedKeys);
    },

    async updateMany(
      changes: Readonly<Record<string, string | null>>,
      options: UpdateManyOptions = {},
    ): Promise<boolean> {
      const validatedChanges = validateChanges(changes);
      const committed = await updateCredentialValuesMany(
        recordTarget(getCredentialsFile()),
        validatedChanges,
        { expected: validateExpected(options.expected), assertCurrent: options.assertCurrent },
      );
      if (committed) notify({ operation: "batch", keys: Object.keys(validatedChanges) });
      return committed;
    },

    async deleteUnreadable(
      keys: readonly string[],
      options: DeleteUnreadableOptions = {},
    ): Promise<boolean> {
      const affected = await deleteUnreadableCredentialValues(
        recordTarget(getCredentialsFile()),
        keys.map((key) => credentialKeySchema.parse(key)),
        {
          expected: validateExpected(options.expected),
          removeKeys: options.removeKeys?.map((key) => credentialKeySchema.parse(key)),
          replacements: validateValues(options.replacements),
        },
      );
      if (affected === null) return false;
      notify({ operation: "batch", keys: affected });
      return true;
    },

    async saveIfAbsent(key: string, value: string): Promise<string> {
      const validatedKey = credentialKeySchema.parse(key);
      const validatedValue = credentialValueSchema.parse(value);
      const result = await saveCredentialValueIfAbsent(
        recordTarget(getCredentialsFile()),
        validatedKey,
        validatedValue,
      );
      if (result.written) notify({ operation: "save", keys: [validatedKey] });
      return result.value;
    },

    async deleteIfEquals(key: string, expected: string): Promise<void> {
      const validatedKey = credentialKeySchema.parse(key);
      const validatedExpected = credentialValueSchema.parse(expected);
      const deleted = await deleteCredentialValueIfEquals(
        recordTarget(getCredentialsFile()),
        validatedKey,
        validatedExpected,
      );
      if (deleted) notify({ operation: "delete", keys: [validatedKey] });
    },

    async recoverUnreadable(key: string, assertCurrent: () => void): Promise<string | null> {
      const validatedKey = credentialKeySchema.parse(key);
      const result = await recoverUnreadableCredentialValue(
        recordTarget(getCredentialsFile()),
        validatedKey,
        assertCurrent,
      );
      // SPEC §7.2.5 把恢复流程统一成 operation: "recover"（上游对单键恢复发的是 delete）。
      if (result.removed) notify({ operation: "recover", keys: [validatedKey] });
      return result.value;
    },

    async captureRecoveryGuard() {
      return await captureCredentialGuard(recordTarget(getCredentialsFile()));
    },
  };
}
