/* eslint-disable max-lines -- OAuthService 集中维护 OAuth 会话生命周期和 provider 切换边界，当前 review 修复只收窄后台迁移写入条件。 */
import { randomBytes } from "node:crypto";
import {
  ApiError,
  formatLogPrefix,
  type ApiClient,
  BIGMODEL_PROVIDER_ID,
  ZAI_PROVIDER_ID,
  type OAuthCallbackResult,
  type OAuthCachedSessionRestoreResult,
  type OAuthProviderId,
  type OAuthProviderMeta,
  type OAuthStartResponse,
  type OAuthTokenSet,
  type OAuthUserProfile,
  type UserInfo,
  resolveJwtExpiration,
} from "@zcode/shared";
import type { OAuthSessionCredentialService } from "../credential/credential.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { readApiJson } from "../providers/api/apiJson.js";
import type { IOAuthService } from "./oauth.js";
import { isCurrentOAuthCredentialRequest } from "#src/oauth/oauthUnauthorizedRequest.js";
import { hasOAuthAuthorizationCode, parseOAuthLoginAttribution } from "./callbackAttribution.js";
import {
  planOAuthProfileRefresh,
  refreshLegacyBigModelCachedProfile,
  withProviderProfileSchema,
} from "./oauthProfileSchema.js";
import { createOAuthProviderAdapters, type OAuthProviderAdapter } from "./providers/index.js";
import { OAuthCredentialRepo, type OAuthCredentialSnapshot } from "./repo/oauthCredentialRepo.js";
import { createOAuthRuntimeConfig } from "./runtimeConfig.js";
import {
  buildDesktopOAuthRedirectUriFromEnv,
  buildZCodeApiUrlFromEnv,
} from "./providers/configUtils.js";

/** OAuth 超时时间（5 分钟） */
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const COMPLETED_POLLING_STATE_GRACE_MS = 30 * 1000;
const log = (...args: unknown[]) =>
  console.log(formatLogPrefix("oauthService", process.pid), ...args);
const serviceLog = createServiceLogger("oauthService");

interface PendingState {
  state: string;
  provider: OAuthProviderId;
  timeout: NodeJS.Timeout;
  phase: "awaiting-attribution-or-code" | "awaiting-code-after-attribution";
  /**
   * 发起登录时读到的会话快照：授权期间可能已有另一进程完成登录，
   * 完成提交以它为 CAS 期望值，旧响应用过期快照提交必然失败（SPEC §7.3）。
   */
  snapshot: OAuthCredentialSnapshot;
  completionPromise?: Promise<OAuthCallbackResult | null>;
  polling?: {
    expiresAt: number;
    flowId: string;
    nextPollAt: number;
    pollIntervalMs: number;
    pollToken: string;
    pollUrl: string;
  };
}

interface OAuthFlowEnvelope {
  code?: unknown;
  msg?: unknown;
  data?: unknown;
}

interface OAuthServiceDependencies {
  adapters?: OAuthProviderAdapter[];
  apiClient?: ApiClient;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  onProviderLogout?: (provider: OAuthProviderId, accountIdentity?: string | null) => Promise<void>;
}

function readTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toUserInfo(profile: OAuthUserProfile): UserInfo {
  return {
    id: profile.id,
    username: profile.username,
    displayName: profile.displayName,
    ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
  };
}

function isSameOAuthProfile(left: OAuthUserProfile, right: OAuthUserProfile): boolean {
  return (
    left.id === right.id &&
    left.username === right.username &&
    left.displayName === right.displayName &&
    left.avatarUrl === right.avatarUrl &&
    JSON.stringify(left.rawProfile ?? null) === JSON.stringify(right.rawProfile ?? null)
  );
}

function resolveInactiveOAuthProvider(provider: OAuthProviderId): OAuthProviderId | null {
  if (provider === ZAI_PROVIDER_ID) {
    return BIGMODEL_PROVIDER_ID;
  }
  if (provider === BIGMODEL_PROVIDER_ID) {
    return ZAI_PROVIDER_ID;
  }
  return null;
}

/**
 * OAuth 认证服务实现
 *
 * 在 host process 中运行，管理 OAuth 流程的完整生命周期。
 */
export class OAuthService implements IOAuthService {
  private readonly credentialService: OAuthSessionCredentialService;
  private readonly repo: OAuthCredentialRepo;
  private readonly adapters = new Map<OAuthProviderId, OAuthProviderAdapter>();
  private readonly now: () => number;
  private readonly onProviderLogout?: (
    provider: OAuthProviderId,
    accountIdentity?: string | null,
  ) => Promise<void>;
  private readonly apiClient?: ApiClient;
  private readonly env: NodeJS.ProcessEnv;
  private pendingState: PendingState | null = null;
  private oauthFlowStartGeneration = 0;
  private oauthFlowStartProvider: OAuthProviderId | null = null;
  private oauthSessionGeneration = 0;
  private sessionMutationQueue: Promise<unknown> = Promise.resolve();
  private recentlyCompletedPollingState: {
    generation: number;
    expiresAt: number;
    provider: OAuthProviderId;
    state: string;
  } | null = null;

  constructor(
    credentialService: OAuthSessionCredentialService,
    dependencies: OAuthServiceDependencies = {},
  ) {
    this.credentialService = credentialService;
    this.now = dependencies.now ?? Date.now;
    this.onProviderLogout = dependencies.onProviderLogout;
    this.apiClient = dependencies.apiClient;
    this.env = dependencies.env ?? process.env;

    const adapters =
      dependencies.adapters ??
      createOAuthProviderAdapters(createOAuthRuntimeConfig(dependencies.env), {
        apiClient: dependencies.apiClient,
      });

    for (const adapter of adapters) {
      this.adapters.set(adapter.providerId, adapter);
    }
    this.repo = new OAuthCredentialRepo(credentialService, {
      providerIds: adapters.map((adapter) => adapter.providerId),
      onCorruptOAuthSessionCleared: async (providers) => {
        // 本地 OAuth 凭据解密失败后等价于强制 logout。
        // repo 只能清 OAuth 命名空间，派生的 Start/Coding Plan provider key 必须回到 service 层清理。
        await this.notifyProvidersLogout(providers);
      },
    });
  }

  async getProviders(): Promise<OAuthProviderMeta[]> {
    return [...this.adapters.values()]
      .map((adapter) => adapter.meta)
      .filter((meta) => meta.enabled)
      .sort((a, b) => a.order - b.order);
  }

  async getActiveProvider(): Promise<OAuthProviderId | null> {
    return this.repo.getActiveProvider();
  }

  async restoreCachedSession(): Promise<UserInfo | null> {
    const result = await this.restoreCachedSessionState();
    return result.status === "authenticated" ? result.userInfo : null;
  }

  async restoreCachedSessionState(): Promise<OAuthCachedSessionRestoreResult> {
    const restoreGeneration = this.oauthSessionGeneration;
    const activeProvider = await this.repo.getActiveProvider();
    if (!activeProvider) {
      log("restoreCachedSession skipped: no active provider");
      return { status: "signed-out" };
    }

    const adapter = this.adapters.get(activeProvider);
    if (!adapter || !adapter.meta.enabled) {
      log(
        "restoreCachedSession aborted: provider unavailable, clearing active provider:",
        activeProvider,
      );
      await this.repo.clearActiveProvider();
      return { status: "signed-out" };
    }

    // 会话快照一次读全：active provider、profile 与共享 JWT 来自同一份明文，
    // 三次分开读之间的窗口里发生的新登录不会拼出「旧 profile + 新 JWT」的组合。
    const snapshot = await this.repo.captureSessionSnapshot([activeProvider]);
    const profile = this.repo.readUserProfile(snapshot, activeProvider);
    if (!profile) {
      // zai / bigmodel 这类 OAuth token 生命周期很短，启动时如果强依赖远端 userinfo 校验，
      // 用户明明刚登录过，也会因为 access_token 过期被误判成未登录。
      // 这里改为优先读取登录成功时持久化的 user_info，只要用户没有手动退出，就按缓存恢复展示态。
      log("restoreCachedSession skipped: missing cached user profile:", activeProvider);
      return { status: "signed-out" };
    }

    // 启动缓存恢复只需要检查共享 zcode JWT；快照里虽有 provider access token，
    // 但这里不消费它，BigModel profile 迁移仍留在后台，不阻塞首屏恢复链路。
    const zcodeJwtToken = (this.repo.readZcodeJwtToken(snapshot) ?? "").trim();
    if (zcodeJwtToken && resolveJwtExpiration(zcodeJwtToken, this.now()).kind === "expired") {
      serviceLog.info("cached session invalidated because zcode JWT expired", {
        provider: activeProvider,
      });
      const invalidated = await this.invalidateExpiredCachedSession(
        restoreGeneration,
        activeProvider,
        profile,
        zcodeJwtToken,
      );
      if (!invalidated) {
        return this.restoreCachedSessionState();
      }
      return { status: "reauthentication-required", reason: "jwt-expired" };
    }

    if (activeProvider === BIGMODEL_PROVIDER_ID) {
      const migrationGeneration = this.oauthSessionGeneration;
      void refreshLegacyBigModelCachedProfile({
        adapter,
        cachedProfile: profile,
        loadTokenSet: () =>
          this.loadBigModelCachedProfileMigrationTokenSet(migrationGeneration, profile),
        now: this.now,
        runWithAdapterError: (run) => this.runWithAdapterError(adapter, run),
        saveProfile: (nextProfile) =>
          this.saveBigModelCachedProfileMigration(migrationGeneration, profile, nextProfile),
      })
        .then((migratedProfile) => {
          if (migratedProfile !== profile) {
            log(
              "restoreCachedSession migrated cached profile:",
              activeProvider,
              migratedProfile.id,
            );
          }
        })
        .catch((error: unknown) => {
          log(
            "restoreCachedSession background profile migration failed:",
            activeProvider,
            error instanceof Error ? error.message : String(error),
          );
        });
    }

    if (activeProvider === ZAI_PROVIDER_ID) {
      if (!zcodeJwtToken) {
        // sidebar 登录入口之前只看缓存 user_info，会把“缺少 zcodejwttoken”的状态误判成已登录。
        // 这里补充 zcodejwttoken 门槛，确保没有后端 JWT 时统一按未登录处理。
        log("restoreCachedSession skipped: missing zcodejwttoken:", activeProvider);
        return { status: "signed-out" };
      }
    }

    log("restoreCachedSession restored:", activeProvider, profile.id);
    return { status: "authenticated", userInfo: toUserInfo(profile) };
  }

  private async invalidateExpiredCachedSession(
    expectedGeneration: number,
    expectedProvider: OAuthProviderId,
    expectedProfile: OAuthUserProfile,
    expectedJwt: string,
  ): Promise<boolean> {
    const invalidated = await this.runSessionMutation(async () => {
      // 复核与清理必须基于同一份快照：先比快照再整组提交，提交时由 CAS 兜住两次读之间的写入，
      // 旧恢复任务只能清理仍与其快照完全一致的会话，不能误删刚写入的新认证状态。
      const snapshot = await this.repo.captureSessionSnapshot([expectedProvider]);
      const currentProvider = this.repo.readActiveProvider(snapshot);
      const currentProfile = this.repo.readUserProfile(snapshot, expectedProvider);
      const currentJwt = (this.repo.readZcodeJwtToken(snapshot) ?? "").trim();
      if (
        this.oauthSessionGeneration !== expectedGeneration ||
        currentProvider !== expectedProvider ||
        !currentProfile ||
        !isSameOAuthProfile(currentProfile, expectedProfile) ||
        currentJwt !== expectedJwt
      ) {
        serviceLog.info("skipped stale expired JWT session invalidation", {
          provider: expectedProvider,
        });
        return false;
      }
      const cleared = await this.repo.clearActiveSession(snapshot);
      if (!cleared) {
        serviceLog.info("skipped expired JWT invalidation: session changed during commit", {
          provider: expectedProvider,
        });
        return false;
      }
      this.oauthSessionGeneration += 1;
      return true;
    });
    if (!invalidated) {
      return false;
    }
    await this.cancelPending(expectedProvider);
    try {
      await this.notifyProviderLogout(expectedProvider, expectedProfile.id);
    } catch (error) {
      // JWT 已过期时主认证事实必须先失效；派生 provider 清理失败不能把 UI 留在伪登录态。
      serviceLog.warn("expired JWT derived provider cleanup failed", {
        provider: expectedProvider,
        error,
      });
    }
    return true;
  }

  private async loadBigModelCachedProfileMigrationTokenSet(
    expectedGeneration: number,
    expectedCachedProfile: OAuthUserProfile,
  ): Promise<OAuthTokenSet | null> {
    return this.runSessionMutation(async () => {
      if (this.oauthSessionGeneration !== expectedGeneration) {
        log("restoreCachedSession skipped stale BigModel token migration");
        return null;
      }

      const snapshot = await this.repo.captureSessionSnapshot([BIGMODEL_PROVIDER_ID]);
      const activeProvider = this.repo.readActiveProvider(snapshot);
      const currentProfile = this.repo.readUserProfile(snapshot, BIGMODEL_PROVIDER_ID);
      if (
        activeProvider !== BIGMODEL_PROVIDER_ID ||
        !currentProfile ||
        !isSameOAuthProfile(currentProfile, expectedCachedProfile)
      ) {
        // 迁移请求目标固定是 BigModel，token 也必须固定读取 BigModel 命名空间；
        // 发请求前先复核持久化快照，避免切换到 ZAI 后把其他 provider token 发给 BigModel。
        log("restoreCachedSession skipped stale BigModel token migration:", activeProvider);
        return null;
      }

      return this.repo.readTokenSet(snapshot, BIGMODEL_PROVIDER_ID);
    });
  }

  private async saveBigModelCachedProfileMigration(
    expectedGeneration: number,
    expectedCachedProfile: OAuthUserProfile,
    nextProfile: OAuthUserProfile,
  ): Promise<void> {
    await this.runSessionMutation(async () => {
      if (this.oauthSessionGeneration !== expectedGeneration) {
        log("restoreCachedSession skipped stale BigModel profile migration");
        return;
      }

      const snapshot = await this.repo.captureSessionSnapshot([BIGMODEL_PROVIDER_ID]);
      const activeProvider = this.repo.readActiveProvider(snapshot);
      if (activeProvider !== BIGMODEL_PROVIDER_ID) {
        log("restoreCachedSession skipped stale BigModel profile migration:", activeProvider);
        return;
      }

      const currentProfile = this.repo.readUserProfile(snapshot, BIGMODEL_PROVIDER_ID);
      if (!currentProfile || !isSameOAuthProfile(currentProfile, expectedCachedProfile)) {
        // BigModel 旧缓存迁移在后台完成，期间用户可能 logout、切到 ZAI，
        // 或重新登录 BigModel。只有当前缓存仍是启动时那份旧缓存时，旧迁移结果才允许落盘。
        log("restoreCachedSession skipped outdated BigModel profile migration");
        return;
      }

      const committed = await this.repo.commitSessionChange(snapshot, {
        providers: [{ provider: BIGMODEL_PROVIDER_ID, profile: nextProfile }],
      });
      if (!committed) {
        // 复读与提交之间的写入由 CAS 拦下：旧迁移结果不能盖掉新登录写下的 profile。
        log(
          "restoreCachedSession skipped BigModel profile migration: session changed during commit",
        );
      }
    });
  }

  private runSessionMutation<T>(run: () => Promise<T>): Promise<T> {
    // 后台 profile 迁移、logout、provider 切换都会改 OAuth 凭据；
    // 必须串行化，避免旧迁移在退出或切换清理之后重新写回 user_info。
    const next = this.sessionMutationQueue.catch(() => undefined).then(run);
    this.sessionMutationQueue = next.catch(() => undefined);
    return next;
  }

  /**
   * 一次登录落盘 = 一次整组提交（SPEC §7.3）。
   *
   * 快照取自发起登录时（待授权期间可能已有另一进程完成登录），token / user_info /
   * active provider 与旧 provider 的清理在同一 updateMany 里写入并轮换版本键：
   * 提交前取消（assertCurrent 在锁内执行）不会留下半成品会话；快照过期则整组丢弃，
   * 绝不用旧响应覆盖新登录。
   *
   * 不再做事后回滚：旧代码逐键写入后在取消时无条件写回旧值，反而会把期间完成的新登录覆盖掉；
   * 原子提交后不存在半成品，唯一剩下的窗口是提交后瞬间取消 —— 那时登录已完成，按当前事实处理。
   */
  private async persistOAuthSession(
    provider: OAuthProviderId,
    tokenSet: OAuthTokenSet,
    profile: OAuthUserProfile,
    snapshot: OAuthCredentialSnapshot,
    isStillCurrent?: () => boolean,
  ): Promise<void> {
    const inactiveProvider = resolveInactiveOAuthProvider(provider);
    const committed = await this.repo.commitSessionChange(
      snapshot,
      {
        activeProvider: provider,
        providers: [
          // ZAI 与 BigModel 是互斥身份域：先清旧 provider 再写当前 token，
          // 反序会让旧 provider 的清理删掉共享的 zcodejwttoken。
          ...(inactiveProvider
            ? [{ provider: inactiveProvider, tokenSet: null, profile: null }]
            : []),
          {
            provider,
            tokenSet,
            profile: withProviderProfileSchema(provider, profile),
          },
        ],
      },
      isStillCurrent
        ? {
            assertCurrent: () => {
              if (!isStillCurrent()) throw new Error("OAuth flow 已取消");
            },
          }
        : {},
    );
    if (!committed) {
      serviceLog.warn("discarded OAuth login result because the stored session changed", {
        provider,
      });
      throw new Error("OAuth 登录结果已被更新的会话覆盖，请重新登录");
    }
    this.oauthSessionGeneration += 1;
  }

  private async runPendingSessionCompletion(
    pending: PendingState,
    complete: () => Promise<{ tokenSet: OAuthTokenSet; profile: OAuthUserProfile }>,
    preserveAttribution?: () => Promise<void>,
  ): Promise<OAuthCallbackResult | null> {
    const completion = this.runSessionMutation(async () => {
      // polling 与 deep link 可能同时完成，也可能在等待期间开始新登录。
      // 只有仍指向同一 pending 对象的路径能落盘，防止迟到结果覆盖更新的登录选择。
      if (this.pendingState !== pending) {
        if (
          !this.pendingState &&
          this.recentlyCompletedPollingState?.state === pending.state &&
          this.recentlyCompletedPollingState.generation === this.oauthFlowStartGeneration
        ) {
          // 回调入队时已通过有效性检查，不能因队列等待超过去重窗口而丢失归因。
          await preserveAttribution?.();
          return { kind: "duplicate" as const, provider: pending.provider };
        }
        return null;
      }
      await preserveAttribution?.();
      if (this.pendingState !== pending) return null;
      const { tokenSet, profile } = await complete();
      // exchangeToken 期间用户可能取消或切换到新 flow；旧请求返回后必须再次校验，
      // 否则已取消的登录仍会把旧凭据写回本地。
      if (this.pendingState !== pending) {
        return null;
      }
      await this.persistOAuthSession(
        pending.provider,
        tokenSet,
        profile,
        pending.snapshot,
        () => this.pendingState === pending,
      );
      if (this.pendingState === pending) {
        this.clearPendingState();
      }
      this.recentlyCompletedPollingState = {
        generation: this.oauthFlowStartGeneration,
        expiresAt: this.now() + COMPLETED_POLLING_STATE_GRACE_MS,
        provider: pending.provider,
        state: pending.state,
      };
      return {
        kind: "session" as const,
        provider: pending.provider,
        userInfo: toUserInfo(profile),
      };
    });
    // 共享首个兑换 Promise 会让失败传播给另一条已拿到凭据的路径。
    // 复用会话串行队列，每个候选独立执行；失败只在已排队候选均失败后向 UI 报告。
    pending.completionPromise = completion;
    try {
      return await completion;
    } catch (error) {
      const fallback = pending.completionPromise;
      if (fallback && fallback !== completion) {
        try {
          await fallback;
        } catch {
          // 两条路径均失败时保留各自的错误，不能让备用路径覆盖首条失败原因。
          throw error;
        }
        if (
          !this.pendingState &&
          this.recentlyCompletedPollingState?.state === pending.state &&
          this.recentlyCompletedPollingState.generation === this.oauthFlowStartGeneration
        ) {
          return { kind: "duplicate", provider: pending.provider };
        }
        if (this.pendingState !== pending) return null;
      }
      throw error;
    } finally {
      if (pending.completionPromise === completion) pending.completionPromise = undefined;
    }
  }

  async restoreSession(): Promise<UserInfo | null> {
    const activeProvider = await this.repo.getActiveProvider();
    if (!activeProvider) {
      log("restoreSession skipped: no active provider");
      return null;
    }

    log("restoreSession started:", activeProvider);

    const adapter = this.adapters.get(activeProvider);
    if (!adapter || !adapter.meta.enabled) {
      log(
        "restoreSession aborted: provider unavailable, clearing active provider:",
        activeProvider,
      );
      await this.repo.clearActiveProvider();
      return null;
    }

    // 恢复链路的读也走会话快照：legacy 回填写回命名空间键时，以读到的同一份明文做 CAS。
    const snapshot = await this.repo.captureSessionSnapshot([activeProvider]);
    let tokenSet = this.repo.readTokenSet(snapshot, activeProvider);
    if (!tokenSet && adapter.loadLegacyTokenSet) {
      log("restoreSession fallback: trying provider legacy token set:", activeProvider);
      tokenSet = await adapter.loadLegacyTokenSet((key) => this.credentialService.load(key));

      // 多 provider 改造后，旧版 BigModel 仍可能只保留 legacy token key。
      // 这里在 provider 兼容读取成功后回填命名空间 key，避免每次启动都重复走 legacy 分支。
      if (tokenSet) {
        log("restoreSession fallback hit: migrating legacy token set:", activeProvider);
        // 回填写回命名空间键；失败（别的会话刚改了同一组键）不算错误，下次启动再试。
        await this.repo.commitSessionChange(snapshot, {
          providers: [{ provider: activeProvider, tokenSet }],
        });
      }
    }

    if (!tokenSet || !adapter.fetchUserInfo) {
      log(
        "restoreSession failed: missing token or user-info capability, logging out:",
        activeProvider,
      );
      await this.logout();
      return null;
    }

    // Modified by ZCode: 自上游 zai-org/ZCode v3.18.2 (fec97590, Apache-2.0) 并入主身份 CAS 判定 ——
    // 主身份基线在发请求前读一次：远端返回后要与"发起刷新时看到的可信主体"比较。
    const cachedProfile = this.repo.readUserProfile(snapshot, activeProvider);
    let fetchedProfile: OAuthUserProfile;
    try {
      log("restoreSession validating token with provider userinfo endpoint:", activeProvider);
      fetchedProfile = await this.runWithAdapterError(adapter, () =>
        adapter.fetchUserInfo!(tokenSet, {
          providerId: activeProvider,
          state: "",
          redirectUri: adapter.redirectUri,
          now: this.now,
        }),
      );
    } catch (error) {
      const normalized = adapter.normalizeError(error);

      // 启动恢复只看本地凭据会把“过期 token”误判成已登录。
      // 当远端明确返回未授权（401/403）时，立即按退出流程清理本地登录态。
      if (this.isUnauthorizedError(normalized)) {
        log("restoreSession unauthorized, logging out:", activeProvider, normalized.message);
        await this.logout();
        return null;
      }

      log("restoreSession validation error:", activeProvider, normalized.message);

      throw normalized;
    }

    // 远端 userinfo 只拥有展示字段。落盘前在会话串行队列内重读快照：期间若发生新登录、退出
    // 或 provider 切换，旧刷新结果不能覆盖新会话，更不能把主身份换成业务账号。
    const persistedProfile = await this.runSessionMutation(async () => {
      // 读-改-写用同一份快照：合并基线与 CAS 期望值是同一份明文，两次读之间的写入只会让提交失败。
      const current = await this.repo.captureSessionSnapshot([activeProvider]);
      if (this.repo.readActiveProvider(current) !== activeProvider) {
        log("restoreSession skipped: session changed while validating profile");
        return null;
      }
      const currentProfile = this.repo.readUserProfile(current, activeProvider);
      const plan = planOAuthProfileRefresh({
        provider: activeProvider,
        cachedProfile,
        currentProfile,
        fetchedProfile,
      });
      if (plan.action === "require-relogin") {
        log("restoreSession requires relogin:", activeProvider, plan.reason);
        return null;
      }
      if (plan.action === "reject") throw plan.error;
      // 远端结果与缓存完全一致时（常见于 BigModel 拿不到业务 userinfo 的哨兵回退）不落盘：
      // 写入会给旧缓存盖上 schema 版本，反而让之后一次真正的展示名迁移被跳过。
      if (currentProfile && isSameOAuthProfile(plan.profile, currentProfile)) {
        log("restoreSession profile unchanged, skip write:", activeProvider);
        return plan.profile;
      }
      const committed = await this.repo.commitSessionChange(current, {
        providers: [
          {
            provider: activeProvider,
            profile: withProviderProfileSchema(activeProvider, plan.profile),
          },
        ],
      });
      if (!committed) {
        // 提交期间另一会话改了同一组键：按当前存储重新读取，绝不覆盖别人的结果。
        log("restoreSession profile refresh discarded: session changed during commit");
        return await this.repo.loadUserProfile(activeProvider);
      }
      return plan.profile;
    });
    if (!persistedProfile) return null;
    log("restoreSession validated:", activeProvider, persistedProfile.id);
    return toUserInfo(persistedProfile);
  }

  async startOAuth(provider: OAuthProviderId): Promise<OAuthStartResponse> {
    return this.startOAuthInternal(provider);
  }

  async startOAuthWithPolling(provider: OAuthProviderId): Promise<OAuthStartResponse> {
    if (provider !== ZAI_PROVIDER_ID && provider !== BIGMODEL_PROVIDER_ID) {
      return this.startOAuthInternal(provider);
    }

    const adapter = this.getEnabledAdapter(provider);
    if (!this.apiClient) {
      throw new Error("ApiClient 注入缺失：OAuth polling 必须通过 Providers 传入 apiClient");
    }
    // 两个 init 并发时，先发但后返回的旧响应会覆盖较新的 pending flow。
    // generation 让最后一次用户操作拥有 flow，旧响应只结束自己的调用方。
    const startGeneration = ++this.oauthFlowStartGeneration;
    this.oauthFlowStartProvider = provider;
    this.clearPendingState();
    // 待授权期间另一进程可能已完成登录：快照在发起时取，完成提交时用它做 CAS 期望值。
    const snapshot = await this.repo.captureSessionSnapshot([provider]);
    const pollToken = randomBytes(32).toString("hex");
    const initUrl = buildZCodeApiUrlFromEnv(this.env, "/api/v1/oauth/cli/init");
    const envelope = await readApiJson<OAuthFlowEnvelope>(this.apiClient, initUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pollToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ provider }),
    });
    if (this.oauthFlowStartGeneration !== startGeneration) {
      throw new Error("OAuth flow 已被新的登录请求替换");
    }
    this.oauthFlowStartProvider = null;
    const data = envelope.data;
    if (
      envelope.code !== 0 ||
      !isUnknownRecord(data) ||
      !readTrimmedString(data.flow_id) ||
      !readTrimmedString(data.authorize_url) ||
      !Number.isFinite(data.expires_at) ||
      !Number.isFinite(data.poll_interval_sec)
    ) {
      throw new Error(readTrimmedString(envelope.msg) || "OAuth flow 初始化响应无效");
    }

    const flowId = readTrimmedString(data.flow_id)!;
    const authorizeUrlString = readTrimmedString(data.authorize_url)!;
    const expiresAt = (data.expires_at as number) * 1_000;
    const pollIntervalMs = (data.poll_interval_sec as number) * 1_000;
    let authorizeUrl: URL;
    try {
      authorizeUrl = new URL(authorizeUrlString);
    } catch {
      throw new Error("OAuth flow 初始化响应无效");
    }
    if (provider === BIGMODEL_PROVIDER_ID) {
      // BigModel CLI callback 的失败页会截断原有 Desktop deep link 回调体验。
      // flow 仍由 Host 轮询，但浏览器回调恢复到官网中转页，再透传到 zcode://oauth/callback。
      authorizeUrl.searchParams.set("redirect", buildDesktopOAuthRedirectUriFromEnv(this.env));
    } else if (provider === ZAI_PROVIDER_ID) {
      // Z.AI 后端 init 仍可能返回 provider-specific callback，导致回跳行为与 BigModel 不一致。
      // Desktop 统一改写为官网中转页，再由官网透传到 zcode://oauth/callback。
      authorizeUrl.searchParams.set("redirect_uri", buildDesktopOAuthRedirectUriFromEnv(this.env));
    }
    const state = authorizeUrl.searchParams.get("state")?.trim();
    const remainingLifetimeMs = expiresAt - this.now();
    if (
      authorizeUrl.protocol !== "https:" ||
      !state ||
      !Number.isFinite(expiresAt) ||
      !Number.isFinite(pollIntervalMs) ||
      remainingLifetimeMs <= 0 ||
      pollIntervalMs < 1_000 ||
      pollIntervalMs >= remainingLifetimeMs
    ) {
      throw new Error("OAuth flow 初始化响应无效");
    }

    const timeoutMs = Math.min(OAUTH_TIMEOUT_MS, remainingLifetimeMs);
    const timeout = setTimeout(() => {
      const pending = this.pendingState;
      // polling flow 超时必须立即收口，不能等待下一次 UI 轮询；同时校验 flowId，避免旧定时器清掉新 flow。
      if (pending?.state === state && pending.polling?.flowId === flowId) {
        this.clearPendingState();
      }
    }, timeoutMs);
    this.pendingState = {
      state,
      provider: adapter.providerId,
      timeout,
      phase: "awaiting-attribution-or-code",
      snapshot,
      polling: {
        expiresAt,
        flowId,
        nextPollAt: this.now(),
        pollIntervalMs,
        pollToken,
        pollUrl: buildZCodeApiUrlFromEnv(
          this.env,
          `/api/v1/oauth/cli/poll/${encodeURIComponent(flowId)}`,
        ),
      },
    };

    serviceLog.info("OAuth polling flow started", {
      expiresInMs: timeoutMs,
      pollIntervalMs,
      provider,
    });
    return { provider, authorizeUrl: authorizeUrl.toString(), state };
  }

  async pollPendingOAuth(): Promise<OAuthCallbackResult | null> {
    const apiClient = this.apiClient;
    if (!apiClient) {
      return null;
    }
    const pending = this.pendingState;
    const polling = pending?.polling;
    if (!pending || !polling) {
      return null;
    }
    if (this.now() >= polling.expiresAt) {
      this.clearPendingState();
      throw new Error("OAuth flow 已过期");
    }
    if (this.now() < polling.nextPollAt) {
      return null;
    }
    polling.nextPollAt = this.now() + polling.pollIntervalMs;

    let envelope: OAuthFlowEnvelope;
    try {
      envelope = await readApiJson<OAuthFlowEnvelope>(apiClient, polling.pollUrl, {
        headers: { Authorization: `Bearer ${polling.pollToken}` },
      });
    } catch (error) {
      if (this.pendingState !== pending) return null;
      if (
        error instanceof ApiError &&
        error.status &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408 &&
        error.status !== 429
      ) {
        try {
          return await this.runPendingSessionCompletion(pending, async () => {
            throw error;
          });
        } catch (terminalError) {
          if (this.pendingState === pending) this.clearPendingState();
          throw terminalError;
        }
      }
      // 轮询是 deep link 丢失时的可靠路径，单次断网或 5xx 不能立即取消 flow。
      // 保留服务端下发的查询间隔，下一轮继续尝试；高频状态只记 debug，避免生产日志膨胀。
      serviceLog.debug("OAuth polling request will retry", {
        error: error instanceof Error ? error.message : String(error),
        provider: pending.provider,
      });
      return null;
    }
    if (this.pendingState !== pending) {
      return null;
    }
    if (
      envelope.code === 0 &&
      isUnknownRecord(envelope.data) &&
      readTrimmedString(envelope.data.status) === "pending"
    ) {
      return null;
    }
    try {
      const result = await this.runPendingSessionCompletion(pending, async () => {
        const pollData = envelope.data;
        if (envelope.code !== 0 || !isUnknownRecord(pollData)) {
          throw new Error(readTrimmedString(envelope.msg) || "OAuth flow 查询响应无效");
        }
        const status = readTrimmedString(pollData.status);
        if (status === "failed") {
          throw new Error("OAuth flow 授权失败");
        }
        if (status !== "ready") {
          throw new Error("OAuth flow 查询响应无效");
        }

        const ready = pollData;
        const user = isUnknownRecord(ready.user) ? ready.user : null;
        const zai = isUnknownRecord(ready.zai) ? ready.zai : null;
        const bigmodel = isUnknownRecord(ready.bigmodel) ? ready.bigmodel : null;
        const providerAccessToken =
          pending.provider === ZAI_PROVIDER_ID
            ? readTrimmedString(zai?.access_token)
            : readTrimmedString(bigmodel?.access_token) || readTrimmedString(bigmodel?.accessToken);
        const zcodeJwtToken = readTrimmedString(ready.token);
        const userId = readTrimmedString(user?.user_id);
        if (!zcodeJwtToken || !providerAccessToken || !userId) {
          throw new Error("OAuth flow 查询响应无效");
        }
        const username = readTrimmedString(user?.name) || readTrimmedString(user?.email) || userId;
        const avatarUrl = readTrimmedString(user?.avatar);
        const profile: OAuthUserProfile = {
          id: userId,
          username,
          displayName: username,
          ...(avatarUrl ? { avatarUrl } : {}),
          rawProfile: user,
        };
        const adapter = this.getAdapter(pending.provider);
        const refreshToken =
          pending.provider === BIGMODEL_PROVIDER_ID
            ? readTrimmedString(bigmodel?.refresh_token) ||
              readTrimmedString(bigmodel?.refreshToken)
            : undefined;
        const tokenSet = adapter.normalizePolledTokenSet
          ? await adapter.normalizePolledTokenSet({
              accessToken: providerAccessToken,
              zcodeJwtToken,
              ...(refreshToken ? { refreshToken } : {}),
            })
          : {
              accessToken: providerAccessToken,
              zcodeJwtToken,
              ...(refreshToken ? { refreshToken } : {}),
            };
        return { tokenSet, profile };
      });
      if (result?.kind === "session") {
        serviceLog.info("OAuth polling flow completed", { provider: pending.provider });
      }
      return result;
    } catch (error) {
      if (this.pendingState === pending) this.clearPendingState();
      throw error;
    }
  }

  private async startOAuthInternal(provider: OAuthProviderId): Promise<OAuthStartResponse> {
    const adapter = this.getEnabledAdapter(provider);

    // 同窗口快速连续点击不同 provider 时，旧 state 如果不先取消，
    // 两条并发流程会共享同一回调通道，导致后回调抢占前回调并触发 state 错配。
    const snapshot = await this.runSessionMutation(async () => {
      this.oauthFlowStartGeneration += 1;
      this.oauthFlowStartProvider = null;
      this.clearPendingState();
      // 发起时读会话快照：待授权期间另一进程可能完成登录，完成提交以它为 CAS 期望值。
      return await this.repo.captureSessionSnapshot([adapter.providerId]);
    });

    const state = randomBytes(32).toString("hex");
    const timeout = setTimeout(() => {
      if (this.pendingState?.state === state) {
        this.pendingState = null;
      }
    }, OAUTH_TIMEOUT_MS);

    this.pendingState = {
      state,
      provider: adapter.providerId,
      timeout,
      phase: "awaiting-attribution-or-code",
      snapshot,
    };

    const authorizeUrl = adapter.buildAuthorizeUrl({
      providerId: adapter.providerId,
      state,
      redirectUri: adapter.redirectUri,
      now: this.now,
    });

    return {
      provider: adapter.providerId,
      authorizeUrl,
      state,
    };
  }

  async handleCallback(url: string): Promise<OAuthCallbackResult | null> {
    const pending = this.pendingState;
    if (!pending) {
      const callbackState = new URL(url).searchParams.get("state")?.trim();
      const completed = this.recentlyCompletedPollingState;
      if (
        callbackState &&
        completed?.state === callbackState &&
        completed.generation === this.oauthFlowStartGeneration &&
        this.now() < completed.expiresAt
      ) {
        const attribution = parseOAuthLoginAttribution(new URL(url).searchParams);
        await this.runSessionMutation(async () => {
          // 修复原因：轮询先成功时仍需保存浏览器归因，不能把登录去重当作丢弃整条回调。
          if (
            !this.pendingState &&
            this.recentlyCompletedPollingState === completed &&
            completed.generation === this.oauthFlowStartGeneration &&
            attribution
          ) {
            await this.repo.saveLoginAttribution(attribution);
          }
        });
        return { kind: "duplicate", provider: completed.provider };
      }
      throw new Error("OAuth state 不匹配或已过期");
    }

    const parsedUrl = new URL(url);
    const state = parsedUrl.searchParams.get("state");
    if (!state || state !== pending.state) {
      throw new Error("OAuth state 不匹配或已过期");
    }
    if (pending.polling && this.now() >= pending.polling.expiresAt) {
      this.clearPendingState();
      throw new Error("OAuth flow 已过期");
    }

    const attribution = parseOAuthLoginAttribution(parsedUrl.searchParams);
    if (attribution && !hasOAuthAuthorizationCode(parsedUrl.searchParams)) {
      if (pending.phase === "awaiting-code-after-attribution") {
        throw new Error("OAuth 归因回调已处理");
      }

      // 修复原因：纯归因回调是最终授权码前的中转步骤，不能清掉仍需继续登录的 state；
      // 但若不显式推进 phase，同一 state 可重复写入归因并隐式复用 pending 生命周期。
      pending.phase = "awaiting-code-after-attribution";
      try {
        await this.repo.saveLoginAttribution(attribution);
      } catch (error) {
        if (this.pendingState === pending) {
          pending.phase = "awaiting-attribution-or-code";
        }
        throw error;
      }
      return {
        kind: "attribution",
        provider: pending.provider,
        attribution,
      };
    }

    const adapter = this.getAdapter(pending.provider);
    const fallbackProfile: OAuthUserProfile = {
      id: "unknown",
      username: "user",
      displayName: "User",
    };

    return this.runPendingSessionCompletion(
      pending,
      async () => {
        const callback = adapter.parseCallbackParams(url);
        const context = {
          providerId: adapter.providerId,
          state: callback.state,
          redirectUri: adapter.redirectUri,
          now: this.now,
        };
        const tokenSet = await this.runWithAdapterError(adapter, () =>
          adapter.exchangeToken(callback, context),
        );
        let profile = fallbackProfile;
        if (adapter.fetchUserInfo) {
          try {
            profile = await this.runWithAdapterError(adapter, () =>
              adapter.fetchUserInfo!(tokenSet, context),
            );
          } catch {
            // 获取用户信息失败不阻塞登录
          }
        }
        return { tokenSet, profile };
      },
      attribution ? () => this.repo.saveLoginAttribution(attribution) : undefined,
    );
  }

  async refreshToken(provider?: OAuthProviderId): Promise<void> {
    const targetProvider = await this.resolveProvider(provider);
    if (!targetProvider) {
      throw new Error("当前没有可用的登录 provider");
    }

    const adapter = this.getEnabledAdapter(targetProvider);
    if (!adapter.refreshToken) {
      throw new Error(
        `${adapter.meta.displayName} OAuth 暂未提供 refresh token 交换接口，请重新登录`,
      );
    }

    const activeProvider = await this.repo.getActiveProvider();
    if (targetProvider !== activeProvider) {
      throw new Error("只能刷新当前 App 登录 provider，请重新登录");
    }

    // 刷新同样是「读快照 → 系统交互 → 整组提交」：期望值必须取发请求之前的快照，
    // 否则等待期间另一进程完成的刷新/登录会被这次旧响应覆盖回去。
    const snapshot = await this.repo.captureSessionSnapshot([targetProvider]);
    const tokenSet = this.repo.readTokenSet(snapshot, targetProvider);
    if (!tokenSet?.refreshToken) {
      throw new Error("当前账号缺少 refresh_token，请重新登录");
    }

    const refreshed = await this.runWithAdapterError(adapter, () =>
      adapter.refreshToken!(tokenSet, {
        providerId: targetProvider,
        state: "",
        redirectUri: adapter.redirectUri,
        now: this.now,
      }),
    );

    await this.runSessionMutation(async () => {
      // 刷新写回若绕过会话队列，会插入 401 的核对/清理窗口，或在退出后复活凭据。
      // 退出、切号或新登录都会轮换版本键，因此这里的提交会被整组拒绝而不是写回旧 token。
      const committed = await this.repo.commitSessionChange(snapshot, {
        providers: [{ provider: targetProvider, tokenSet: refreshed }],
      });
      if (!committed) {
        serviceLog.info("discarded OAuth refresh result because the stored session changed", {
          provider: targetProvider,
        });
      }
    });
  }

  /** Host 本地 401 提交入口，不扩展 IOAuthService 的跨端契约。 */
  logoutIfCurrentCredentialRequest(input: string | URL, headers: Headers): Promise<boolean> {
    return this.logoutActiveSession(() =>
      isCurrentOAuthCredentialRequest({
        input,
        headers,
        credentialService: this.credentialService,
        env: this.env,
      }),
    );
  }

  private async logoutActiveSession(isCurrent?: () => Promise<boolean>): Promise<boolean> {
    const result = await this.runSessionMutation(async () => {
      // 异步分类的 true 不是清理授权；凭据复核与清理必须和登录写入共用队列。
      if (isCurrent && !(await isCurrent())) return null;
      // 一份快照同时给出 active provider 与账号身份：分开读会在两次读之间把两个账号拼在一起。
      const snapshot = await this.repo.captureSessionSnapshot();
      const activeProvider = this.repo.readActiveProvider(snapshot);
      // 合并边界：清理前保留原账号身份，不能退回仅按平台清理或在退出后再猜身份。
      const accountIdentity = activeProvider
        ? (this.repo.readUserProfile(snapshot, activeProvider)?.id ?? null)
        : null;
      this.oauthSessionGeneration += 1;
      await this.repo.clearActiveSession();
      return { activeProvider, accountIdentity };
    });
    if (!result) return false;
    if (result.activeProvider) {
      await this.cancelPending(result.activeProvider);
      try {
        await this.notifyProviderLogout(result.activeProvider, result.accountIdentity);
      } catch (error) {
        if (!isCurrent) throw error;
        // 凭据已经清理，派生配置失败不能吞掉原有过期提示；手动退出仍保留原错误语义。
        serviceLog.warn("Unauthorized session provider cleanup failed", { error });
      }
    }
    return true;
  }

  async logout(provider?: OAuthProviderId): Promise<void> {
    if (!provider) {
      await this.logoutActiveSession();
      return;
    }

    const loggedOutIdentity = await this.runSessionMutation(async () => {
      const snapshot = await this.repo.captureSessionSnapshot([provider]);
      const activeProvider = this.repo.readActiveProvider(snapshot);
      if (provider !== activeProvider) {
        return undefined;
      }
      const accountIdentity = this.repo.readUserProfile(snapshot, provider)?.id ?? null;
      this.oauthSessionGeneration += 1;
      // ZAI/BigModel provider 的 Unlink 已收敛为 App logout。
      // 只有当前 active provider 才代表登录事实，避免旧 unlink 路径误删非当前 provider token。
      await this.repo.clearActiveSession();
      return accountIdentity;
    });
    if (loggedOutIdentity !== undefined) {
      await this.notifyProviderLogout(provider, loggedOutIdentity);
    }
    await this.cancelPending(provider);
  }

  async logoutAll(): Promise<void> {
    const providers = [...this.adapters.keys()];
    const accountIdentities = await this.runSessionMutation(async () => {
      const snapshot = await this.repo.captureSessionSnapshot(providers);
      const identities = new Map<OAuthProviderId, string | null>();
      for (const provider of providers) {
        identities.set(provider, this.repo.readUserProfile(snapshot, provider)?.id ?? null);
      }
      this.oauthSessionGeneration += 1;
      await this.repo.clearAll(providers);
      return identities;
    });
    await this.cancelPending();
    await this.notifyProvidersLogout(providers, accountIdentities);
  }

  async cancelPending(provider?: OAuthProviderId): Promise<void> {
    if (!this.pendingState) {
      if (provider && this.oauthFlowStartProvider && this.oauthFlowStartProvider !== provider)
        return;
      this.oauthFlowStartGeneration += 1;
      this.oauthFlowStartProvider = null;
      return;
    }
    if (provider && this.pendingState.provider !== provider) return;
    this.oauthFlowStartGeneration += 1;
    this.oauthFlowStartProvider = null;
    this.clearPendingState();
  }

  private clearPendingState(): void {
    if (!this.pendingState) {
      return;
    }

    clearTimeout(this.pendingState.timeout);
    this.pendingState = null;
  }

  private async notifyProviderLogout(
    provider: OAuthProviderId,
    accountIdentity?: string | null,
  ): Promise<void> {
    if (!this.onProviderLogout) {
      return;
    }

    await this.onProviderLogout(provider, accountIdentity);
  }

  private async notifyProvidersLogout(
    providers: readonly OAuthProviderId[],
    accountIdentities: ReadonlyMap<OAuthProviderId, string | null> = new Map(),
  ): Promise<void> {
    await Promise.all(
      providers.map((provider) =>
        this.notifyProviderLogout(provider, accountIdentities.get(provider)),
      ),
    );
  }

  private getAdapter(provider: OAuthProviderId): OAuthProviderAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new Error(`不支持的 OAuth provider: ${provider}`);
    }

    return adapter;
  }

  private getEnabledAdapter(provider: OAuthProviderId): OAuthProviderAdapter {
    const adapter = this.getAdapter(provider);
    if (!adapter.meta.enabled) {
      throw new Error(`OAuth provider 未启用: ${provider}`);
    }

    return adapter;
  }

  private async resolveProvider(provider?: OAuthProviderId): Promise<OAuthProviderId | null> {
    if (provider) {
      return provider;
    }

    return this.repo.getActiveProvider();
  }

  private async runWithAdapterError<T>(
    adapter: OAuthProviderAdapter,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw adapter.normalizeError(error);
    }
  }

  private isUnauthorizedError(error: Error): boolean {
    const lowerMessage = error.message.toLowerCase();
    return (
      /\b401\b|\b403\b/.test(lowerMessage) ||
      lowerMessage.includes("unauthorized") ||
      lowerMessage.includes("forbidden")
    );
  }
}

/**
 * 工厂函数：创建 OAuthService 实例
 */
export function createOAuthService(
  credentialService: OAuthSessionCredentialService,
  dependencies: Omit<OAuthServiceDependencies, "adapters"> = {},
): OAuthService {
  return new OAuthService(credentialService, {
    ...dependencies,
    adapters: createOAuthProviderAdapters(createOAuthRuntimeConfig(dependencies.env), {
      apiClient: dependencies.apiClient,
    }),
  });
}
