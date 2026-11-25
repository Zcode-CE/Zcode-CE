/* eslint-disable max-lines -- OAuth 凭据仓储集中维护 ZAI/BigModel 登录镜像 key 边界，拆分会让鉴权事实源更难追踪。 */
import { Buffer } from "node:buffer";
import type {
  OAuthLoginAttribution,
  OAuthProviderId,
  OAuthTokenSet,
  OAuthUserProfile,
} from "@zcode/shared";
import { BIGMODEL_PROVIDER_ID, isCredentialDecryptError, ZAI_PROVIDER_ID } from "@zcode/shared";
import {
  OAUTH_SESSION_REVISION_KEY,
  type OAuthSessionCredentialService,
} from "../../credential/credential.js";
import {
  commitCredentialSessionChange,
  type CommitCredentialSessionChangeOptions,
} from "../../credential/credentialSessionRevision.js";
import { createServiceLogger } from "../../logger/serviceLogger.js";

const ACTIVE_PROVIDER_KEY = "oauth:active_provider";
const LOGIN_ATTRIBUTION_KEY = "oauth:login_attribution";
const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";
const KNOWN_OAUTH_PROVIDER_IDS = [BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID] as const;
const log = createServiceLogger("oauthCredentialRepo");

interface OAuthCredentialRepoOptions {
  providerIds?: readonly OAuthProviderId[];
  onCorruptOAuthSessionCleared?: (providerIds: readonly OAuthProviderId[]) => Promise<void>;
}

/** OAuth 会话快照：会话键的明文集合（含版本键）。提交时整组比较，任何键被并发改过就丢弃本次结果。 */
export interface OAuthCredentialSnapshot {
  readonly values: Readonly<Record<string, string | null>>;
}

/**
 * 单个 provider 的字段级变更：`undefined` = 本次不动该字段，`null` = 清除。
 * tokenSet 覆盖 access/refresh 与共享的 zcode JWT，profile 覆盖 user_info。
 */
export interface OAuthProviderSessionChange {
  readonly provider: OAuthProviderId;
  readonly tokenSet?: OAuthTokenSet | null;
  readonly profile?: OAuthUserProfile | null;
}

/**
 * 一次会话提交的字段级增量（登录、刷新、切号、登出、恢复都走它）。
 *
 * providers 按数组顺序应用：登录先清旧 provider 再写新 token，共享的 zcodejwttoken
 * 才不会在切换过程中被自己的清理删掉。
 */
export interface OAuthSessionChange {
  readonly activeProvider?: OAuthProviderId | null;
  readonly providers?: readonly OAuthProviderSessionChange[];
}

function accessTokenKey(provider: OAuthProviderId): string {
  return `oauth:${provider}:access_token`;
}

function refreshTokenKey(provider: OAuthProviderId): string {
  return `oauth:${provider}:refresh_token`;
}

function userInfoKey(provider: OAuthProviderId): string {
  return `oauth:${provider}:user_info`;
}

function usesZcodeJwt(provider: OAuthProviderId): boolean {
  return provider === ZAI_PROVIDER_ID || provider === BIGMODEL_PROVIDER_ID;
}

function collectKnownOAuthProviderIds(
  providerIds: readonly OAuthProviderId[] = [],
): OAuthProviderId[] {
  const uniqueProviderIds = new Set<OAuthProviderId>(KNOWN_OAUTH_PROVIDER_IDS);
  for (const providerId of providerIds) {
    uniqueProviderIds.add(providerId);
  }
  return [...uniqueProviderIds];
}

function asOAuthProviderId(value: string | null | undefined): OAuthProviderId | null {
  const trimmed = value?.trim();
  return trimmed ? (trimmed as OAuthProviderId) : null;
}

function tokenKeys(provider: OAuthProviderId): string[] {
  const keys = [accessTokenKey(provider), refreshTokenKey(provider)];
  if (usesZcodeJwt(provider)) {
    keys.push(ZCODE_JWT_TOKEN_KEY);
  }
  return keys;
}

/** access token 是否存在决定「是否登录」，其余字段只是它的补充。 */
function tokenSetFromValues(
  values: Readonly<Record<string, string | null | undefined>>,
  provider: OAuthProviderId,
): OAuthTokenSet | null {
  const accessToken = values[accessTokenKey(provider)] ?? null;
  if (!accessToken) {
    return null;
  }
  const refreshToken = values[refreshTokenKey(provider)] ?? null;
  const zcodeJwtToken = usesZcodeJwt(provider) ? (values[ZCODE_JWT_TOKEN_KEY] ?? null) : null;
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(zcodeJwtToken ? { zcodeJwtToken } : {}),
  };
}

/** ZAI 后端 data.user 是账号态排查与恢复的源数据；只存归一化展示字段会丢 email/name/avatar 原结构。 */
function persistableProfile(provider: OAuthProviderId, profile: OAuthUserProfile): unknown {
  return provider === ZAI_PROVIDER_ID && profile.rawProfile ? profile.rawProfile : profile;
}

/**
 * 把字段级变更展开成键值变更：`null` 表示删除该键。
 * 同一键被多次写入时由调用方按数组顺序合并（后写覆盖先写）。
 */
function providerChanges(change: OAuthProviderSessionChange): Record<string, string | null> {
  const changes: Record<string, string | null> = {};
  if (change.tokenSet !== undefined) {
    changes[accessTokenKey(change.provider)] = change.tokenSet ? change.tokenSet.accessToken : null;
    changes[refreshTokenKey(change.provider)] = change.tokenSet?.refreshToken ?? null;
    if (usesZcodeJwt(change.provider)) {
      changes[ZCODE_JWT_TOKEN_KEY] = change.tokenSet?.zcodeJwtToken ?? null;
    }
  }
  if (change.profile !== undefined) {
    changes[userInfoKey(change.provider)] =
      change.profile === null
        ? null
        : JSON.stringify(persistableProfile(change.provider, change.profile));
  }
  return changes;
}

function inferBase64ImageMimeType(decoded: Buffer): string {
  if (
    decoded.length >= 8 &&
    decoded[0] === 0x89 &&
    decoded[1] === 0x50 &&
    decoded[2] === 0x4e &&
    decoded[3] === 0x47
  ) {
    return "image/png";
  }

  if (decoded.length >= 3 && decoded[0] === 0xff && decoded[1] === 0xd8 && decoded[2] === 0xff) {
    return "image/jpeg";
  }

  if (decoded.length >= 6 && decoded.toString("ascii", 0, 3) === "GIF") {
    return "image/gif";
  }

  if (
    decoded.length >= 12 &&
    decoded.toString("ascii", 0, 4) === "RIFF" &&
    decoded.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }

  return "image/png";
}

function toBase64ImageDataUrl(raw: string): string | null {
  const normalized = raw.replace(/\s/g, "");
  if (normalized.length < 16 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    return null;
  }

  const decoded = Buffer.from(normalized, "base64");
  if (decoded.length === 0) {
    return null;
  }

  const encoded = decoded.toString("base64").replace(/=+$/, "");
  if (encoded !== normalized.replace(/=+$/, "")) {
    return null;
  }

  return `data:${inferBase64ImageMimeType(decoded)};base64,${normalized}`;
}

function normalizeStoredZaiAvatarUrl(avatar: string | undefined): string | undefined {
  const trimmed = avatar?.trim();
  if (!trimmed) {
    return undefined;
  }

  if (/^data:image\/[^;]+;base64,/i.test(trimmed) || /^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  const dataUrl = toBase64ImageDataUrl(trimmed);
  if (dataUrl) {
    return dataUrl;
  }

  return trimmed;
}

function toOAuthUserProfileFromRawZaiUser(raw: Record<string, unknown>): OAuthUserProfile | null {
  const id = typeof raw.user_id === "string" ? raw.user_id : "unknown";
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const email = typeof raw.email === "string" ? raw.email : "";
  const username = name || email || id;
  const avatarUrl = normalizeStoredZaiAvatarUrl(
    typeof raw.avatar === "string" ? raw.avatar : undefined,
  );

  if (!name && !email && id === "unknown") {
    return null;
  }

  return {
    id,
    username,
    displayName: username,
    ...(avatarUrl ? { avatarUrl } : {}),
    rawProfile: raw,
  };
}

/** 解析已落盘的 user_info 明文；解析失败按「没有可信 profile」处理，不抛错。 */
function parseStoredUserProfile(
  raw: string | null | undefined,
  provider: OAuthProviderId,
): OAuthUserProfile | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<OAuthUserProfile>;
    if (
      typeof parsed.id === "string" &&
      typeof parsed.username === "string" &&
      typeof parsed.displayName === "string"
    ) {
      const avatarUrl = typeof parsed.avatarUrl === "string" ? parsed.avatarUrl : undefined;
      const rawProfile =
        typeof parsed.rawProfile === "object" && parsed.rawProfile !== null
          ? parsed.rawProfile
          : undefined;
      return {
        id: parsed.id,
        username: parsed.username,
        displayName: parsed.displayName,
        ...(avatarUrl ? { avatarUrl } : {}),
        ...(rawProfile ? { rawProfile } : {}),
      };
    }

    if (provider === ZAI_PROVIDER_ID && typeof parsed === "object" && parsed !== null) {
      // ZAI user_info 现在按后端 data.user 原样持久化，
      // 启动恢复时需要从 user_id/name/avatar 重新映射展示字段。
      const zaiProfile = toOAuthUserProfileFromRawZaiUser(parsed as Record<string, unknown>);
      if (zaiProfile) {
        return zaiProfile;
      }
    }
  } catch {
    // ignore parse error and fallback to null
  }

  return null;
}

/**
 * OAuth 凭据仓储：统一 provider 命名空间。
 *
 * 写入全部走 SPEC §7 的批量契约：先从会话快照读明文，再在字段级合并，最后以整组 CAS +
 * 版本轮换提交。不这样做的代价很具体 —— 登录要写 token、user_info、active provider 三组键，
 * 逐键写入时另一个进程的登录能插进中间，落盘出「A 的 token + B 的 profile」；
 * 读-改-写还要求「读到的值」就是「比较的值」，所以快照与提交必须由同一份明文驱动。
 */
export class OAuthCredentialRepo {
  private readonly knownProviderIds: OAuthProviderId[];

  constructor(
    private credentialService: OAuthSessionCredentialService,
    options: OAuthCredentialRepoOptions = {},
  ) {
    this.knownProviderIds = collectKnownOAuthProviderIds(options.providerIds);
    this.onCorruptOAuthSessionCleared = options.onCorruptOAuthSessionCleared;
  }

  private readonly onCorruptOAuthSessionCleared?: (
    providerIds: readonly OAuthProviderId[],
  ) => Promise<void>;

  async getActiveProvider(): Promise<OAuthProviderId | null> {
    return await this.loadActiveProvider();
  }

  async loadActiveProvider(): Promise<OAuthProviderId | null> {
    const values = await this.loadValues([ACTIVE_PROVIDER_KEY]);
    return asOAuthProviderId(values[ACTIVE_PROVIDER_KEY]);
  }

  async loadActiveUserProfile(): Promise<OAuthUserProfile | null> {
    const provider = await this.getActiveProvider();
    return provider ? await this.loadUserProfile(provider) : null;
  }

  async loadTokenSet(provider: OAuthProviderId): Promise<OAuthTokenSet | null> {
    return tokenSetFromValues(await this.loadValues(tokenKeys(provider)), provider);
  }

  async loadUserProfile(provider: OAuthProviderId): Promise<OAuthUserProfile | null> {
    const values = await this.loadValues([userInfoKey(provider)]);
    return parseStoredUserProfile(values[userInfoKey(provider)], provider);
  }

  async loadLoginAttribution(): Promise<OAuthLoginAttribution | null> {
    let raw: string | null;
    try {
      raw = await this.credentialService.load(LOGIN_ATTRIBUTION_KEY);
    } catch (error) {
      // 归因是旁路事实：它解不开不等于登录失效，不能因为一条归因密文损坏就把用户强制登出。
      if (!isCredentialDecryptError(error)) {
        throw error;
      }
      return null;
    }

    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      // 兼容本分支早期保存过的 { params, expiresAt } 结构；取消 TTL 后只读取 params。
      const storedParams =
        parsed.params && typeof parsed.params === "object"
          ? (parsed.params as Record<string, unknown>)
          : parsed;

      const params = Object.fromEntries(
        Object.entries(storedParams).flatMap(([key, value]) =>
          (key === "channel_id" || key === "utm_source" || key === "utm_campaign") &&
          typeof value === "string" &&
          value.trim()
            ? [[key, value.trim()]]
            : [],
        ),
      ) as OAuthLoginAttribution;
      if (Object.keys(params).length === 0) {
        await this.credentialService.updateMany({ [LOGIN_ATTRIBUTION_KEY]: null });
        return null;
      }
      return params;
    } catch {
      await this.credentialService.updateMany({ [LOGIN_ATTRIBUTION_KEY]: null });
      return null;
    }
  }

  async saveLoginAttribution(attribution: OAuthLoginAttribution): Promise<void> {
    const persistAttribution = Object.fromEntries(
      Object.entries(attribution).flatMap(([key, value]) => {
        const trimmed = typeof value === "string" ? value.trim() : "";
        return trimmed ? [[key, trimmed]] : [];
      }),
    );

    if (Object.keys(persistAttribution).length === 0) {
      return;
    }

    // 归因是旁路事实：它既不在会话快照里，也不轮换版本键 —— 归因回调常先于授权码到达，
    // 若它轮换版本，同一 flow 的登录提交会以必然过期的快照失败，用户永远登不进去。
    await this.credentialService.updateMany({
      [LOGIN_ATTRIBUTION_KEY]: JSON.stringify(persistAttribution),
    });
  }

  /**
   * 读取当前会话快照（登录/刷新开始时调用）。
   * 额外的 providers 用于 active provider 来自旧版本、不在已知列表里的情况：
   * 快照必须包含本次事务要比较的全部键，否则那条 provider 的写入等于没有 CAS。
   */
  async captureSessionSnapshot(
    providers: readonly OAuthProviderId[] = [],
  ): Promise<OAuthCredentialSnapshot> {
    return { values: await this.loadValues(this.sessionKeys(providers)) };
  }

  readActiveProvider(snapshot: OAuthCredentialSnapshot): OAuthProviderId | null {
    return asOAuthProviderId(snapshot.values[ACTIVE_PROVIDER_KEY]);
  }

  readTokenSet(snapshot: OAuthCredentialSnapshot, provider: OAuthProviderId): OAuthTokenSet | null {
    return tokenSetFromValues(snapshot.values, provider);
  }

  readUserProfile(
    snapshot: OAuthCredentialSnapshot,
    provider: OAuthProviderId,
  ): OAuthUserProfile | null {
    return parseStoredUserProfile(snapshot.values[userInfoKey(provider)], provider);
  }

  readZcodeJwtToken(snapshot: OAuthCredentialSnapshot): string | null {
    return snapshot.values[ZCODE_JWT_TOKEN_KEY] ?? null;
  }

  /**
   * 整组提交一次会话变更（SPEC §7.3）：字段级合并 + 整组 CAS + 版本轮换。
   *
   * 返回 false = 快照已被别的会话改写，本次一个键都没写（不是故障，调用方按当前存储重读）；
   * snapshot 为 null 表示强制提交（登出、损坏恢复）：不比较期望值，只轮换版本让在途事务失效。
   */
  async commitSessionChange(
    snapshot: OAuthCredentialSnapshot | null,
    change: OAuthSessionChange,
    options: CommitCredentialSessionChangeOptions = {},
  ): Promise<boolean> {
    const changes: Record<string, string | null> = {};
    if (change.activeProvider !== undefined) {
      changes[ACTIVE_PROVIDER_KEY] = change.activeProvider;
    }
    for (const providerChange of change.providers ?? []) {
      Object.assign(changes, providerChanges(providerChange));
    }
    if (Object.keys(changes).length === 0) {
      // 没有字段变化就不写盘：空提交若也轮换版本，会让所有在途事务无谓失效。
      return true;
    }

    const committed = await commitCredentialSessionChange(
      this.credentialService,
      snapshot?.values ?? {},
      changes,
      options,
    );
    if (!committed) {
      log.info(undefined, "OAuth session commit discarded: stored snapshot changed");
    }
    return committed;
  }

  /**
   * 清理当前会话（登出、过期 JWT 失效）。
   *
   * 传快照时只有快照仍成立才提交 —— 期间另一进程写入了新登录就放弃清理、由调用方重读；
   * 不传快照表示强制清理（用户主动登出、损坏恢复），不能被并发写挡住。
   */
  async clearActiveSession(snapshot?: OAuthCredentialSnapshot): Promise<boolean> {
    const base = snapshot ?? (await this.captureSessionSnapshot());
    const activeProvider = this.readActiveProvider(base);
    return await this.commitSessionChange(snapshot ?? null, {
      activeProvider: null,
      providers: activeProvider
        ? [{ provider: activeProvider, tokenSet: null, profile: null }]
        : [],
    });
  }

  /** 清空全部 provider 与 active provider（登出全部、损坏恢复）。强制提交，但轮换版本键。 */
  async clearAll(providers: readonly OAuthProviderId[]): Promise<void> {
    await this.commitSessionChange(null, {
      activeProvider: null,
      providers: providers.map((provider) => ({ provider, tokenSet: null, profile: null })),
    });
  }

  /** 只清 active provider 键（provider 已不可用时启动恢复的收口动作）。 */
  async clearActiveProvider(): Promise<void> {
    await this.commitSessionChange(null, { activeProvider: null });
  }

  /**
   * 批量明文读（SPEC §7.1 loadMany）：单键读取也走它，损坏处理只有一处。
   *
   * 解密失败按既有语义等价于强制登出：OAuth 命名空间已不可信，清掉后本次会话视为空；
   * 密钥来源不可用等其他错误照常上抛，不能被当成「没登录」。
   */
  private async loadValues(keys: readonly string[]): Promise<Record<string, string | null>> {
    try {
      return await this.credentialService.loadMany(keys);
    } catch (error) {
      if (!isCredentialDecryptError(error)) {
        throw error;
      }
      await this.clearCorruptOAuthSession();
      // 清完重新读：清理本身会轮换版本键，返回「全 null」的快照会与磁盘不符，
      // 后续以自己的快照提交的登录就会永远 CAS 失败（用户表现为「修好了却登不进去」）。
      return await this.credentialService.loadMany(keys);
    }
  }

  /** 会话键：批量提交的比较集合。归因键不在这里（旁路事实，见 saveLoginAttribution）。 */
  private sessionKeys(extraProviders: readonly OAuthProviderId[]): string[] {
    const providers = new Set<OAuthProviderId>([...this.knownProviderIds, ...extraProviders]);
    return [
      ACTIVE_PROVIDER_KEY,
      OAUTH_SESSION_REVISION_KEY,
      ZCODE_JWT_TOKEN_KEY,
      ...[...providers].flatMap((provider) => [
        accessTokenKey(provider),
        refreshTokenKey(provider),
        userInfoKey(provider),
      ]),
    ];
  }

  private async clearCorruptOAuthSession(): Promise<void> {
    // AES-GCM 解密失败说明当前运行时已经无法信任本地 OAuth 登录态。
    // 等价于强制登出已注册 OAuth provider：清 provider 命名空间与共享 zcode JWT，并轮换版本键，
    // 让在途登录/刷新事务的期望值全部失效；SSH、插件、bot 等其他独立凭据不受影响，也不误删。
    await this.clearAll(this.knownProviderIds);
    try {
      await this.onCorruptOAuthSessionCleared?.(this.knownProviderIds);
    } catch (error) {
      // 派生模型 provider 清理失败不能阻断 OAuth 损坏态恢复。
      // 主 OAuth 凭据已经删除，用户必须能回到可重新登录的未登录态。
      log.warn(undefined, "clear derived provider keys after corrupt OAuth session failed", error);
    }
  }
}
