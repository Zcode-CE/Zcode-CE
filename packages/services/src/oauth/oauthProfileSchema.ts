import {
  BIGMODEL_PROVIDER_ID,
  type OAuthProviderId,
  type OAuthTokenSet,
  type OAuthUserProfile,
} from "@zcode/shared";
import type { OAuthProviderAdapter } from "./providers/index.js";

const BIGMODEL_PROFILE_SCHEMA_VERSION = 2;
const BIGMODEL_PROFILE_MIGRATION_RETRY_DELAY_MS = 60 * 60 * 1000;

interface RefreshLegacyBigModelCachedProfileOptions {
  adapter: OAuthProviderAdapter;
  cachedProfile: OAuthUserProfile;
  loadTokenSet: () => Promise<OAuthTokenSet | null>;
  saveProfile: (profile: OAuthUserProfile) => Promise<void>;
  now: () => number;
  runWithAdapterError: <T>(run: () => Promise<T>) => Promise<T>;
}

function getCachedProfileSchemaVersion(profile: OAuthUserProfile): number | null {
  const rawProfile = profile.rawProfile;
  if (!rawProfile || typeof rawProfile !== "object") {
    return null;
  }

  const version = (rawProfile as { zcodeProfileSchemaVersion?: unknown }).zcodeProfileSchemaVersion;
  return typeof version === "number" ? version : null;
}

function getCachedProfileMigrationRetryAfter(profile: OAuthUserProfile): number | null {
  const rawProfile = profile.rawProfile;
  if (!rawProfile || typeof rawProfile !== "object") {
    return null;
  }

  const retryAfter = (rawProfile as { zcodeProfileMigrationRetryAfter?: unknown })
    .zcodeProfileMigrationRetryAfter;
  return typeof retryAfter === "number" ? retryAfter : null;
}

function isBigModelUserInfoFallback(profile: OAuthUserProfile): boolean {
  return profile.id === "unknown" && profile.username === "user" && profile.displayName === "User";
}

/**
 * 上游业务 userinfo 只拥有展示字段；customerNumber 或 sub 不能成为 ZCode 资产主体。
 *
 * 字段级合并（与上游逐字一致）：主体 id 与 rawProfile 保持缓存值，只取 username / displayName /
 * avatarUrl。业务 userinfo 拿不到头像时保留缓存头像，不能把已有展示清空。
 */
// Modified by ZCode: 自上游 zai-org/ZCode v3.18.2 (fec97590, Apache-2.0) 并入 OAuth 展示字段合并 ——
// 业务 userinfo 只拥有展示字段，主体 id 与 rawProfile 始终来自本地可信缓存。
export function mergeOAuthDisplayProfile(
  cachedProfile: OAuthUserProfile,
  businessProfile: OAuthUserProfile,
): OAuthUserProfile {
  if (isBigModelUserInfoFallback(businessProfile)) return cachedProfile;
  return {
    ...cachedProfile,
    username: businessProfile.username,
    displayName: businessProfile.displayName,
    ...(businessProfile.avatarUrl ? { avatarUrl: businessProfile.avatarUrl } : {}),
  };
}

/**
 * 远端 userinfo 刷新未能落盘的原因。
 *
 * - missing-trusted-profile：本地没有可信主身份，调用方必须走重新登录（计划里的 require-relogin）。
 * - stored-identity-changed：刷新期间主身份已被并发会话换掉，落盘会覆盖新会话（计划里的 reject）。
 */
export type OAuthProfileRefreshRejection = "missing-trusted-profile" | "stored-identity-changed";

/**
 * 刷新结果与本地主身份冲突时的显式拒绝。
 *
 * 之前 restoreSession 把远端 userinfo 整份写回 user_info：业务 userinfo 的账号标识（BigModel
 * customerNumber / ZAI sub）变成主身份后，设备、关联与额度都会指向另一个账号。拒绝必须可诊断，
 * 不能只返回 null 让调用方猜原因；调用方拿到本错误时不得再落盘，原凭据保持可读。
 */
export class OAuthProfileIdentityMismatchError extends Error {
  readonly code = "oauth_profile_identity_mismatch";
  readonly provider: OAuthProviderId;
  readonly reason: OAuthProfileRefreshRejection;
  readonly expectedUserId: string | null;
  readonly observedUserId: string | null;

  constructor(input: {
    provider: OAuthProviderId;
    reason: OAuthProfileRefreshRejection;
    expectedUserId: string | null;
    observedUserId: string | null;
  }) {
    super(
      `OAuth profile refresh rejected (${input.reason}): provider=${input.provider} expected=${
        input.expectedUserId ?? "none"
      } observed=${input.observedUserId ?? "none"}`,
    );
    this.name = "OAuthProfileIdentityMismatchError";
    this.provider = input.provider;
    this.reason = input.reason;
    this.expectedUserId = input.expectedUserId;
    this.observedUserId = input.observedUserId;
  }
}

/** 一次远端 userinfo 刷新的落盘计划：写展示字段、要求重新登录，或显式拒绝。 */
export type OAuthProfileRefreshPlan =
  | { action: "persist"; profile: OAuthUserProfile }
  | { action: "require-relogin"; reason: OAuthProfileRefreshRejection }
  | { action: "reject"; error: OAuthProfileIdentityMismatchError };

function hasTrustedProfileIdentity(profile: OAuthUserProfile | null): profile is OAuthUserProfile {
  return Boolean(profile && profile.id !== "unknown");
}

/**
 * 计算远端 userinfo 刷新能否落盘，并给出落盘时该写的 profile。
 *
 * - 缺少可信主身份（无缓存或缓存是 unknown/User 哨兵）时要求重新登录：不从业务 userinfo 的
 *   customerNumber / sub 构造主身份，与上游"缺少可信缓存时必须重新登录"一致。
 * - 刷新期间主身份被并发登录、退出或切换改掉时拒绝写入：旧刷新结果只能补充原主体，
 *   不能把旧 JWT 与另一个 user ID 组合成新登录，也不能覆盖新会话的凭据。
 * - 其余情况做展示字段合并，主体字段（id / rawProfile）始终来自本地可信缓存。
 *
 * 合并基线取队列内重读到的 currentProfile（与 cachedProfile 同主体，但可能带上并发刷新写入的
 * 展示字段）；上游在快照上合并，这里只把基线换成更新的一份，不改变"只更新展示字段"的语义。
 */
export function planOAuthProfileRefresh(input: {
  provider: OAuthProviderId;
  cachedProfile: OAuthUserProfile | null;
  currentProfile: OAuthUserProfile | null;
  fetchedProfile: OAuthUserProfile;
}): OAuthProfileRefreshPlan {
  const { provider, cachedProfile, currentProfile, fetchedProfile } = input;
  if (!hasTrustedProfileIdentity(cachedProfile)) {
    return { action: "require-relogin", reason: "missing-trusted-profile" };
  }
  if (!hasTrustedProfileIdentity(currentProfile) || currentProfile.id !== cachedProfile.id) {
    return {
      action: "reject",
      error: new OAuthProfileIdentityMismatchError({
        provider,
        reason: "stored-identity-changed",
        expectedUserId: cachedProfile.id,
        observedUserId: currentProfile?.id ?? null,
      }),
    };
  }
  return {
    action: "persist",
    profile: mergeOAuthDisplayProfile(currentProfile, fetchedProfile),
  };
}

function getErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

function shouldCompleteMigrationAfterError(error: unknown): boolean {
  const status = getErrorStatus(error);
  return status === 401 || status === 403;
}

export function withProviderProfileSchema(
  provider: OAuthProviderId,
  profile: OAuthUserProfile,
): OAuthUserProfile {
  if (provider !== BIGMODEL_PROVIDER_ID) {
    return profile;
  }

  const rawProfile =
    profile.rawProfile && typeof profile.rawProfile === "object" ? profile.rawProfile : {};
  const nextRawProfile = { ...(rawProfile as Record<string, unknown>) };
  delete nextRawProfile.zcodeProfileMigrationRetryAfter;

  return {
    ...profile,
    rawProfile: {
      ...nextRawProfile,
      zcodeProfileSchemaVersion: BIGMODEL_PROFILE_SCHEMA_VERSION,
    },
  };
}

function withBigModelProfileMigrationRetryAfter(
  profile: OAuthUserProfile,
  now: number,
): OAuthUserProfile {
  const rawProfile =
    profile.rawProfile && typeof profile.rawProfile === "object" ? profile.rawProfile : {};

  return {
    ...profile,
    rawProfile: {
      ...(rawProfile as Record<string, unknown>),
      zcodeProfileMigrationRetryAfter: now + BIGMODEL_PROFILE_MIGRATION_RETRY_DELAY_MS,
    },
  };
}

export async function refreshLegacyBigModelCachedProfile(
  options: RefreshLegacyBigModelCachedProfileOptions,
): Promise<OAuthUserProfile> {
  const { adapter, cachedProfile, loadTokenSet, now, runWithAdapterError, saveProfile } = options;
  if (
    (getCachedProfileSchemaVersion(cachedProfile) ?? 0) >= BIGMODEL_PROFILE_SCHEMA_VERSION ||
    (getCachedProfileMigrationRetryAfter(cachedProfile) ?? 0) > now() ||
    !adapter.fetchUserInfo
  ) {
    return cachedProfile;
  }

  const tokenSet = await loadTokenSet();
  if (!tokenSet) {
    await saveProfile(withProviderProfileSchema(BIGMODEL_PROVIDER_ID, cachedProfile));
    return cachedProfile;
  }

  try {
    // BigModel 旧缓存只保存 nickName，升级后 restoreCachedSession 会绕过
    // fetchUserInfo。这里对无版本缓存做 best-effort 刷新，失败仍保留本地登录态。
    const refreshedProfile = await runWithAdapterError(() =>
      adapter.fetchUserInfo!(tokenSet, {
        providerId: BIGMODEL_PROVIDER_ID,
        state: "",
        redirectUri: adapter.redirectUri,
        now,
      }),
    );
    if (isBigModelUserInfoFallback(refreshedProfile)) {
      // 旧版本可能把 zcode JWT 写进 BigModel access token。
      // adapter 会返回 unknown/User 哨兵值表示无法查 BigModel 用户信息；
      // 迁移不能把已有可信缓存覆盖成这个哨兵值，否则版本标记会永久固化错误展示名。
      await saveProfile(withProviderProfileSchema(BIGMODEL_PROVIDER_ID, cachedProfile));
      return cachedProfile;
    }
    // BigModel customerNumber 属于业务账号，不能覆盖已保存的 ZCode 主体。
    // 旧迁移把整份业务 profile 回写，两个 ID 不同时会让设备、关联和资产被当成另一账号。
    const migratedProfile = withProviderProfileSchema(
      BIGMODEL_PROVIDER_ID,
      mergeOAuthDisplayProfile(cachedProfile, refreshedProfile),
    );
    await saveProfile(migratedProfile);
    return migratedProfile;
  } catch (error) {
    if (shouldCompleteMigrationAfterError(error)) {
      await saveProfile(withProviderProfileSchema(BIGMODEL_PROVIDER_ID, cachedProfile));
      return cachedProfile;
    }

    // 离线、超时或 5xx 只是暂时性失败，不能永久写入 schema version 2。
    // 写入 retry-after 可避免每次启动都打 userinfo，同时保留后续成功迁移机会。
    await saveProfile(withBigModelProfileMigrationRetryAfter(cachedProfile, now()));
    return cachedProfile;
  }
}
