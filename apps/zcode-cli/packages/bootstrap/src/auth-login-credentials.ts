import { randomUUID } from "node:crypto";
import { isCredentialDecryptError } from "@zcode/shared";
import { SHARED_ZCODE_CREDENTIAL_KEYS, type SharedZCodeCredentialStore } from "@zcode/adapters";
import { ZCodeCliLoginError } from "./auth-login-error.js";

/**
 * CLI 登录的凭据整组提交（SPEC §7.3 的 CLI 侧落地）。
 *
 * 为什么必须整组 CAS：CLI 与 Desktop Host 共用同一份 credentials.json，登录要写
 * active provider、token、user_info 与共享 zcode JWT 多组键。逐键覆盖写会让两个进程的登录
 * 交错落盘，拼出「A 的 token + B 的 profile」；只比较「我要写的键」也挡不住反向覆盖 ——
 * 别的进程刚写完新登录，本进程按旧响应的字段集合覆盖回去。所以比较集合必须是整组会话键：
 * 任一键被并发改过就整组丢弃。
 */

export type LoginProviderId = "bigmodel" | "zai";

/** 明文快照：null 只表示「键不存在」（= 期望「必须不存在」），不是空值。 */
export type CredentialSnapshot = Readonly<Record<string, string | null>>;

/**
 * 会话组键：登录提交的比较集合。
 *
 * 直接用共享键表，是因为登出（`Object.values(SHARED_ZCODE_CREDENTIAL_KEYS)`）与登录必须
 * 面对同一组键：新增 provider 键时若只更新一处，登出会漏删、登录会漏比较 —— 后者表现为
 * 「另一进程刚登录的 provider 被旧进程覆盖」，只能靠测试发现。归因类旁路键不在这张表里，
 * 因此天然不参与 CAS（归因回调常先于授权码到达，它若影响会话代次会让登录永远失败）。
 */
const LOGIN_SESSION_KEYS: readonly string[] = Object.values(SHARED_ZCODE_CREDENTIAL_KEYS);

/** 会话版本值只要求与上一版不同：UUID 比时间戳可靠，同毫秒的两进程不会撞。 */
export function createLoginSessionRevision(): string {
  return randomUUID();
}

/**
 * 读取登录开始时的会话快照。
 *
 * 时机就是「发起登录」：待授权期间另一进程可能完成登录，只有拿这份快照比较，才能把
 * 迟到的旧响应整组丢掉。会话键里有解不开的密文时基线不成立，按 Host 同一步骤做损坏恢复
 * （SPEC §7.3）：强制清空会话命名空间并轮换版本，再以清空后的快照继续 —— 只清会话键，
 * 账号、插件、MCP 等其他凭据不受影响。
 */
export async function captureLoginSessionSnapshot(
  credentialStore: Pick<SharedZCodeCredentialStore, "loadMany" | "updateMany">,
): Promise<CredentialSnapshot> {
  try {
    return await credentialStore.loadMany(LOGIN_SESSION_KEYS);
  } catch (error) {
    if (!isCredentialDecryptError(error)) throw error;
    await credentialStore.updateMany({
      ...Object.fromEntries(LOGIN_SESSION_KEYS.map((key) => [key, null] as const)),
      [SHARED_ZCODE_CREDENTIAL_KEYS.sessionRevision]: createLoginSessionRevision(),
    });
    return await credentialStore.loadMany(LOGIN_SESSION_KEYS);
  }
}

/** 一次登录要落的字段。缺失的 refresh token 不写键，保持既有值的字段级合并语义。 */
export interface LoginSessionChange {
  readonly accessToken: string;
  readonly providerId: LoginProviderId;
  readonly refreshToken?: string;
  readonly userInfoRaw: string;
  readonly zcodeJwtToken: string;
}

/**
 * 一次登录 = 一次整组提交 + 版本轮换。
 *
 * 返回 false 表示快照已被别的会话改写（正常竞态，不抛错）：本次一个键都没写，调用方必须
 * 丢弃结果并提示重新登录。成功提交必然轮换版本键，使其他进程手里的旧快照下次提交必失败。
 */
export async function commitLoginSessionChange(
  credentialStore: Pick<SharedZCodeCredentialStore, "updateMany">,
  snapshot: CredentialSnapshot,
  change: LoginSessionChange,
): Promise<boolean> {
  const providerKeys = loginProviderKeys(change.providerId);
  const changes: Record<string, string | null> = {
    [SHARED_ZCODE_CREDENTIAL_KEYS.activeProvider]: change.providerId,
    [SHARED_ZCODE_CREDENTIAL_KEYS.zcodeJwtToken]: change.zcodeJwtToken,
    [providerKeys.accessToken]: change.accessToken,
    [providerKeys.userInfo]: change.userInfoRaw,
    [SHARED_ZCODE_CREDENTIAL_KEYS.sessionRevision]: createLoginSessionRevision(),
  };
  if (change.refreshToken) changes[providerKeys.refreshToken] = change.refreshToken;
  return await credentialStore.updateMany(changes, { expected: snapshot });
}

/** 账号连接凭据组的键（CLI 私有命名空间，与 OAuth 会话键分开提交）。 */
export interface StandaloneAccountCredentialKeys {
  readonly apiKeyCredentialKey: string;
  readonly identityCredentialKey: string;
}

export interface StandaloneAccountCredentials extends StandaloneAccountCredentialKeys {
  readonly accountIdentity: string;
  readonly apiKey: string;
}

/**
 * 账号连接凭据组的快照。
 *
 * 除本组两个键外，还要比较会话版本键：`account-provider:<provider>:identity` 决定运行时用
 * 哪个账号的 API Key，而 Host 的 OAuth 登录会整体换掉当前账号（且不写这个键）。若不看版本
 * 键，CLI 的旧响应会把 identity 改回上一个账号 —— 这正是「CLI 覆盖 Host 新登录」的另一条路径。
 *
 * 快照里只要有一个键解不开，每次登录都会卡在读取处；因此按「密文解不开」错误码做一次自愈：
 * 逐键复检定位坏键，交给 store 在锁内再确认一次仍损坏才删，然后重取快照。只删坏键、可读的
 * 值留在快照里继续充当 CAS 期望值；存储不可用不是坏密文，直接上抛。自愈后仍读不出来时抛带
 * credential_unreadable 码的错误，避免把「凭据解不开」伪装成配置写入失败。
 */
export async function captureStandaloneAccountSnapshot(
  credentialStore: Pick<SharedZCodeCredentialStore, "deleteUnreadable" | "load" | "loadMany">,
  keys: StandaloneAccountCredentialKeys,
): Promise<CredentialSnapshot> {
  const snapshotKeys = [
    keys.identityCredentialKey,
    keys.apiKeyCredentialKey,
    SHARED_ZCODE_CREDENTIAL_KEYS.sessionRevision,
  ];
  try {
    return await credentialStore.loadMany(snapshotKeys);
  } catch (error) {
    // 只按错误码判定可清理：按文案判定会把「存储不可用」也算成坏密文，误删别的进程的凭据。
    if (!isCredentialDecryptError(error)) throw error;
    // 批量读取只报「有值解不开」、不说是哪个键：逐键复检，避免把可读的组键一并删掉。
    const unreadableKeys: string[] = [];
    for (const key of snapshotKeys) {
      try {
        await credentialStore.load(key);
      } catch (keyError) {
        if (!isCredentialDecryptError(keyError)) throw keyError;
        unreadableKeys.push(key);
      }
    }
    if (unreadableKeys.length > 0) await credentialStore.deleteUnreadable(unreadableKeys);
    try {
      return await credentialStore.loadMany(snapshotKeys);
    } catch (retryError) {
      if (!isCredentialDecryptError(retryError)) throw retryError;
      throw new ZCodeCliLoginError(
        "credential_unreadable",
        "Stored account credentials cannot be decrypted after automatic repair. " +
          "Retry login; if the error persists, delete the shared credentials file and sign in again.",
        { cause: retryError },
      );
    }
  }
}

/**
 * 账号连接凭据组的整组提交。
 *
 * 不轮换会话版本：本组不是 OAuth 会话本体，轮换会让 Host 的刷新事务无谓失败；但版本键在
 * 期望集合里，因此期间发生的登录仍会让本次提交整体作废。
 */
export async function commitStandaloneAccountCredentials(
  credentialStore: Pick<SharedZCodeCredentialStore, "updateMany">,
  snapshot: CredentialSnapshot,
  credentials: StandaloneAccountCredentials,
): Promise<boolean> {
  return await credentialStore.updateMany(
    {
      [credentials.identityCredentialKey]: credentials.accountIdentity,
      [credentials.apiKeyCredentialKey]: credentials.apiKey,
    },
    { expected: snapshot },
  );
}

function loginProviderKeys(providerId: LoginProviderId): {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly userInfo: string;
} {
  return providerId === "zai"
    ? {
        accessToken: SHARED_ZCODE_CREDENTIAL_KEYS.zaiAccessToken,
        refreshToken: SHARED_ZCODE_CREDENTIAL_KEYS.zaiRefreshToken,
        userInfo: SHARED_ZCODE_CREDENTIAL_KEYS.zaiUserInfo,
      }
    : {
        accessToken: SHARED_ZCODE_CREDENTIAL_KEYS.bigmodelAccessToken,
        refreshToken: SHARED_ZCODE_CREDENTIAL_KEYS.bigmodelRefreshToken,
        userInfo: SHARED_ZCODE_CREDENTIAL_KEYS.bigmodelUserInfo,
      };
}
