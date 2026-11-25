import { link, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { createCredentialStorageUnavailableError } from "./credentialFailure.js";
import {
  ENV_SECRET_FILE_KEY,
  ENV_SECRET_KEY,
  KEY_BYTES,
  MAX_SECRET_BYTES,
  MIN_SECRET_BYTES,
} from "./cipherPrimitives.js";

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * 显式配置的受管密钥：`ZCODE_CREDENTIAL_SECRET` 优先于 `ZCODE_CREDENTIAL_SECRET_FILE`。
 * 两者同时存在是配置错误（无法判断运维意图），按 config 阶段拒绝而不是猜一个。
 * 值一律原字节、不 trim —— 密钥里的空白是有意义的。
 */
export async function resolveExplicitSecret(
  env: Readonly<Record<string, string | undefined>>,
): Promise<string | undefined> {
  const secret = env[ENV_SECRET_KEY];
  const secretFile = env[ENV_SECRET_FILE_KEY];
  if (secret && secretFile) throw createCredentialStorageUnavailableError("config");
  if (secret) return secret;
  if (!secretFile) return undefined;
  const path = resolve(secretFile);
  const metadata = await stat(path).catch((error: unknown) => {
    throw createCredentialStorageUnavailableError("config", error);
  });
  if (!metadata.isFile()) throw createCredentialStorageUnavailableError("config");
  const value = await readFile(path, "utf8").catch((error: unknown) => {
    throw createCredentialStorageUnavailableError("config", error);
  });
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < MIN_SECRET_BYTES || bytes > MAX_SECRET_BYTES) {
    throw createCredentialStorageUnavailableError("config");
  }
  return value;
}

/**
 * 同目录私有密钥文件（`credential-secret`）：存在即用，永不覆盖。
 * 权限必须收窄到 0600（非 win32）：这是文件兜底的全部保护，放宽即等于把密钥给同机其他用户。
 * 大小按原字节 32–4096 校验，超界或权限不符一律拒绝 —— 不能挑一部分字节当密钥。
 */
export async function readPrivateSecretFile(secretPath: string): Promise<string | null> {
  const metadata = await stat(secretPath).catch((error: unknown) => {
    if (getErrorCode(error) === "ENOENT") return null;
    throw createCredentialStorageUnavailableError("managed", error);
  });
  if (!metadata) return null;
  if (!metadata.isFile()) throw createCredentialStorageUnavailableError("managed");
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw createCredentialStorageUnavailableError("managed");
  }
  const value = await readFile(secretPath, "utf8").catch((error: unknown) => {
    throw createCredentialStorageUnavailableError("managed", error);
  });
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < MIN_SECRET_BYTES || bytes > MAX_SECRET_BYTES) {
    throw createCredentialStorageUnavailableError("managed");
  }
  return value;
}

/**
 * 调用方须持有密钥锁并确认目录未绑定来源；已有文件绝不覆盖。
 * 先完整写入临时文件再 `link` 排他发布：`rename` 会覆盖并发创建者的密钥，
 * 那样两个进程会各拿一把钥匙，一半密文永久解不开。
 */
export async function publishPrivateSecretFile(secretPath: string): Promise<void> {
  await mkdir(dirname(secretPath), { recursive: true });
  const temporary = `${secretPath}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, randomBytes(KEY_BYTES).toString("base64url"), {
      mode: 0o600,
      flag: "wx",
    });
    await link(temporary, secretPath).catch((error: unknown) => {
      if (getErrorCode(error) !== "EEXIST") throw error;
    });
  } finally {
    await rm(temporary, { force: true });
  }
}
