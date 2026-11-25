import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicWritePrivateTextFile } from "../node/privateFilePersistence.js";
import { createCredentialStorageUnavailableError } from "./credentialFailure.js";
import { assertCredentialGeneration } from "./credentialGeneration.js";

/**
 * 凭据目录的磁盘状态：来源标记、密文前缀与容器读取。
 *
 * 密钥选择、迁移与写入闸门共用同一组定义，避免「某个读者认得的格式」和
 * 「写者产生的格式」各自漂移。本文件不含密钥，也不打印凭据值。
 */
export const SYSTEM_PREFIX = "enc:v2:";
export const LEGACY_PREFIX = "enc:v1:";
export const OS_CIPHERTEXT_PREFIX = `${SYSTEM_PREFIX}os:`;
export const ENV_CIPHERTEXT_PREFIX = `${SYSTEM_PREFIX}env:`;
/** 与凭据文件同目录的来源标记；内容只能是 OS_SOURCE_MARKER，不含密钥。 */
export const CREDENTIAL_SOURCE_FILE = "credential-source";
export const OS_SOURCE_MARKER = "os\n";
/** 文件兜底密钥：43 字符 base64url（32 随机字节）、无换行、0600。 */
export const PRIVATE_SECRET_FILE_NAME = "credential-secret";

/**
 * 凭据文件路径解析直接复用 `../credentialPaths.ts` 的唯一实现：
 * 两侧（CLI / 服务端）必须逐字节相等，否则同一个文件会有两把密钥。
 */
export { resolveCredentialsFilePath, resolveCredentialsFilePathIn } from "../credentialPaths.js";

export function credentialSourcePath(filePath: string): string {
  return join(dirname(filePath), CREDENTIAL_SOURCE_FILE);
}

export function privateSecretPath(filePath: string): string {
  return join(dirname(filePath), PRIVATE_SECRET_FILE_NAME);
}

/** 密钥锁文件：与凭据文件锁分开，锁序恒为「凭据文件锁 → 密钥锁」。 */
export function credentialKeyLockPath(filePath: string): string {
  return `${filePath}.keyring`;
}

export async function readOptionalBytes(path: string): Promise<Buffer | null> {
  return await readFile(path).catch((error) => {
    if (getErrorCode(error) === "ENOENT") return null;
    throw error;
  });
}

/** 凭据容器中的全部值；文件缺失或无法解析时视为没有（损坏由既有恢复机制处理）。 */
export function recordValues(raw: Buffer | null): string[] {
  let record: unknown;
  try {
    record = JSON.parse(raw?.toString("utf8") || "{}");
  } catch {
    return [];
  }
  if (!isRecord(record)) return [];
  return Object.values(record).filter((value): value is string => typeof value === "string");
}

/**
 * 来源标记的读取结果。`os`：来源已固定到系统凭据库；`missing`：未绑定；
 * `invalid`：标记内容不是规定值 —— 不能猜，按 source 阶段拒绝，避免两把密钥交替使用。
 */
export type CredentialSourceState = { kind: "os" } | { kind: "missing" } | { kind: "invalid" };

export async function readCredentialSource(filePath: string): Promise<CredentialSourceState> {
  const marker = await readFile(credentialSourcePath(filePath), "utf8").catch((error) => {
    if (getErrorCode(error) === "ENOENT") return null;
    throw error;
  });
  if (marker === null) return { kind: "missing" };
  return marker === OS_SOURCE_MARKER ? { kind: "os" } : { kind: "invalid" };
}

/** 凭据目录的来源是否已固定为 os；标记缺失视为未固定，其他读取错误向上抛出。 */
export async function isOsSourcePinned(filePath: string): Promise<boolean> {
  return (await readCredentialSource(filePath)).kind === "os";
}

/** 调用方须持密钥锁：把来源固定到 os，内容仅为标记，不含密钥。 */
export async function writeOsSourceMarkerLocked(filePath: string): Promise<void> {
  await atomicWritePrivateTextFile(credentialSourcePath(filePath), OS_SOURCE_MARKER);
}

/**
 * 调用方须持密钥锁：解除来源绑定（只删标记，不动凭据容器）。
 * 仅用于「目录里没有任何 v2 密文、因此没有数据依赖这把密钥」的最小安全切换。
 */
export async function removeOsSourceMarkerLocked(filePath: string): Promise<void> {
  await rm(credentialSourcePath(filePath), { force: true });
}

/** 明文与 `enc:v1:` 都是旧格式；只有 `enc:v2:` 是当前格式。 */
export function needsCredentialMigration(value: string): boolean {
  return !value.startsWith(SYSTEM_PREFIX);
}

/**
 * 判断一个值是否是本模块认识的密文。未知 `enc:` 前缀（例如未来版本的新格式）
 * 必须由调用方明确报错：按明文返回会让上层把密文当 token 用。
 */
export function isKnownCredentialCiphertext(value: string): boolean {
  return value.startsWith(LEGACY_PREFIX) || value.startsWith(SYSTEM_PREFIX);
}

export interface CredentialRecordWriteOptions {
  /** 锁内读到的当前记录，用来区分「本次新产生的 os 密文」与磁盘上已有的值。 */
  previous?: Readonly<Record<string, string>>;
  /** 加密前领取的存储代次；与锁内代次不一致时拒绝写盘。 */
  expectedGeneration?: number;
  /** 实际落盘（通常为 atomicWritePrivateTextFile），由调用方提供以复用其容器格式。 */
  write: (record: Record<string, string>) => Promise<void>;
}

/**
 * 凭据容器的唯一写入口；调用方必须已持有凭据文件锁。
 *
 * 两道闸门：
 * 1. 代次：加密在锁外发生，若期间发生过恢复/重置，旧结果必须拒绝写盘而不是覆盖新存储。
 * 2. 来源：本次新产生的 `enc:v2:os:` 值必须有 `credential-source=os` 标记，否则以
 *    `CREDENTIAL_SECURE_STORAGE_UNAVAILABLE` 拒绝且不写盘 —— 没有标记就写 os 密文，
 *    等于制造一个「来源未固定却依赖系统条目」的目录。磁盘上已有的值与 `env` 密文不检查。
 */
export async function writeCredentialRecordLocked(
  filePath: string,
  record: Readonly<Record<string, string>>,
  options: CredentialRecordWriteOptions,
): Promise<void> {
  if (options.expectedGeneration !== undefined) {
    await assertCredentialGeneration(filePath, options.expectedGeneration);
  }
  const previous = options.previous ?? {};
  const introducesOsCiphertext = Object.entries(record).some(
    ([key, value]) => value.startsWith(OS_CIPHERTEXT_PREFIX) && previous[key] !== value,
  );
  if (introducesOsCiphertext && !(await isOsSourcePinned(filePath))) {
    throw createCredentialStorageUnavailableError("source");
  }
  await options.write({ ...record });
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
