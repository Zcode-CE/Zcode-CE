import { digest } from "./cipherPrimitives.js";
import type { CredentialKeyStore } from "./contract.js";
import type { CredentialKeyFailureStage } from "./credentialFailure.js";
import { resolve } from "node:path";

/** 系统凭据库条目名；必须写死，跨进程与跨版本一致。 */
const SYSTEM_SERVICE = "ZCode Credential Encryption";
const KEYRING_MODULE_ID = "@napi-rs/keyring";

/** 系统库访问失败的中间分类：决定回退还是报错，不向上暴露原生错误正文。 */
export class KeyringFailure extends Error {
  readonly stage: CredentialKeyFailureStage;
  constructor(stage: CredentialKeyFailureStage, cause?: unknown) {
    super("system credential keyring failure", cause === undefined ? undefined : { cause });
    this.name = "KeyringFailure";
    this.stage = stage;
  }
}

interface NativeKeyringEntry {
  getPassword(): Promise<string | null>;
  setPassword(value: string): Promise<void>;
}

interface NativeKeyringModule {
  AsyncEntry: new (
    service: string,
    account: string,
    options?: { linux?: { store: string } },
  ) => NativeKeyringEntry;
}

/**
 * 惰性加载原生钥匙串模块。它目前不是声明的依赖（平台变体、asarUnpack 与打包期
 * fail-closed 校验必须与桌面打包同批落地），所以必须容忍模块不存在：import 失败归到
 * `load` 阶段，由上层决定回退到私有文件还是报错。用变量做说明符是有意的 ——
 * 让打包器不要静态解析这个可选模块。
 */
async function importNativeKeyring(): Promise<NativeKeyringModule> {
  const loaded = (await import(KEYRING_MODULE_ID)) as unknown;
  return loaded as NativeKeyringModule;
}

/**
 * 系统凭据库条目名按「规范化后的凭据文件绝对路径」推导，跨进程必须一致：
 * 用 `resolve`（绝对化 + 折叠 `..`），不做 realpath（会随符号链接/挂载变化），
 * 不折叠大小写、不 trim、不展开 `~`（解析器负责这些）。
 */
export function systemKeyStore(filePath: string): CredentialKeyStore {
  let entry: Promise<NativeKeyringEntry> | undefined;
  const getEntry = (): Promise<NativeKeyringEntry> => {
    entry ??= importNativeKeyring()
      .then(
        ({ AsyncEntry }) =>
          new AsyncEntry(SYSTEM_SERVICE, digest(resolve(filePath)).toString("hex"), {
            // Linux 必须固定 Secret Service：默认的 keyutils 是内存态，重启即失，
            // 「重启后全部密文解不开」不能成为默认行为的后果。
            linux: { store: "secret-service" },
          }),
      )
      .catch((error: unknown) => {
        entry = undefined;
        throw new KeyringFailure("load", error);
      });
    return entry;
  };
  return {
    async get() {
      const current = await getEntry();
      try {
        return await current.getPassword();
      } catch (error) {
        throw new KeyringFailure("read", error);
      }
    },
    async set(value) {
      const current = await getEntry();
      try {
        await current.setPassword(value);
      } catch (error) {
        throw new KeyringFailure("create", error);
      }
    },
  };
}
