import assert from "node:assert/strict";
import test from "node:test";
import { BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID } from "@zcode/shared";
import type {
  ApiClient,
  OAuthCallbackParams,
  OAuthProviderAdapter,
  OAuthTokenSet,
  OAuthUserProfile,
} from "@zcode/shared";
import type { ICredentialService } from "../src/credential/credential.js";
import {
  OAuthProfileIdentityMismatchError,
  refreshLegacyBigModelCachedProfile,
} from "../src/oauth/oauthProfileSchema.js";
import { OAuthService } from "../src/oauth/oauthService.js";

/**
 * OAuth 主身份不被业务 userinfo 覆盖（对齐上游 S10：mergeOAuthDisplayProfile + 显式拒绝）。
 *
 * 现场：BigModel 业务 userinfo 的 customerNumber 属于业务账号，旧代码把整份 profile 写回
 * user_info，两个 ID 不同时设备、关联与额度都会指向另一个账号。这里用真实 OAuthService +
 * 内存凭据服务跑落盘/读回，不停在纯函数层。
 */

const MAIN_USER_ID = "zcode-user-1";
const BUSINESS_USER_ID = "customer-999";

interface CredentialHarness extends ICredentialService {
  readonly store: Map<string, string>;
  /** 每次 load 返回后回调：用于在"刷新已读到可信主身份、远端请求仍在飞行"的窗口里改存储。 */
  afterLoad?: (key: string) => void;
}

function createCredentialHarness(initial: Record<string, string> = {}): CredentialHarness {
  const store = new Map(Object.entries(initial));
  const harness: CredentialHarness = {
    store,
    async load(key: string): Promise<string | null> {
      const value = store.get(key) ?? null;
      harness.afterLoad?.(key);
      return value;
    },
    async save(key: string, value: string): Promise<void> {
      store.set(key, value);
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
  };
  return harness;
}

type FetchUserInfo = (tokenSet: OAuthTokenSet) => Promise<OAuthUserProfile>;

function createAdapter(providerId: string, fetchUserInfo: FetchUserInfo): OAuthProviderAdapter {
  return {
    providerId,
    meta: { id: providerId, displayName: providerId, enabled: true, order: 0 },
    redirectUri: "https://example.test/callback",
    apiClient: {} as unknown as ApiClient,
    parseCallbackParams(_url: string): OAuthCallbackParams {
      return { code: "code", state: "state" } as OAuthCallbackParams;
    },
    buildAuthorizeUrl(): string {
      return "https://example.test/authorize";
    },
    async exchangeToken(): Promise<OAuthTokenSet> {
      throw new Error("not used in profile identity tests");
    },
    fetchUserInfo(tokenSet: OAuthTokenSet): Promise<OAuthUserProfile> {
      return fetchUserInfo(tokenSet);
    },
    normalizeError(error: unknown): Error {
      return error instanceof Error ? error : new Error(String(error));
    },
  };
}

function profile(
  id: string,
  name: string,
  extra: Partial<OAuthUserProfile> = {},
): OAuthUserProfile {
  return { id, username: name, displayName: name, ...extra };
}

function seededCredentials(mainProfile: OAuthUserProfile): Record<string, string> {
  return {
    "oauth:active_provider": ZAI_PROVIDER_ID,
    "oauth:zai:access_token": "access-token-of-main-account",
    zcodejwttoken: "zcode-jwt-of-main-account",
    "oauth:zai:user_info": JSON.stringify(mainProfile),
  };
}

function readStoredProfile(harness: CredentialHarness): OAuthUserProfile {
  return JSON.parse(harness.store.get("oauth:zai:user_info") ?? "null") as OAuthUserProfile;
}

test("BigModel 旧缓存迁移只合并展示字段：业务 customerNumber 不替换主身份", async () => {
  const cachedProfile = profile(MAIN_USER_ID, "旧昵称", { avatarUrl: "https://old/avatar.png" });
  const saved: OAuthUserProfile[] = [];
  const migrated = await refreshLegacyBigModelCachedProfile({
    adapter: createAdapter(BIGMODEL_PROVIDER_ID, async () =>
      profile(BUSINESS_USER_ID, "业务账号", { avatarUrl: "https://new/avatar.png" }),
    ),
    cachedProfile,
    loadTokenSet: async () => ({ accessToken: "bigmodel-access-token" }),
    now: () => 1_700_000_000_000,
    runWithAdapterError: (run) => run(),
    saveProfile: async (nextProfile) => {
      saved.push(nextProfile);
    },
  });

  assert.equal(saved.length, 1, "迁移必须落盘一次");
  assert.equal(migrated.id, MAIN_USER_ID, "主身份不能被业务账号替换");
  assert.equal(migrated.username, "业务账号", "展示名取业务 userinfo");
  assert.equal(migrated.displayName, "业务账号");
  assert.equal(migrated.avatarUrl, "https://new/avatar.png");
  assert.deepEqual(saved[0]?.rawProfile, { zcodeProfileSchemaVersion: 2 });
});

test("restoreSession：业务 userinfo 主体不一致时保留 ZCode 主身份并只更新展示字段", async () => {
  const harness = createCredentialHarness(seededCredentials(profile(MAIN_USER_ID, "旧昵称")));
  const service = new OAuthService(harness, {
    adapters: [
      createAdapter(ZAI_PROVIDER_ID, async () =>
        profile(BUSINESS_USER_ID, "新昵称", { avatarUrl: "https://a/b.png" }),
      ),
    ],
  });

  const userInfo = await service.restoreSession();

  assert.equal(userInfo?.id, MAIN_USER_ID, "对外展示的主身份仍是 ZCode 账号");
  const stored = readStoredProfile(harness);
  assert.equal(stored.id, MAIN_USER_ID);
  assert.equal(stored.username, "新昵称");
  assert.equal(stored.avatarUrl, "https://a/b.png");
  assert.equal(harness.store.get("oauth:zai:access_token"), "access-token-of-main-account");
});

test("restoreSession：刷新期间主身份被并发登录换掉时拒绝写入并保留新凭据", async () => {
  const harness = createCredentialHarness(seededCredentials(profile(MAIN_USER_ID, "旧昵称")));
  let releaseFetch: (() => void) | undefined;
  const fetchGate = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  const service = new OAuthService(harness, {
    adapters: [
      createAdapter(ZAI_PROVIDER_ID, async () => {
        await fetchGate;
        return profile(BUSINESS_USER_ID, "刷新到的昵称");
      }),
    ],
  });

  const otherSession = profile("other-user", "另一个账号");
  // 刷新读到可信主身份之后、远端 userinfo 返回之前，另一进程完成了一次新登录：
  // 主身份换成 other-user，token 也换了。旧刷新结果不允许再落盘。
  harness.afterLoad = (key) => {
    if (key !== "oauth:zai:user_info") return;
    harness.afterLoad = undefined;
    harness.store.set("oauth:zai:user_info", JSON.stringify(otherSession));
    harness.store.set("oauth:zai:access_token", "access-token-of-other-account");
  };
  const refreshing = service.restoreSession();
  await new Promise((resolve) => setTimeout(resolve, 0));
  releaseFetch?.();

  await assert.rejects(refreshing, (error: unknown) => {
    assert.ok(error instanceof OAuthProfileIdentityMismatchError, "必须是可诊断的显式拒绝");
    assert.equal(error.reason, "stored-identity-changed");
    assert.equal(error.expectedUserId, MAIN_USER_ID);
    assert.equal(error.observedUserId, "other-user");
    return true;
  });

  assert.deepEqual(readStoredProfile(harness), otherSession, "原凭据必须保持可读且未被覆盖");
  assert.equal(harness.store.get("oauth:zai:access_token"), "access-token-of-other-account");
});

test("restoreSession：并发两次刷新不会互相覆盖主身份字段", async () => {
  const harness = createCredentialHarness(seededCredentials(profile(MAIN_USER_ID, "旧昵称")));
  let fetchCount = 0;
  const service = new OAuthService(harness, {
    adapters: [
      createAdapter(ZAI_PROVIDER_ID, async () => {
        fetchCount += 1;
        const index = fetchCount;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return profile(`customer-${index}`, `并发昵称-${index}`);
      }),
    ],
  });

  const [first, second] = await Promise.all([service.restoreSession(), service.restoreSession()]);

  assert.equal(first?.id, MAIN_USER_ID);
  assert.equal(second?.id, MAIN_USER_ID);
  const stored = readStoredProfile(harness);
  assert.equal(stored.id, MAIN_USER_ID, "并发刷新后主身份不变");
  assert.ok(
    ["并发昵称-1", "并发昵称-2"].includes(stored.displayName),
    `展示字段只能是其中一次刷新结果，实际 ${stored.displayName}`,
  );
  assert.equal(harness.store.get("oauth:zai:access_token"), "access-token-of-main-account");
});

test("restoreSession：BigModel 哨兵回退不落盘，不给旧缓存盖 schema 版本", async () => {
  const cached = profile(MAIN_USER_ID, "旧昵称", { avatarUrl: "https://old/a.png" });
  const harness = createCredentialHarness({
    "oauth:active_provider": BIGMODEL_PROVIDER_ID,
    "oauth:bigmodel:access_token": "bigmodel-access-token",
    zcodejwttoken: "zcode-jwt-of-main-account",
    "oauth:bigmodel:user_info": JSON.stringify(cached),
  });
  const service = new OAuthService(harness, {
    adapters: [
      createAdapter(BIGMODEL_PROVIDER_ID, async () => ({
        id: "unknown",
        username: "user",
        displayName: "User",
      })),
    ],
  });

  const userInfo = await service.restoreSession();

  assert.equal(userInfo?.id, MAIN_USER_ID);
  assert.equal(userInfo?.displayName, "旧昵称");
  // 写入会附上 zcodeProfileSchemaVersion=2，让 BigModel 之后的真实展示名迁移被跳过。
  assert.deepEqual(JSON.parse(harness.store.get("oauth:bigmodel:user_info") ?? "null"), cached);
});

test("restoreSession：缺少可信缓存时要求重新登录，不用业务 userinfo 构造主身份", async () => {
  const harness = createCredentialHarness({
    "oauth:active_provider": ZAI_PROVIDER_ID,
    "oauth:zai:access_token": "access-token-of-main-account",
    zcodejwttoken: "zcode-jwt-of-main-account",
  });
  const service = new OAuthService(harness, {
    adapters: [createAdapter(ZAI_PROVIDER_ID, async () => profile(BUSINESS_USER_ID, "业务账号"))],
  });

  assert.equal(await service.restoreSession(), null);
  assert.equal(harness.store.get("oauth:zai:user_info"), undefined, "不得写入业务账号作为主身份");
});
