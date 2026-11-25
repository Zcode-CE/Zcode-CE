import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { homedir, platform, userInfo } from "node:os";
import { CREDENTIAL_DECRYPT_ERROR_CODE, CREDENTIAL_DECRYPT_ERROR_PREFIX } from "../oauth.js";
import { LEGACY_PREFIX } from "./credentialFileState.js";

/** 加密原语与历史密钥候选；不含密钥来源决策（见 managedSecret / nativeKeyring）。 */
export const ALGORITHM = "aes-256-gcm";
export const KEY_BYTES = 32;
export const IV_BYTES = 12;
export const TAG_BYTES = 16;
export const FINGERPRINT_HEX_LENGTH = 24;
export const ENV_SECRET_KEY = "ZCODE_CREDENTIAL_SECRET";
export const ENV_SECRET_FILE_KEY = "ZCODE_CREDENTIAL_SECRET_FILE";
export const MIN_SECRET_BYTES = 32;
export const MAX_SECRET_BYTES = 4096;
/** 系统条目内容必须正好是 32 字节的 base64url（无 padding，43 字符）。 */
export const ENCODED_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const KEY_FINGERPRINT_PATTERN = /^[a-f0-9]{24}$/;

export function digest(value: string | Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}

export function keyFingerprint(key: Buffer): string {
  return digest(key).toString("hex").slice(0, FINGERPRINT_HEX_LENGTH);
}

/** 仅接受正常形式的指纹；用于区分「密钥不对」与「密文损坏」。 */
export function isKeyFingerprint(value: string): boolean {
  return value.length === FINGERPRINT_HEX_LENGTH && KEY_FINGERPRINT_PATTERN.test(value);
}

export function decryptError(): Error {
  return Object.assign(
    new Error(`${CREDENTIAL_DECRYPT_ERROR_PREFIX}Invalid encrypted credential`),
    { code: CREDENTIAL_DECRYPT_ERROR_CODE },
  );
}

export function seal(value: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), bytes].map((part) => part.toString("base64url")).join(".");
}

export function open(payload: string, key: Buffer): string {
  const parts = payload.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]*$/.test(part)))
    throw decryptError();
  const [iv, tag, bytes] = parts.map((part) => Buffer.from(part, "base64url"));
  if (!iv || !tag || !bytes || iv.length !== IV_BYTES || tag.length !== TAG_BYTES)
    throw decryptError();
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(bytes), decipher.final()]).toString("utf8");
  } catch {
    throw decryptError();
  }
}

/**
 * v1 的三个历史候选密钥（永久保留，只读不写）：
 * 旧 Desktop 用原字符串、旧 CLI 用 trim 后的字符串、没有显式配置时用历史默认派生串。
 * 盐/迭代补救不了「密钥本身可推导」这个缺陷，所以这里只做兼容读取，绝不用于写 v2。
 */
export function legacyKeyCandidates(env: Readonly<Record<string, string | undefined>>): Buffer[] {
  let username = "unknown";
  try {
    username = userInfo().username;
  } catch {
    /* 打包/沙箱运行时可能拿不到 OS 用户信息，沿用同一占位值。 */
  }
  const fallback = `zcode-credential-fallback:${platform()}:${homedir()}:${username}`;
  const secret = env[ENV_SECRET_KEY];
  // GCM 认证决定哪把历史密钥是对的；绝不把解密失败的密文当明文返回。
  return [...new Set([secret || fallback, secret?.trim() || fallback, fallback])].map(digest);
}

export function createLegacyCipher(keys: Buffer[], writeKey = keys[0]!) {
  return {
    encrypt: (value: string): string => LEGACY_PREFIX + seal(value, writeKey),
    decrypt(value: string): string {
      if (value.startsWith(LEGACY_PREFIX)) {
        for (const key of keys) {
          try {
            return open(value.slice(LEGACY_PREFIX.length), key);
          } catch {
            /* 继续尝试另一端的历史规则。 */
          }
        }
        throw decryptError();
      }
      if (value.startsWith("enc:")) throw decryptError();
      return value;
    },
  };
}

/**
 * v1 写入器：只服务历史导入与测试夹具。默认运行时路径不得使用它 ——
 * 它的密钥可离线推导（SPEC 探针 A/B），保留就是为了迁移，不是为了让新数据用它。
 */
export function createLegacyCredentialCipher(
  env: Readonly<Record<string, string | undefined>> = process.env,
): { encrypt(value: string): string; decrypt(value: string): string } {
  return createLegacyCipher(legacyKeyCandidates(env));
}

export function encodedKeyFingerprint(encoded: string): string | null {
  return ENCODED_KEY_PATTERN.test(encoded)
    ? keyFingerprint(Buffer.from(encoded, "base64url"))
    : null;
}
