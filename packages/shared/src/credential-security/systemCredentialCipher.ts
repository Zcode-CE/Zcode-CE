import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { withFileLock } from "../node/privateFilePersistence.js";
import {
  ENCODED_KEY_PATTERN,
  KEY_BYTES,
  KEY_FINGERPRINT_PATTERN,
  createLegacyCipher,
  createLegacyCredentialCipher,
  decryptError,
  digest,
  encodedKeyFingerprint,
  isKeyFingerprint,
  keyFingerprint,
  legacyKeyCandidates,
  open,
  seal,
} from "./cipherPrimitives.js";
import type {
  CredentialKeyStore,
  SystemCredentialCipher,
  SystemCredentialCipherOptions,
} from "./contract.js";
import {
  ENV_CIPHERTEXT_PREFIX,
  OS_CIPHERTEXT_PREFIX,
  SYSTEM_PREFIX,
  credentialKeyLockPath,
  isKnownCredentialCiphertext,
  needsCredentialMigration,
  privateSecretPath,
  readCredentialSource,
  readOptionalBytes,
  recordValues,
  removeOsSourceMarkerLocked,
  writeOsSourceMarkerLocked,
} from "./credentialFileState.js";
import {
  createCredentialStorageUnavailableError,
  type CredentialKeyFailureStage,
} from "./credentialFailure.js";
import {
  publishPrivateSecretFile,
  readPrivateSecretFile,
  resolveExplicitSecret,
} from "./managedSecret.js";
import { KeyringFailure, systemKeyStore } from "./nativeKeyring.js";

export { createLegacyCredentialCipher };

/**
 * 进程内的默认密钥缓存。系统密钥属于凭据目录，而不属于某个短命 cipher：
 * 成功与失败都按规范化后的凭据文件路径共享到进程退出 —— 用户拒绝一次系统授权后，
 * 后台读请求不能再次触发系统弹窗（不变式 I4）。
 * 显式注入的 KeyStore 按实例隔离，测试之间不互相污染。
 */
interface KeyMaterial {
  key: Buffer;
  source: "os" | "env";
  legacySecret?: string;
}

const systemKeys = new Map<string, Promise<KeyMaterial>>();
const injectedSystemKeys = new WeakMap<CredentialKeyStore, Map<string, Promise<KeyMaterial>>>();

function keyCacheFor(store?: CredentialKeyStore): Map<string, Promise<KeyMaterial>> {
  if (!store) return systemKeys;
  let cache = injectedSystemKeys.get(store);
  if (!cache) {
    cache = new Map();
    injectedSystemKeys.set(store, cache);
  }
  return cache;
}

function unavailable(stage: CredentialKeyFailureStage, cause?: unknown): Error {
  return createCredentialStorageUnavailableError(stage, cause);
}

type KeyringLookup =
  | { kind: "key"; encoded: string }
  | { kind: "missing" }
  | { kind: "failure"; cause: unknown };

/**
 * 只读取条目；`unbound` 为真时才允许生成。
 * 「读取」与「生成」必须是两条路径：解密一个缺密钥的旧文件时若顺手生成新密钥，
 * 会把「密钥丢失」误判成「首次使用」，之后的密文就再也对不上原来那把钥匙。
 */
async function readOrCreateKeyringKey(
  store: CredentialKeyStore,
  options: { create: boolean; unbound: boolean },
): Promise<KeyringLookup> {
  let encoded: string | null;
  try {
    encoded = await store.get();
  } catch (error) {
    return { kind: "failure", cause: error };
  }
  if (encoded === null) {
    if (!options.create || !options.unbound) return { kind: "missing" };
    encoded = randomBytes(KEY_BYTES).toString("base64url");
    try {
      await store.set(encoded);
      // 创建后必须读回校验：Windows Credential Manager 配额满时可能写不进却返回成功。
      if ((await store.get()) !== encoded) {
        return { kind: "failure", cause: new KeyringFailure("verify") };
      }
    } catch (error) {
      return { kind: "failure", cause: error };
    }
  }
  if (!ENCODED_KEY_PATTERN.test(encoded)) {
    return { kind: "failure", cause: new KeyringFailure("invalid") };
  }
  return { kind: "key", encoded };
}

/** 凭据容器里 os 来源密文的密钥指纹；文件缺失或无法解析时视为没有。 */
async function readOsKeyFingerprints(filePath: string): Promise<Set<string>> {
  const values = recordValues(await readOptionalBytes(filePath));
  const fingerprints = new Set<string>();
  for (const value of values) {
    if (!value.startsWith(OS_CIPHERTEXT_PREFIX)) continue;
    const fingerprint = value.slice(OS_CIPHERTEXT_PREFIX.length).split(":")[0];
    if (fingerprint && KEY_FINGERPRINT_PATTERN.test(fingerprint)) fingerprints.add(fingerprint);
  }
  return fingerprints;
}

export function createSystemCredentialCipher(
  options: SystemCredentialCipherOptions,
): SystemCredentialCipher {
  const env = options.env ?? process.env;
  // 桌面 Host / 内置 agent / 独立 CLI 允许在未绑定目录上首次生成；无头形态必须显式关闭。
  const allowKeyCreation = options.allowKeyCreation ?? true;
  const filePath = resolve(options.filePath);
  const store = options.keyStore ?? systemKeyStore(filePath);
  const cache = keyCacheFor(options.keyStore);
  let explicitSecret: Promise<string | undefined> | undefined;
  const getExplicitSecret = (): Promise<string | undefined> => {
    explicitSecret ??= resolveExplicitSecret(env);
    return explicitSecret;
  };

  /**
   * 系统库不可用时的判定；这里是不变式 I1/I2 的落点：
   * - 不允许创建（无头/Server）⇒ 原样报错，不生成替代密钥
   * - 目录里已有 v2 密文 ⇒ 报错且不清库（P2 才做自动重置）
   * - 否则目录没有任何数据依赖系统密钥，只删来源标记后改用私有文件（D1'：只解除绑定、
   *   不清库）。把 P1 已知的「钥匙串坏掉就卡死」降级为「重新登录一次」。
   */
  const recoverWithoutKeyring = async (
    cause: unknown,
    state: { create: boolean; hasV2Ciphertext: boolean },
  ): Promise<KeyMaterial> => {
    const stage = cause instanceof KeyringFailure ? cause.stage : "read";
    if (!state.create || state.hasV2Ciphertext) throw unavailable(stage, cause);
    await removeOsSourceMarkerLocked(filePath);
    await publishPrivateSecretFile(privateSecretPath(filePath));
    const secret = await readPrivateSecretFile(privateSecretPath(filePath));
    if (secret === null) throw unavailable("fallback", cause);
    options.onFallback?.();
    return { key: digest(secret), source: "env", legacySecret: secret };
  };

  /** 调用方须持密钥锁。顺序：显式配置 > 私有文件 > 系统库；已绑定 os 的目录只走系统库。 */
  const resolveKeyLocked = async (create: boolean): Promise<KeyMaterial> => {
    const sourceState = await readCredentialSource(filePath);
    if (sourceState.kind === "invalid") throw unavailable("source");
    const values = recordValues(await readOptionalBytes(filePath));
    const hasOsCiphertext = values.some((value) => value.startsWith(OS_CIPHERTEXT_PREFIX));
    const hasEnvCiphertext = values.some((value) => value.startsWith(ENV_CIPHERTEXT_PREFIX));
    const pinnedOs = sourceState.kind === "os";
    const osBound = pinnedOs || hasOsCiphertext;
    if (!osBound) {
      // 私有文件先于系统库：一次回退后永久稳定。否则同一目录会在「库恢复可用」与
      // 「文件已存在」之间来回切换来源，而已有密文离不开生成它的那把密钥。
      const secret = await readPrivateSecretFile(privateSecretPath(filePath));
      if (secret !== null) return { key: digest(secret), source: "env", legacySecret: secret };
      // 有 env 密文却没有对应的私有文件：密钥已经丢了，不能生成替代密钥。
      if (hasEnvCiphertext) throw unavailable("missing");
    }
    const mayCreate = create && allowKeyCreation;
    const unbound = mayCreate && !osBound && !hasEnvCiphertext;
    const lookup = await readOrCreateKeyringKey(store, { create: mayCreate, unbound });
    if (lookup.kind === "key") {
      const key = Buffer.from(lookup.encoded, "base64url");
      if (key.length !== KEY_BYTES) throw unavailable("invalid");
      // 系统库成功初始化时在同一把密钥锁内原子固定来源；标记只写一次，之后不再切换。
      if (!pinnedOs) await writeOsSourceMarkerLocked(filePath);
      return { key, source: "os" };
    }
    if (lookup.kind === "missing") throw unavailable("missing");
    return await recoverWithoutKeyring(lookup.cause, {
      create: mayCreate,
      hasV2Ciphertext: hasOsCiphertext || hasEnvCiphertext,
    });
  };

  const loadKey = async (create: boolean): Promise<KeyMaterial> => {
    const secret = await getExplicitSecret();
    if (secret) return { key: digest(secret), source: "env", legacySecret: secret };
    const cached = cache.get(filePath);
    if (cached) return cached;
    let lockAcquired = false;
    const pending = withFileLock(credentialKeyLockPath(filePath), async () => {
      lockAcquired = true;
      return await resolveKeyLocked(create);
    });
    cache.set(filePath, pending);
    // 未取得锁就没有访问系统库，不能缓存：另一进程持锁等待系统授权超过锁等待上限时，
    // 缓存失败会让本进程在锁释放后仍永久失败。已访问系统库的失败仍然只弹一次。
    pending.catch(() => {
      if (!lockAcquired && cache.get(filePath) === pending) cache.delete(filePath);
    });
    return pending;
  };

  return {
    async initialize(): Promise<void> {
      await loadKey(allowKeyCreation);
    },

    needsMigration: (value) => needsCredentialMigration(value),

    async shareKeyWithCopiedCredentials(targetFilePath, targetKeyStore): Promise<void> {
      const target = resolve(targetFilePath);
      if (target === filePath) return;
      const [sourcePrints, targetPrints, sourcePinned, targetPinned] = await Promise.all([
        readOsKeyFingerprints(filePath),
        readOsKeyFingerprints(target),
        readCredentialSource(filePath).then((state) => state.kind === "os"),
        readCredentialSource(target).then((state) => state.kind === "os"),
      ]);
      // 目标条目要满足的密钥：目标有本目录的 os 密文时必须是生成它的那把；
      // null 表示「任意合法条目即可」。
      let requiredFingerprint: string | null;
      if (targetPrints.size === 1) {
        const [fingerprint] = targetPrints;
        // 密文不来自本目录（目标自有凭据未被覆盖）：没有数据依赖本目录密钥。
        if (!fingerprint || !sourcePrints.has(fingerprint)) return;
        requiredFingerprint = fingerprint;
      } else if (targetPrints.size === 0 && targetPinned && sourcePinned) {
        // 源已固定 os 但没有 os 密文（只用过 API Key 后删光、恢复凭据存储后）：复制会把
        // credential-source 带到新根，而新根没有条目时会按「密钥丢失」拒绝生成新密钥，
        // 用户重新登录失败。标记依赖的是「目标路径有条目」，不依赖某把具体密钥。
        requiredFingerprint = null;
      } else {
        // 从未建过密钥、显式托管密钥等：不访问系统库，也不加载本目录密钥 ——
        // 空目录加载失败会缓存到进程退出，阻断之后的首次登录。
        return;
      }
      const destinationStore = targetKeyStore ?? systemKeyStore(target);
      // 已受影响的根（切换后缺自己的条目）按恢复流程切回原路径时，本目录可能没有密钥；
      // 切换只需保证目标条目能解开目标密文，所以指纹已匹配时直接成功，不加载本目录密钥。
      const registered = await destinationStore.get().catch((cause: unknown) => {
        throw unavailable("read", cause);
      });
      const registeredFingerprint = registered === null ? null : encodedKeyFingerprint(registered);
      if (
        registeredFingerprint !== null &&
        (requiredFingerprint === null || registeredFingerprint === requiredFingerprint)
      ) {
        return;
      }
      const { key, source } = await loadKey(false);
      if (
        source !== "os" ||
        (requiredFingerprint !== null && keyFingerprint(key) !== requiredFingerprint)
      ) {
        return;
      }
      const encoded = key.toString("base64url");
      // 与首次创建使用同一把目标密钥锁，避免与目标路径上的首次访问竞争。
      await withFileLock(credentialKeyLockPath(target), async () => {
        try {
          const existing = await destinationStore.get();
          if (existing === encoded) return;
          // 目标路径已有另一把密钥时可能仍有数据依赖它，不能覆盖；明确失败让调用方中止切换。
          if (existing !== null) throw unavailable("create");
          await destinationStore.set(encoded);
          if ((await destinationStore.get()) !== encoded) throw unavailable("verify");
        } catch (error) {
          if (error instanceof KeyringFailure) throw unavailable(error.stage, error);
          throw error;
        }
      });
    },

    async encrypt(value: string): Promise<string> {
      const { key, source } = await loadKey(true);
      return `${SYSTEM_PREFIX}${source}:${keyFingerprint(key)}:${seal(value, key)}`;
    },

    async decrypt(value: string): Promise<string> {
      if (!value.startsWith(SYSTEM_PREFIX)) {
        // 未知 `enc:` 前缀必须明确失败：按明文返回会把「密钥不对」伪装成「值就是这个字符串」。
        if (value.startsWith("enc:") && !isKnownCredentialCiphertext(value)) throw decryptError();
        // 读旧格式不碰系统库：v1 的候选密钥只由「显式配置 + 历史派生」决定，与当前密钥来源无关。
        // 这里绝不能调用 loadKey —— 否则「解密一个缺密钥的旧文件」会顺手生成新密钥，
        // 把「密钥丢失」误判成「首次使用」（SPEC 4.8）。
        const secret = await getExplicitSecret();
        return createLegacyCipher(
          legacyKeyCandidates(
            secret === undefined ? env : { ...env, ZCODE_CREDENTIAL_SECRET: secret },
          ),
        ).decrypt(value);
      }
      const [declaredSource, declaredFingerprint, payload] = value
        .slice(SYSTEM_PREFIX.length)
        .split(":");
      if (
        !declaredSource ||
        !declaredFingerprint ||
        !payload ||
        value.slice(SYSTEM_PREFIX.length).split(":").length !== 3 ||
        (declaredSource !== "os" && declaredSource !== "env") ||
        !isKeyFingerprint(declaredFingerprint)
      ) {
        throw decryptError();
      }
      // 解密绝不创建密钥：缺密钥的 v2 文件说明密钥丢了，不是首次使用（不变式 I2）。
      const { key, source } = await loadKey(false);
      if (declaredSource !== source) throw unavailable("source");
      if (keyFingerprint(key) !== declaredFingerprint) throw unavailable("invalid");
      return open(payload, key);
    },
  };
}
