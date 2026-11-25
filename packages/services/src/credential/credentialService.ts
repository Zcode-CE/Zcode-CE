import { readFile } from "node:fs/promises";
import { atomicWritePrivateTextFile, backupCorruptFile } from "@zcode/shared/node";
import {
  credentialKeySchema,
  credentialRecordSchema,
  credentialValueSchema,
  formatZodError,
} from "@zcode/shared";
import {
  captureCredentialGeneration,
  createCredentialCipherByPath,
  mutateCredentialRecordLocked,
  readCredentialRecordWithMigration,
  type CredentialCipher,
  type CredentialRecordTarget,
} from "@zcode/shared/credential-security";
import type { ICredentialService } from "./credential.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { getCredentialsFilePath } from "../paths.js";

/**
 * 凭据存储
 *
 * 持久化格式仍是 JSON，但每个 value 是 `enc:v2:` 密文：主密钥为 32 字节随机值，
 * 优先存系统凭据库、失败时回退同目录 0600 `credential-secret`（见 @zcode/shared/credential-security）。
 * 拿到 `credentials.json` 副本不再等于拿到 token —— 主密钥不在副本里。
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

interface CredentialServiceDependencies {
  /** 注入的加密后端；默认是本机系统凭据库（keyring 优先、私有文件兜底）。 */
  cipher?: CredentialCipher;
  /** Host 私有的持久化成功通知；不进入 Renderer/RPC 凭据接口。 */
  onDidMutate?: (event: { operation: "save" | "delete"; key: string }) => void;
}

export function createCredentialService(
  dependencies: CredentialServiceDependencies = {},
): ICredentialService {
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
      const cipher = cipherFor(credentialsFile);
      // 加密在锁外完成（主密钥可能来自系统凭据库），代次在加密前领取、在锁内复核：
      // 跨越了恢复/重置的在途写必须被拒绝一次，而不是把旧结果盖到新存储上。
      const expectedGeneration = await captureCredentialGeneration(credentialsFile);
      const encryptedValue = await cipher.encrypt(validatedValue);
      // desktop host 与 CLI adapter 是独立进程，进程内排队不能阻止 whole-file
      // read-modify-write 丢更新；共享目录锁必须覆盖读取、变更和原子替换全过程。
      await mutateCredentialRecordLocked(recordTarget(credentialsFile), {
        migrate: true,
        expectedGeneration,
        mutation: (creds) => {
          creds[validatedKey] = encryptedValue;
        },
      });
      dependencies.onDidMutate?.({ operation: "save", key: validatedKey });
    },

    async delete(key: string): Promise<void> {
      const validatedKey = credentialKeySchema.parse(key);
      const credentialsFile = getCredentialsFile();
      // 纯删除不迁移：密钥不可用时登出仍必须成功（恢复流程属 P2），也不产生新密文。
      await mutateCredentialRecordLocked(recordTarget(credentialsFile), {
        mutation: (creds) => {
          delete creds[validatedKey];
        },
      });
      dependencies.onDidMutate?.({ operation: "delete", key: validatedKey });
    },
  };
}
