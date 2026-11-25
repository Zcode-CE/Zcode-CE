import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID } from "@zcode/shared";
import type {
  ApiClient,
  OAuthCallbackParams,
  OAuthProviderAdapter,
  OAuthTokenSet,
  OAuthUserProfile,
} from "@zcode/shared";
import {
  createSystemCredentialCipher,
  type CredentialKeyStore,
} from "@zcode/shared/credential-security";
import {
  OAUTH_SESSION_REVISION_KEY,
  type CredentialMutationEvent,
} from "../src/credential/credential.js";
import { createCredentialService } from "../src/credential/credentialService.js";
import { OAuthService } from "../src/oauth/oauthService.js";
import {
  OAuthCredentialRepo,
  type OAuthSessionChange,
} from "../src/oauth/repo/oauthCredentialRepo.js";
import { getCredentialsFilePath, setDataBaseDir } from "../src/paths.js";

/**
 * OAuth 原子提交的验收断言（SPEC §7.3 / §7.6）。
 *
 * 这里钉住的是「登录、刷新、切号、登出都是一次整组 CAS 提交」：同一份快照只有一个赢家、
 * 过期响应返回 false 且磁盘字节不变、切号把旧身份域一起清掉、一次提交只发一个带 keys[] 的通知。
 * 用真实 createCredentialService（真文件锁 + 真加密容器、fake keyStore）跑，不用内存替身 ——
 * 并发安全恰恰是替身最容易放行的地方。
 */

const temporaryDirs: string[] = [];

after(async () => {
  setDataBaseDir(null);
  await Promise.all(temporaryDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Harness {
  readonly filePath: string;
  readonly events: CredentialMutationEvent[];
  /** 每次调用产出一个独立服务实例（共享同一凭据文件与密钥，模拟多个 Host/CLI）。 */
  readonly createService: () => ReturnType<typeof createCredentialService>;
}

function createFakeKeyStore(): CredentialKeyStore {
  let value: string | null = null;
  return {
    async get() {
      return value;
    },
    async set(next: string) {
      value = next;
    },
  };
}

async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "zcode-oauth-atomic-"));
  temporaryDirs.push(root);
  setDataBaseDir(root);
  const filePath = getCredentialsFilePath();
  const cipher = createSystemCredentialCipher({
    filePath,
    env: {},
    keyStore: createFakeKeyStore(),
  });
  const events: CredentialMutationEvent[] = [];
  return {
    filePath,
    events,
    createService: () =>
      createCredentialService({
        cipher,
        onDidMutate: (event) => {
          events.push(event);
        },
      }),
  };
}

function createRepo(service: ReturnType<typeof createCredentialService>): OAuthCredentialRepo {
  return new OAuthCredentialRepo(service);
}

/** 保留来源与密钥指纹、破坏载荷：模拟「密钥还在但密文损坏」。 */
async function damageStoredCredential(filePath: string, key: string): Promise<void> {
  const record = JSON.parse(await readFile(filePath, "utf8")) as Record<string, string>;
  const [prefix, source, fingerprint] = (record[key] ?? "").split(":");
  record[key] =
    `${prefix}:${source}:${fingerprint}:${Buffer.from("damaged").toString("base64url")}`;
  await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`);
}

function profile(id: string, name: string): OAuthUserProfile {
  return { id, username: name, displayName: name };
}

/** 一次 ZAI 登录的完整会话变更：token + user_info + active provider。 */
function zaiLoginChange(accessToken: string, userId: string): OAuthSessionChange {
  return {
    activeProvider: ZAI_PROVIDER_ID,
    providers: [
      {
        provider: ZAI_PROVIDER_ID,
        tokenSet: { accessToken, zcodeJwtToken: `jwt-${userId}` },
        profile: profile(userId, `昵称-${userId}`),
      },
    ],
  };
}

test("8 个服务实例并发提交同一份快照：只有一个生效，通知只发一次且键去重", async () => {
  const harness = await createHarness();
  const repos = Array.from({ length: 8 }, () => createRepo(harness.createService()));
  const snapshots = await Promise.all(repos.map((repo) => repo.captureSessionSnapshot()));

  const results = await Promise.all(
    repos.map((repo, index) =>
      repo.commitSessionChange(
        snapshots[index]!,
        zaiLoginChange(`token-${index}`, `user-${index}`),
      ),
    ),
  );

  assert.equal(results.filter(Boolean).length, 1, "同一份快照只能有一个提交成功");
  const winner = results.indexOf(true);
  const reader = repos[0]!;
  assert.equal(await reader.getActiveProvider(), ZAI_PROVIDER_ID);
  assert.equal((await reader.loadTokenSet(ZAI_PROVIDER_ID))?.accessToken, `token-${winner}`);
  assert.equal((await reader.loadUserProfile(ZAI_PROVIDER_ID))?.id, `user-${winner}`);

  assert.equal(harness.events.length, 1, "8 次尝试里只有一次真正提交，通知只能发一次");
  const [event] = harness.events;
  assert.equal(event?.operation, "batch");
  const keys = event?.keys ?? [];
  assert.equal(new Set(keys).size, keys.length, "批量通知的键必须去重");
  for (const key of [
    "oauth:active_provider",
    "oauth:zai:access_token",
    "oauth:zai:user_info",
    "zcodejwttoken",
    OAUTH_SESSION_REVISION_KEY,
  ]) {
    assert.ok(keys.includes(key), `通知必须带 ${key}`);
  }
});

test("密文损坏等价强制登出：清掉损坏键后同一次登录仍能提交", async () => {
  const harness = await createHarness();
  const repo = createRepo(harness.createService());
  assert.equal(
    await repo.commitSessionChange(
      await repo.captureSessionSnapshot(),
      zaiLoginChange("token-old", "user-old"),
    ),
    true,
  );
  await damageStoredCredential(harness.filePath, "oauth:zai:user_info");

  // 读取触发强制登出（与既有语义一致）；返回的快照必须与清理后的磁盘一致，
  // 否则接下来的登录提交会以「版本键不匹配」永远失败。
  const snapshot = await repo.captureSessionSnapshot();
  assert.equal(snapshot.values["oauth:zai:access_token"], null);
  assert.match(snapshot.values[OAUTH_SESSION_REVISION_KEY] ?? "", /^[0-9a-f-]{36}$/);

  assert.equal(
    await repo.commitSessionChange(snapshot, zaiLoginChange("token-new", "user-new")),
    true,
  );
  assert.equal((await repo.loadTokenSet(ZAI_PROVIDER_ID))?.accessToken, "token-new");
  assert.equal((await repo.loadUserProfile(ZAI_PROVIDER_ID))?.id, "user-new");
});

test("旧响应以过期快照提交：返回 false 且磁盘字节不变", async () => {
  const harness = await createHarness();
  const repo = createRepo(harness.createService());
  const stale = await repo.captureSessionSnapshot();
  assert.equal(await repo.commitSessionChange(stale, zaiLoginChange("token-A", "user-A")), true);

  const before = await readFile(harness.filePath);
  harness.events.length = 0;
  assert.equal(await repo.commitSessionChange(stale, zaiLoginChange("token-B", "user-B")), false);
  assert.deepEqual(await readFile(harness.filePath), before, "CAS 失败不得写盘");
  assert.equal(harness.events.length, 0, "CAS 失败不得发通知");
  assert.equal((await repo.loadTokenSet(ZAI_PROVIDER_ID))?.accessToken, "token-A");
  assert.equal((await repo.loadUserProfile(ZAI_PROVIDER_ID))?.id, "user-A");
});

test("跨进程登录竞态：版本键变化后，旧登录响应不覆盖新登录也不轮换版本", async () => {
  const harness = await createHarness();
  const staleRepo = createRepo(harness.createService());
  const liveRepo = createRepo(harness.createService());

  // 两边同时开始：拿到的都是登录前的同一份快照。
  const staleSnapshot = await staleRepo.captureSessionSnapshot();
  const liveSnapshot = await liveRepo.captureSessionSnapshot();
  assert.equal(
    await liveRepo.commitSessionChange(liveSnapshot, zaiLoginChange("token-new", "user-new")),
    true,
  );

  const afterNewLogin = await liveRepo.captureSessionSnapshot();
  assert.notEqual(
    afterNewLogin.values[OAUTH_SESSION_REVISION_KEY],
    staleSnapshot.values[OAUTH_SESSION_REVISION_KEY],
    "一次成功提交必须轮换版本键",
  );

  assert.equal(
    await staleRepo.commitSessionChange(staleSnapshot, zaiLoginChange("token-stale", "user-stale")),
    false,
    "过期响应必须被丢弃",
  );
  const stored = await staleRepo.captureSessionSnapshot();
  assert.equal(stored.values["oauth:zai:access_token"], "token-new");
  assert.equal(stored.values["oauth:zai:user_info"], afterNewLogin.values["oauth:zai:user_info"]);
  assert.equal(
    stored.values[OAUTH_SESSION_REVISION_KEY],
    afterNewLogin.values[OAUTH_SESSION_REVISION_KEY],
    "被丢弃的提交不得轮换版本键",
  );
});

test("切号提交是整组写：旧身份域一起清空、共享 JWT 换成新值", async () => {
  const harness = await createHarness();
  const repo = createRepo(harness.createService());
  const initial = await repo.captureSessionSnapshot();
  assert.equal(
    await repo.commitSessionChange(initial, {
      activeProvider: BIGMODEL_PROVIDER_ID,
      providers: [
        {
          provider: BIGMODEL_PROVIDER_ID,
          tokenSet: { accessToken: "bigmodel-token", zcodeJwtToken: "jwt-bigmodel" },
          profile: profile("bigmodel-user", "旧账号"),
        },
      ],
    }),
    true,
  );
  harness.events.length = 0;

  const snapshot = await repo.captureSessionSnapshot();
  const committed = await repo.commitSessionChange(snapshot, {
    activeProvider: ZAI_PROVIDER_ID,
    providers: [
      { provider: BIGMODEL_PROVIDER_ID, tokenSet: null, profile: null },
      {
        provider: ZAI_PROVIDER_ID,
        tokenSet: { accessToken: "zai-token", zcodeJwtToken: "jwt-zai" },
        profile: profile("zai-user", "新账号"),
      },
    ],
  });

  assert.equal(committed, true);
  assert.equal(await repo.getActiveProvider(), ZAI_PROVIDER_ID);
  assert.equal(await repo.loadTokenSet(BIGMODEL_PROVIDER_ID), null, "旧身份域必须一起清空");
  assert.equal(await repo.loadUserProfile(BIGMODEL_PROVIDER_ID), null);
  assert.deepEqual(await repo.loadTokenSet(ZAI_PROVIDER_ID), {
    accessToken: "zai-token",
    zcodeJwtToken: "jwt-zai",
  });
  assert.equal(harness.events.length, 1, "切号只产生一个批量通知");
  assert.equal(harness.events[0]?.operation, "batch");
  const keys = harness.events[0]?.keys ?? [];
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.includes("oauth:bigmodel:access_token"), "旧 provider 的清理必须在同一批通知里");
  assert.ok(keys.includes("oauth:zai:access_token"));
});

test("锁内复核：assertCurrent 抛错时一个键都不写，也不发通知", async () => {
  const harness = await createHarness();
  const repo = createRepo(harness.createService());
  const snapshot = await repo.captureSessionSnapshot();

  await assert.rejects(
    () =>
      repo.commitSessionChange(snapshot, zaiLoginChange("token", "user"), {
        assertCurrent: () => {
          throw new Error("OAuth flow 已取消");
        },
      }),
    /已取消/,
  );

  assert.deepEqual(await repo.captureSessionSnapshot(), snapshot, "取消后存储必须保持原样");
  assert.equal(harness.events.length, 0);
});

test("归因写入不属于会话事务：登录快照之后写归因不影响登录提交", async () => {
  const harness = await createHarness();
  const repo = createRepo(harness.createService());
  const snapshot = await repo.captureSessionSnapshot();

  // 归因回调常先于授权码到达；它若参与会话快照或轮换版本键，同一 flow 的登录提交会必然失败。
  await repo.saveLoginAttribution({ utm_source: "wx" });
  assert.equal(await repo.commitSessionChange(snapshot, zaiLoginChange("token-A", "user-A")), true);
  assert.deepEqual(await repo.loadLoginAttribution(), { utm_source: "wx" });
});

function createLoginAdapter(): OAuthProviderAdapter {
  return {
    providerId: ZAI_PROVIDER_ID,
    meta: { id: ZAI_PROVIDER_ID, displayName: "Z.AI", enabled: true, order: 0 },
    redirectUri: "https://example.test/callback",
    apiClient: {} as unknown as ApiClient,
    parseCallbackParams(_url: string): OAuthCallbackParams {
      return { code: "code", state: "state" } as OAuthCallbackParams;
    },
    buildAuthorizeUrl(): string {
      return "https://example.test/authorize?state=state";
    },
    async exchangeToken(): Promise<OAuthTokenSet> {
      return { accessToken: "late-token", zcodeJwtToken: "late-jwt" };
    },
    async fetchUserInfo(): Promise<OAuthUserProfile> {
      return profile("late-user", "迟到的登录");
    },
    normalizeError(error: unknown): Error {
      return error instanceof Error ? error : new Error(String(error));
    },
  };
}

test("登录回调迟到：授权期间另一进程完成登录时丢弃旧结果且不改写磁盘", async () => {
  const harness = await createHarness();
  const service = new OAuthService(harness.createService(), {
    adapters: [createLoginAdapter()],
  });
  const otherRepo = createRepo(harness.createService());

  const start = await service.startOAuth(ZAI_PROVIDER_ID);
  // 授权期间另一个 Host/CLI 完成了新登录：快照从这一刻起就过期了。
  assert.equal(
    await otherRepo.commitSessionChange(
      await otherRepo.captureSessionSnapshot(),
      zaiLoginChange("other-token", "other-user"),
    ),
    true,
  );

  await assert.rejects(
    () => service.handleCallback(`https://example.test/callback?code=code&state=${start.state}`),
    /已被更新的会话覆盖/,
    "过期登录结果必须显式失败，不能静默写盘",
  );

  assert.equal(
    (await otherRepo.loadTokenSet(ZAI_PROVIDER_ID))?.accessToken,
    "other-token",
    "新登录不得被迟到的回调覆盖",
  );
  assert.equal((await otherRepo.loadUserProfile(ZAI_PROVIDER_ID))?.id, "other-user");
  assert.equal(harness.events.length, 1, "被丢弃的登录提交不得发通知");

  // 失败的回调不会自己收口 pending：清掉它，否则 5 分钟的 flow 超时定时器会让测试进程挂住。
  await service.cancelPending();
});
