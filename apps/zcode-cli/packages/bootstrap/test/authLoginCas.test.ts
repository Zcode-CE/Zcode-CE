import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import type { HttpClientPort } from "@zcode/contracts";
import { CREDENTIAL_DECRYPT_ERROR_CODE } from "@zcode/shared";
import {
  createSharedZCodeCredentialStore,
  SHARED_ZCODE_CREDENTIAL_KEYS,
  type CliOAuthUser,
  type SharedZCodeCredentialStore,
} from "@zcode/adapters/auth";
import {
  CREDENTIAL_SECURE_STORAGE_UNAVAILABLE_CODE,
  createSystemCredentialCipher,
  type CredentialCipher,
  type CredentialKeyStore,
} from "@zcode/shared/credential-security";
import {
  captureLoginSessionSnapshot,
  captureStandaloneAccountSnapshot,
  commitLoginSessionChange,
  commitStandaloneAccountCredentials,
  type LoginSessionChange,
} from "../src/auth-login-credentials.js";
import { loginZCodeCli, ZCodeCliLoginError, type LoginZCodeCliOptions } from "../src/auth-login.js";
import {
  standaloneAccountIdentityCredentialKey,
  standaloneAccountProviderCredentialKey,
} from "../src/app/standalone-account-provider-runtime.js";

/**
 * CLI 登录写入的整组 CAS 判据（SPEC §7.3 第 3–4 步的 CLI 侧）。
 *
 * 为什么要这些断言：CLI 与 Desktop Host 共用同一份 credentials.json，登录要写多组键。
 * 旧实现是整组无条件写，两个方向都会静默出错 —— CLI 的迟到响应覆盖 Host 刚完成的登录，
 * 或两个 CLI 交错落盘拼出「A 的 token + B 的 profile」。两者都不报错，只在真实使用里
 * 表现为「刚登录又被退出」或「模型鉴权失败」，所以必须用测试钉住：
 * ① 两实例用同一快照登录 ⇒ 只有一个成功，另一个 CAS 失败且磁盘不变；
 * ② 登录中途版本键被改 ⇒ 丢弃并提示重新登录；
 * ③ 一次成功提交只发一次通知，且版本键轮换（失败提交不发通知）；
 * ④ 归因类旁路键不参与 CAS、也不被登录清掉；
 * ⑤ 账号组键解不开 ⇒ 锁内清理后重取快照继续，仍失败抛 credential_unreadable。
 *
 * 运行：cd apps/zcode-cli/packages/bootstrap && node --import tsx --import
 *   ../../../../packages/services/test/support/zcodeSourceResolver.mjs --test test/authLoginCas.test.ts
 */

const KEYS = SHARED_ZCODE_CREDENTIAL_KEYS;
const SESSION_KEYS: readonly string[] = Object.values(KEYS);
const NOW_MS = 1_700_000_000_000;
/** 真实发布的内置 Provider 目录：登录要按它解析 Coding Plan Provider，测试只读复制，不改仓库文件。 */
const BUILTIN_PROVIDER_CONFIG_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "..",
  "config",
  "provider",
  "zcode-builtin.json",
);
const ATTRIBUTION_KEY = "oauth:login_attribution";
const NON_SESSION_KEY = "account-provider:test-provider:identity";

const ZAI_USER: CliOAuthUser = { email: "zai@example.test", name: "ZAI User", user_id: "zai-user" };
const BIGMODEL_USER: CliOAuthUser = { name: "BigModel User", user_id: "bigmodel-user" };

const temporaryDirs: string[] = [];
const originalHome = process.env.HOME;

after(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await Promise.all(temporaryDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Harness {
  readonly cipher: CredentialCipher;
  readonly env: Record<string, string>;
  readonly filePath: string;
  readonly personalProviderConfigPath: string;
  /** 每个实例都是一份独立的「进程内视图」：多实例 = 多个 CLI/Host 进程共享同一份文件。 */
  createStore(): SharedZCodeCredentialStore;
  /** 每次 onDidChange 记一笔，用来断言「一次提交只发一次通知」。 */
  readonly notifications: number[];
}

async function createHarness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-cli-login-cas-"));
  temporaryDirs.push(dir);
  const builtinConfigPath = join(dir, "zcode-builtin.json");
  await copyFile(BUILTIN_PROVIDER_CONFIG_PATH, builtinConfigPath);
  // 旧 CLI 配置迁移读 ~/.zcode：把 HOME 指到临时目录，测试不碰真实用户目录。
  process.env.HOME = dir;
  const filePath = join(dir, "credentials.json");
  let keyValue: string | null = null;
  const keyStore: CredentialKeyStore = {
    async get() {
      return keyValue;
    },
    async set(next: string) {
      keyValue = next;
    },
  };
  const cipher = createSystemCredentialCipher({ filePath, env: {}, keyStore });
  const notifications: number[] = [];
  return {
    cipher,
    env: { HOME: dir, ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinConfigPath },
    filePath,
    notifications,
    personalProviderConfigPath: join(dir, "personal-provider.json"),
    createStore() {
      const store = createSharedZCodeCredentialStore({ filePath, cipher });
      // onDidChange 在 store 契约里是可选的：测试必须自己确认它存在，否则「通知只发一次」
      // 这条断言会在没有通知源的情况下默默通过。
      assert.ok(store.onDidChange, "CLI store 必须提供变更通知");
      store.onDidChange(() => {
        notifications.push(1);
      });
      return store;
    },
  };
}

function createOAuthHttpClient(input: {
  readonly accessToken: string;
  readonly pendingPolls?: number;
  readonly providerId: "bigmodel" | "zai";
  readonly refreshToken?: string;
  readonly token: string;
  readonly user: CliOAuthUser;
}): HttpClientPort {
  let polls = 0;
  return {
    async request(request) {
      const envelope = request.url.includes("/oauth/cli/init")
        ? {
            code: 0,
            data: {
              authorize_url: "https://example.test/oauth/authorize",
              expires_at: NOW_MS / 1_000 + 300,
              flow_id: "test-flow",
              poll_interval_sec: 1,
            },
          }
        : {
            code: 0,
            data:
              polls++ < (input.pendingPolls ?? 1)
                ? { status: "pending" }
                : {
                    status: "ready",
                    token: input.token,
                    user: input.user,
                    [input.providerId]: {
                      access_token: input.accessToken,
                      ...(input.refreshToken ? { refresh_token: input.refreshToken } : {}),
                    },
                  },
          };
      return {
        body: new TextEncoder().encode(JSON.stringify(envelope)),
        bytes: 0,
        durationMs: 0,
        headers: {},
        status: 200,
        statusText: "OK",
        url: request.url,
      };
    },
  };
}

function loginOptions(
  harness: Harness,
  input: {
    readonly apiKeyResolver?: LoginZCodeCliOptions["apiKeyResolver"];
    readonly credentialStore: SharedZCodeCredentialStore;
    readonly httpClient: HttpClientPort;
    readonly onPollStatus?: LoginZCodeCliOptions["onPollStatus"];
    readonly providerId: "bigmodel" | "zai";
  },
): LoginZCodeCliOptions {
  return {
    env: harness.env,
    noBrowser: true,
    now: () => NOW_MS,
    sleep: async () => {},
    pollToken: "test-poll-token",
    personalProviderConfigPath: harness.personalProviderConfigPath,
    apiKeyResolver: {
      async resolve() {
        return "resolved-api-key";
      },
    },
    ...input,
  };
}

/** 多实例同步闸：所有参与者都读到登录开始时的快照后，才允许任何一方提交。 */
function createBarrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let release: (() => void) | undefined;
  const released = new Promise<void>((resolveReleased) => {
    release = resolveReleased;
  });
  return async () => {
    arrived += 1;
    if (arrived >= parties) release?.();
    await released;
  };
}

function assertLoginError(reason: unknown, code: ZCodeCliLoginError["code"]): ZCodeCliLoginError {
  assert.ok(
    reason instanceof ZCodeCliLoginError,
    `期望 ZCodeCliLoginError，实际：${String(reason)}`,
  );
  assert.equal(reason.code, code);
  return reason;
}

/**
 * 保留前缀、来源与密钥指纹，改坏密文载荷的中间字符：字节必变、GCM 认证必失败，
 * 等价旧密钥残留/比特腐烂（换密钥会变成「存储不可用」，不是同一种失败）。
 */
async function damageStoredValue(filePath: string, key: string): Promise<void> {
  const raw = JSON.parse(await readFile(filePath, "utf8")) as Record<string, string>;
  const ciphertext = raw[key];
  if (ciphertext === undefined) throw new Error(`credential key missing: ${key}`);
  const segments = ciphertext.split(":");
  const payloadIndex = segments.length - 1;
  const payload = segments[payloadIndex]!;
  const index = Math.floor(payload.length / 2);
  const flipped = payload[index] === "A" ? "B" : "A";
  segments[payloadIndex] = payload.slice(0, index) + flipped + payload.slice(index + 1);
  raw[key] = segments.join(":");
  await writeFile(filePath, `${JSON.stringify(raw, null, 2)}\n`);
}

function createSessionChange(providerId: "bigmodel" | "zai", label: string): LoginSessionChange {
  return {
    accessToken: `${label}-access`,
    providerId,
    userInfoRaw: JSON.stringify({ id: label, username: label, displayName: label }),
    zcodeJwtToken: `${label}-jwt`,
  };
}

test("两实例用同一份快照登录：只有一个提交成功，另一个丢弃且不落盘", async () => {
  const harness = await createHarness();
  const barrier = createBarrier(2);
  const results = await Promise.allSettled([
    loginZCodeCli(
      loginOptions(harness, {
        credentialStore: harness.createStore(),
        httpClient: createOAuthHttpClient({
          accessToken: "zai-access",
          providerId: "zai",
          token: "zai-jwt",
          user: ZAI_USER,
        }),
        providerId: "zai",
        apiKeyResolver: {
          async resolve() {
            await barrier();
            return "zai-api-key";
          },
        },
      }),
    ),
    loginZCodeCli(
      loginOptions(harness, {
        credentialStore: harness.createStore(),
        httpClient: createOAuthHttpClient({
          accessToken: "bigmodel-access",
          providerId: "bigmodel",
          refreshToken: "bigmodel-refresh",
          token: "bigmodel-jwt",
          user: BIGMODEL_USER,
        }),
        providerId: "bigmodel",
        apiKeyResolver: {
          async resolve() {
            await barrier();
            return "bigmodel-api-key";
          },
        },
      }),
    ),
  ]);

  const fulfilled = results.filter((result) => result.status === "fulfilled");
  assert.equal(fulfilled.length, 1, "同一份快照上的两次登录只能有一个提交成功");
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(rejected && rejected.status === "rejected");
  const conflict = assertLoginError(rejected.reason, "credential_conflict");
  assert.match(conflict.message, /retry login/i, "丢弃登录必须给出可操作的重试提示");

  const stored = await harness.createStore().loadMany(SESSION_KEYS);
  const winnerProvider = stored[KEYS.activeProvider];
  assert.ok(winnerProvider === "zai" || winnerProvider === "bigmodel");
  // 败方一个键都没写：它的 token / user_info 不应出现在盘上（整组 CAS 不产生半成品）。
  const loserKeys =
    winnerProvider === "zai"
      ? [KEYS.bigmodelAccessToken, KEYS.bigmodelUserInfo, KEYS.bigmodelRefreshToken]
      : [KEYS.zaiAccessToken, KEYS.zaiUserInfo];
  for (const key of loserKeys) {
    assert.equal(stored[key], null, `败方不得写入 ${key}`);
  }
  assert.equal(typeof stored[KEYS.sessionRevision], "string", "成功提交必须轮换会话版本键");
});

test("登录中途版本键被改：本次丢弃、磁盘保持竞争者的结果", async () => {
  const harness = await createHarness();
  const store = harness.createStore();
  const competitor = harness.createStore();
  const competitorChange = createSessionChange("zai", "competitor");
  let competitorBytes: Buffer | undefined;
  let pollCount = 0;

  await assert.rejects(
    () =>
      loginZCodeCli(
        loginOptions(harness, {
          credentialStore: store,
          httpClient: createOAuthHttpClient({
            accessToken: "bigmodel-access",
            providerId: "bigmodel",
            token: "bigmodel-jwt",
            user: BIGMODEL_USER,
          }),
          onPollStatus: async () => {
            if (pollCount++ > 0) return;
            // 待授权期间另一处登录完成并轮换了版本键。
            const snapshot = await captureLoginSessionSnapshot(competitor);
            assert.equal(
              await commitLoginSessionChange(competitor, snapshot, competitorChange),
              true,
              "竞争者的提交必须成立（它读到的是最新快照）",
            );
            competitorBytes = await readFile(harness.filePath);
          },
          providerId: "bigmodel",
        }),
      ),
    (reason) => {
      const conflict = assertLoginError(reason, "credential_conflict");
      assert.match(conflict.message, /retry login/i);
      return true;
    },
  );

  assert.ok(competitorBytes, "竞争者的提交必须在轮询期间发生");
  assert.deepEqual(await readFile(harness.filePath), competitorBytes, "被丢弃的登录不得写盘");
  const stored = await store.loadMany(SESSION_KEYS);
  assert.equal(stored[KEYS.activeProvider], "zai", "落盘的是竞争者的会话");
  assert.equal(stored[KEYS.zaiAccessToken], competitorChange.accessToken);
  assert.equal(stored[KEYS.bigmodelAccessToken], null, "过期登录的 token 不得混进新会话");
});

test("成功登录：会话组与账号组各提交一次、各发一次通知，旁路键不动", async () => {
  const harness = await createHarness();
  const store = harness.createStore();
  await store.saveMany({ [ATTRIBUTION_KEY]: '{"channel_id":"cli"}' });
  const commits: Array<{
    readonly changes: Record<string, string | null>;
    readonly expected: Record<string, string | null>;
  }> = [];
  const countingStore: SharedZCodeCredentialStore = {
    ...store,
    async updateMany(changes, options = {}) {
      commits.push({ changes: { ...changes }, expected: { ...options.expected } });
      return await store.updateMany(changes, options);
    },
  };
  harness.notifications.length = 0;

  const result = await loginZCodeCli(
    loginOptions(harness, {
      credentialStore: countingStore,
      httpClient: createOAuthHttpClient({
        accessToken: "bigmodel-access",
        providerId: "bigmodel",
        refreshToken: "bigmodel-refresh",
        token: "bigmodel-jwt",
        user: BIGMODEL_USER,
      }),
      providerId: "bigmodel",
    }),
  );
  assert.equal(result.providerId, "bigmodel");
  assert.equal(result.model, "account:bigmodel-individual-coding-plan/GLM-5.3");

  assert.equal(commits.length, 2, "登录只允许两次整组提交：会话组 + 账号组");
  const sessionCommit = commits[0]!;
  const accountCommit = commits[1]!;
  assert.deepEqual(
    Object.keys(sessionCommit.expected).sort(),
    [...SESSION_KEYS].sort(),
    "会话提交必须比较整组会话键（只比较自己要写的键挡不住反向覆盖）",
  );
  assert.equal(sessionCommit.expected[KEYS.sessionRevision], null);
  assert.equal(sessionCommit.changes[KEYS.activeProvider], "bigmodel");
  assert.equal(sessionCommit.changes[KEYS.zcodeJwtToken], "bigmodel-jwt");
  assert.equal(sessionCommit.changes[KEYS.bigmodelAccessToken], "bigmodel-access");
  assert.equal(sessionCommit.changes[KEYS.bigmodelRefreshToken], "bigmodel-refresh");
  const rotatedRevision = sessionCommit.changes[KEYS.sessionRevision];
  assert.equal(typeof rotatedRevision, "string", "成功提交必须轮换会话版本键");
  assert.match(String(rotatedRevision), /^[0-9a-f-]{36}$/u, "版本值必须是随机 UUID，不是时间戳");
  assert.equal(Object.hasOwn(sessionCommit.changes, ATTRIBUTION_KEY), false);
  assert.equal(Object.hasOwn(sessionCommit.expected, ATTRIBUTION_KEY), false);

  const providerId = "account:bigmodel-individual-coding-plan";
  const identityKey = standaloneAccountIdentityCredentialKey(providerId);
  const apiKeyKey = standaloneAccountProviderCredentialKey({
    accountIdentity: BIGMODEL_USER.user_id,
    providerId,
  });
  assert.deepEqual(Object.keys(accountCommit.changes).sort(), [identityKey, apiKeyKey].sort());
  assert.equal(
    Object.hasOwn(accountCommit.changes, KEYS.sessionRevision),
    false,
    "账号组不是会话本体，不轮换版本键",
  );
  assert.equal(
    accountCommit.expected[KEYS.sessionRevision],
    rotatedRevision,
    "账号组按会话组刚提交的版本做前置校验，挡住期间的换号登录",
  );

  assert.equal(harness.notifications.length, 2, "两次成功提交各发一次通知，不重复");
  const stored = await store.loadMany([...SESSION_KEYS, ATTRIBUTION_KEY, identityKey, apiKeyKey]);
  assert.equal(stored[KEYS.activeProvider], "bigmodel");
  assert.equal(stored[KEYS.sessionRevision], rotatedRevision);
  assert.equal(stored[identityKey], BIGMODEL_USER.user_id);
  assert.equal(stored[apiKeyKey], "resolved-api-key");
  assert.equal(stored[ATTRIBUTION_KEY], '{"channel_id":"cli"}', "归因键不参与登录 CAS，也不被清掉");
});

test("陈旧快照提交：返回 false、磁盘字节不变、不发通知", async () => {
  const harness = await createHarness();
  const store = harness.createStore();
  await store.saveMany({ [KEYS.bigmodelAccessToken]: "seeded-token" });
  const staleSnapshot = await captureLoginSessionSnapshot(store);
  const freshSnapshot = await captureLoginSessionSnapshot(store);
  assert.deepEqual(staleSnapshot, freshSnapshot, "两次读取之间没有写入时快照相同");
  assert.equal(
    await commitLoginSessionChange(store, freshSnapshot, createSessionChange("zai", "interloper")),
    true,
  );

  harness.notifications.length = 0;
  const before = await readFile(harness.filePath);
  assert.equal(
    await commitLoginSessionChange(store, staleSnapshot, createSessionChange("bigmodel", "late")),
    false,
    "CAS 失败必须返回 false（正常竞态），而不是抛错",
  );
  assert.deepEqual(await readFile(harness.filePath), before, "CAS 失败不得写盘");
  assert.equal(harness.notifications.length, 0, "CAS 失败不得发变更通知");
  const stored = await store.loadMany(SESSION_KEYS);
  assert.equal(stored[KEYS.zaiAccessToken], "interloper-access");
  assert.equal(stored[KEYS.activeProvider], "zai", "迟到响应不得把 active provider 改回去");
  // 会话组是按字段合并的：竞争者只写 zai，不会删掉既有 bigmodel 值；关键是被丢弃的提交
  // 不能把 "late-access" 写进来。
  assert.equal(stored[KEYS.bigmodelAccessToken], "seeded-token", "迟到响应不得覆盖既有会话字段");
});

test("账号组提交：期间换号则整体作废，成功时不轮换会话版本", async () => {
  const harness = await createHarness();
  const store = harness.createStore();
  const keys = {
    apiKeyCredentialKey: "account-provider:coding-plan:test:account:old:api-key",
    identityCredentialKey: "account-provider:test:identity",
  };
  const staleSnapshot = await captureStandaloneAccountSnapshot(store, keys);
  await commitLoginSessionChange(
    store,
    await captureLoginSessionSnapshot(store),
    createSessionChange("zai", "host-login"),
  );

  assert.equal(
    await commitStandaloneAccountCredentials(store, staleSnapshot, {
      ...keys,
      accountIdentity: "old",
      apiKey: "late-api-key",
    }),
    false,
    "期间发生的登录（版本键轮换）必须让账号组提交整体作废",
  );
  assert.equal(await store.load(keys.identityCredentialKey), null, "作废的账号组不得写盘");

  const revisionBefore = await store.load(KEYS.sessionRevision);
  assert.equal(
    await commitStandaloneAccountCredentials(
      store,
      await captureStandaloneAccountSnapshot(store, keys),
      { ...keys, accountIdentity: "old", apiKey: "fresh-api-key" },
    ),
    true,
  );
  assert.equal(await store.load(keys.identityCredentialKey), "old");
  assert.equal(await store.load(keys.apiKeyCredentialKey), "fresh-api-key");
  assert.equal(
    await store.load(KEYS.sessionRevision),
    revisionBefore,
    "账号组提交不轮换会话版本（否则会让 Host 的刷新事务无谓失败）",
  );
});

test("zai 登录同样走整组 CAS，落盘字段集合固定（不含 refresh token）", async () => {
  const harness = await createHarness();
  const store = harness.createStore();
  const result = await loginZCodeCli(
    loginOptions(harness, {
      credentialStore: store,
      httpClient: createOAuthHttpClient({
        accessToken: "zai-access",
        providerId: "zai",
        refreshToken: "zai-refresh",
        token: "zai-jwt",
        user: ZAI_USER,
      }),
      providerId: "zai",
    }),
  );
  assert.equal(result.providerId, "zai");
  const stored = await store.loadMany(SESSION_KEYS);
  assert.equal(stored[KEYS.activeProvider], "zai");
  assert.equal(stored[KEYS.zaiAccessToken], "zai-access");
  assert.equal(stored[KEYS.zcodeJwtToken], "zai-jwt");
  assert.equal(
    stored[KEYS.zaiUserInfo],
    JSON.stringify(ZAI_USER),
    "zai user_info 保持后端原样形态",
  );
  assert.equal(
    stored[KEYS.zaiRefreshToken],
    null,
    "zai 授权响应不带 refresh token，登录不写这个键",
  );
  assert.equal(typeof stored[KEYS.sessionRevision], "string");
});

test("会话键解不开时按损坏恢复：只清会话命名空间，登录仍可继续", async () => {
  const harness = await createHarness();
  const store = harness.createStore();
  await store.saveMany({ [KEYS.zaiAccessToken]: "legacy-token", [NON_SESSION_KEY]: "keep-me" });
  await damageStoredValue(harness.filePath, KEYS.zaiAccessToken);
  await assert.rejects(
    () => store.loadMany([KEYS.zaiAccessToken]),
    (error: unknown) => {
      // 断言稳定错误码而不是提示文案：损坏恢复的触发条件就是「密文解不开」。
      assert.equal(
        (error as { code?: string }).code,
        CREDENTIAL_DECRYPT_ERROR_CODE,
        "篡改后的密文必须被判定为解密失败",
      );
      return true;
    },
  );

  const result = await loginZCodeCli(
    loginOptions(harness, {
      credentialStore: store,
      httpClient: createOAuthHttpClient({
        accessToken: "fresh-access",
        providerId: "zai",
        token: "fresh-jwt",
        user: ZAI_USER,
      }),
      providerId: "zai",
    }),
  );
  assert.equal(result.providerId, "zai", "损坏恢复后登录必须照常成功，而不是卡在解不开的旧会话上");
  const stored = await store.loadMany([KEYS.zaiAccessToken, KEYS.sessionRevision, NON_SESSION_KEY]);
  assert.equal(stored[KEYS.zaiAccessToken], "fresh-access");
  assert.equal(typeof stored[KEYS.sessionRevision], "string");
  assert.equal(stored[NON_SESSION_KEY], "keep-me", "损坏恢复只清会话键，其他凭据不受影响");
});

test("账号组键解不开时按损坏恢复：删掉坏键后用本次登录值继续", async () => {
  const harness = await createHarness();
  const store = harness.createStore();
  const providerId = "account:bigmodel-individual-coding-plan";
  const identityKey = standaloneAccountIdentityCredentialKey(providerId);
  const apiKeyKey = standaloneAccountProviderCredentialKey({
    accountIdentity: BIGMODEL_USER.user_id,
    providerId,
  });
  // 组内留一份旧凭据再把 api-key 密文改坏：账号组快照读取会撞上解不开的值。
  await store.saveMany({ [identityKey]: "stale-identity", [apiKeyKey]: "stale-api-key" });
  await damageStoredValue(harness.filePath, apiKeyKey);
  await assert.rejects(
    () => store.loadMany([apiKeyKey]),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, CREDENTIAL_DECRYPT_ERROR_CODE);
      return true;
    },
  );

  const healed: string[][] = [];
  const recordingStore: SharedZCodeCredentialStore = {
    ...store,
    async deleteUnreadable(keysToHeal, options) {
      healed.push([...keysToHeal]);
      return await store.deleteUnreadable(keysToHeal, options);
    },
  };

  const result = await loginZCodeCli(
    loginOptions(harness, {
      credentialStore: recordingStore,
      httpClient: createOAuthHttpClient({
        accessToken: "bigmodel-access",
        providerId: "bigmodel",
        refreshToken: "bigmodel-refresh",
        token: "bigmodel-jwt",
        user: BIGMODEL_USER,
      }),
      providerId: "bigmodel",
    }),
  );
  assert.equal(result.providerId, "bigmodel", "账号组自愈后登录照常完成，而不是报配置写入失败");
  assert.deepEqual(healed, [[apiKeyKey]], "只清理仍解不开的键：可读的 identity 与版本键留给 CAS");
  const stored = await store.loadMany([identityKey, apiKeyKey, KEYS.sessionRevision]);
  assert.equal(stored[identityKey], BIGMODEL_USER.user_id, "可读的 identity 按本次登录覆盖");
  assert.equal(stored[apiKeyKey], "resolved-api-key", "坏掉的 api-key 被本次登录值替换");
  assert.equal(typeof stored[KEYS.sessionRevision], "string", "会话版本键不受账号组恢复影响");
});

test("账号组自愈仍失败：抛可诊断错误，且不把存储不可用当成可删密文", async () => {
  const keys = {
    apiKeyCredentialKey: "account-provider:test:api-key",
    identityCredentialKey: "account-provider:test:identity",
  };
  const decryptFailure = () =>
    Object.assign(new Error("Invalid encrypted credential"), {
      code: CREDENTIAL_DECRYPT_ERROR_CODE,
    });
  const healedKeys: string[][] = [];
  const stubborn: Pick<SharedZCodeCredentialStore, "deleteUnreadable" | "load" | "loadMany"> = {
    async loadMany() {
      throw decryptFailure();
    },
    async load() {
      throw decryptFailure();
    },
    async deleteUnreadable(keysToHeal) {
      healedKeys.push([...keysToHeal]);
      return false;
    },
  };

  await assert.rejects(
    () => captureStandaloneAccountSnapshot(stubborn, keys),
    (error: unknown) => {
      assert.ok(
        error instanceof ZCodeCliLoginError,
        `期望可诊断的登录错误，实际：${String(error)}`,
      );
      assert.equal(error.code, "credential_unreadable");
      assert.equal(
        (error.cause as { code?: string }).code,
        CREDENTIAL_DECRYPT_ERROR_CODE,
        "保留底层解密失败作为 cause，避免丢失根因",
      );
      return true;
    },
  );
  assert.equal(healedKeys.length, 1, "放弃前必须先尝试一次锁内清理");
  assert.deepEqual(
    healedKeys[0],
    [keys.identityCredentialKey, keys.apiKeyCredentialKey, KEYS.sessionRevision],
    "逐个复检后把解不开的键交给 store 复确认",
  );

  // 存储不可用不是「密文坏了」：不得复检、不得删键，原错误码原样上抛。
  let fallbackHeals = 0;
  let fallbackProbes = 0;
  const unusable: Pick<SharedZCodeCredentialStore, "deleteUnreadable" | "load" | "loadMany"> = {
    async loadMany() {
      throw Object.assign(new Error("System credential storage is unavailable"), {
        code: CREDENTIAL_SECURE_STORAGE_UNAVAILABLE_CODE,
      });
    },
    async load() {
      fallbackProbes += 1;
      throw new Error("storage unavailable 时不应逐键复检");
    },
    async deleteUnreadable() {
      fallbackHeals += 1;
      return false;
    },
  };
  await assert.rejects(
    () => captureStandaloneAccountSnapshot(unusable, keys),
    (error: { code?: string }) => error.code === CREDENTIAL_SECURE_STORAGE_UNAVAILABLE_CODE,
  );
  assert.equal(fallbackHeals, 0, "存储不可用时不得尝试清理");
  assert.equal(fallbackProbes, 0, "存储不可用时不得逐键复检（复检会再次撞上同一错误）");
});
