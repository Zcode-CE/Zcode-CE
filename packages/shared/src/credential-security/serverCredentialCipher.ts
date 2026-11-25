import { dirname, resolve } from "node:path";
import type { CredentialKeyStore, SystemCredentialCipher } from "./contract.js";
import {
  CREDENTIAL_SECURE_STORAGE_UNAVAILABLE_CODE,
  credentialKeyFailureOf,
} from "./credentialFailure.js";
import { createSystemCredentialCipher } from "./systemCredentialCipher.js";

/**
 * Server / 无头 npm / Docker 的唯一入口：只接受显式配置或已存在的私有文件，
 * 绝不自动生成 —— 容器重建会让密钥与身份一起静默消失，拒绝就绪至少可诊断（D2'）。
 * Desktop 侧继续用 createSystemCredentialCipher。
 */
export async function createServerCredentialCipher(options: {
  filePath: string;
  env?: Readonly<Record<string, string | undefined>>;
  keyStore?: CredentialKeyStore;
}): Promise<SystemCredentialCipher> {
  const cipher = createSystemCredentialCipher({
    ...options,
    env: options.env ?? process.env,
    allowKeyCreation: false,
  });
  try {
    await cipher.initialize();
    return cipher;
  } catch (error) {
    const directory = dirname(resolve(options.filePath));
    const diagnostic = credentialKeyFailureOf(error);
    const failure = Object.assign(
      new Error(
        `Remote credential storage unavailable. Configure ZCODE_CREDENTIAL_SECRET_FILE to a private (0600) file of 32–4096 bytes, or place an existing credential-secret file in ${directory}, then reconnect. Existing encrypted data requires its original key; this deployment never generates one because a rebuilt container would silently lose it.`,
        { cause: error },
      ),
      { code: CREDENTIAL_SECURE_STORAGE_UNAVAILABLE_CODE },
    );
    throw diagnostic === null ? failure : Object.assign(failure, { diagnostic });
  }
}

export interface CredentialCipherByPathOptions {
  env?: Readonly<Record<string, string | undefined>>;
  allowKeyCreation?: boolean;
  keyStore?: CredentialKeyStore;
}

/**
 * 按凭据文件路径取 cipher（同路径复用同一个实例）。
 * 为什么需要工厂：Desktop 的「数据存储路径」可在运行期切换，密钥按路径命名；
 * 在服务创建时固定一个 cipher 会让切换后的新根继续用旧根的密钥。
 */
export function createCredentialCipherByPath(
  options: CredentialCipherByPathOptions = {},
): (filePath: string) => SystemCredentialCipher {
  const ciphers = new Map<string, SystemCredentialCipher>();
  return (filePath: string) => {
    const key = resolve(filePath);
    let cipher = ciphers.get(key);
    if (!cipher) {
      cipher = createSystemCredentialCipher({ ...options, filePath: key });
      ciphers.set(key, cipher);
    }
    return cipher;
  };
}
