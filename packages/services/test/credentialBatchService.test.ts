import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import {
  advanceCredentialGeneration,
  createSystemCredentialCipher,
  type CredentialKeyStore,
} from "@zcode/shared/credential-security";
import { createCredentialService } from "../src/credential/credentialService.js";
import {
  OAUTH_SESSION_REVISION_KEY,
  type CredentialMutationEvent,
} from "../src/credential/credential.js";
import {
  credentialMutationTouchesAccountSurface,
  isAccountSurfaceCredentialKey,
} from "../src/credential/credentialMutation.js";
import {
  commitCredentialSessionChange,
  createCredentialSessionRevision,
} from "../src/credential/credentialSessionRevision.js";
import { getCredentialsFilePath, setDataBaseDir } from "../src/paths.js";

/**
 * Host 私有批量凭据契约的验收断言（SPEC §7.1/§7.2/§7.3/§7.4/§7.6）。
 *
 * 这里钉住的是「表层必须如实转述共享层语义」：CAS 失败返回 false 而不是抛错、
 * 批量提交只发一次通知且键集合去重完整、单键操作的通知长度恒为 1、
 * oauth:session_revision 的轮换能让旧快照提交失败。
 * 用 fake KeyStore 走真 keyring 分支，避免依赖宿主系统凭据库。
 */

const temporaryDirs: string[] = [];

after(async () => {
  setDataBaseDir(null);
  await Promise.all(temporaryDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

interface FakeKeyStoreState {
  value: string | null;
  failGet: boolean;
}

function createFakeKeyStore(): { store: CredentialKeyStore; state: FakeKeyStoreState } {
  const state: FakeKeyStoreState = { value: null, failGet: false };
  const store: CredentialKeyStore = {
    async get() {
      if (state.failGet) throw Object.assign(new Error("keyring locked"), { code: "EKEYRING" });
      return state.value;
    },
    async set(value: string) {
      state.value = value;
    },
  };
  return { store, state };
}

interface Harness {
  filePath: string;
  events: CredentialMutationEvent[];
  service: ReturnType<typeof createCredentialService>;
}

/** 每个用例独立数据根：凭据路径跟随 setDataBaseDir，用例之间不共享磁盘与密钥。 */
async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "zcode-credential-batch-svc-"));
  temporaryDirs.push(root);
  setDataBaseDir(root);
  const filePath = getCredentialsFilePath();
  const fake = createFakeKeyStore();
  const cipher = createSystemCredentialCipher({ filePath, env: {}, keyStore: fake.store });
  const events: CredentialMutationEvent[] = [];
  const service = createCredentialService({
    cipher,
    onDidMutate: (event) => {
      events.push(event);
    },
  });
  return { filePath, events, service };
}

async function readRecord(filePath: string): Promise<Record<string, string>> {
  return JSON.parse(await readFile(filePath, "utf8")) as Record<string, string>;
}

/** 保留来源与密钥指纹、破坏载荷：模拟「密钥还在但密文损坏」。 */
function damagePayload(ciphertext: string): string {
  const [prefix, source, fingerprint] = ciphertext.split(":");
  return `${prefix}:${source}:${fingerprint}:${Buffer.from("damaged").toString("base64url")}`;
}

test("loadMany：缺失与空值可区分，空键被拒绝，磁盘只落密文", async () => {
  const { filePath, service } = await createHarness();
  await service.updateMany({ empty: "", value: "plain-secret" });

  assert.deepEqual(await service.loadMany(["empty", "value", "missing"]), {
    empty: "",
    value: "plain-secret",
    missing: null,
  });
  await assert.rejects(() => service.loadMany([""]), "空键必须被 schema 拒绝");
  const raw = await readFile(filePath, "utf8");
  assert.ok(!raw.includes("plain-secret"), "容器不得含明文");
  assert.ok(
    Object.values(await readRecord(filePath)).every((value) => value.startsWith("enc:v2:os:")),
    "keyring 可用时必须写系统库密文",
  );
});

test("updateMany：整组 CAS 成功才写，stale 快照返回 false 且磁盘字节不变", async () => {
  const { filePath, events, service } = await createHarness();
  await service.updateMany({ k1: "v1", k2: "v2" });
  events.length = 0;
  const snapshot = await service.loadMany(["k1", "k2", "k3"]);
  const before = await readFile(filePath);

  assert.equal(
    await service.updateMany({ k1: "stale" }, { expected: { k1: "v1", k2: "old" } }),
    false,
  );
  assert.deepEqual(await readFile(filePath), before, "CAS 失败不得写盘");
  assert.equal(events.length, 0, "CAS 失败不得发通知");

  assert.equal(
    await service.updateMany({ k1: "n1", k2: null, k3: "n3" }, { expected: snapshot }),
    true,
  );
  assert.deepEqual(await service.loadMany(["k1", "k2", "k3"]), { k1: "n1", k2: null, k3: "n3" });
  assert.deepEqual(events, [{ operation: "batch", keys: ["k1", "k2", "k3"] }]);
});

test("updateMany：一次提交多个键只发一个 batch 通知，键集合完整", async () => {
  const { events, service } = await createHarness();
  assert.equal(await service.updateMany({ a: "1", b: "2", c: "3" }), true);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.operation, "batch");
  assert.deepEqual([...(events[0]?.keys ?? [])].sort(), ["a", "b", "c"]);
});

test("updateMany：并发 3 个不同键的提交不丢更新，且各发一次单键 batch 通知", async () => {
  const { events, service } = await createHarness();
  const results = await Promise.all(
    ["a", "b", "c"].map((key) => service.updateMany({ [key]: `v-${key}` })),
  );
  assert.deepEqual(results, [true, true, true]);
  assert.deepEqual(await service.loadMany(["a", "b", "c"]), { a: "v-a", b: "v-b", c: "v-c" });
  assert.equal(events.length, 3);
  for (const event of events) {
    assert.equal(event.operation, "batch");
    assert.equal(event.keys.length, 1);
  }
});

test("save/delete：单键操作的通知长度恒为 1，且键就是操作的键", async () => {
  const { events, service } = await createHarness();
  await service.save("oauth:zai:access_token", "token");
  await service.delete("oauth:zai:access_token");
  assert.deepEqual(events, [
    { operation: "save", keys: ["oauth:zai:access_token"] },
    { operation: "delete", keys: ["oauth:zai:access_token"] },
  ]);
  assert.equal(await service.load("oauth:zai:access_token"), null);
});

test("saveIfAbsent：并发收敛到先写入者，只有真正写入才发 save 通知", async () => {
  const { events, service } = await createHarness();
  const values = await Promise.all([
    service.saveIfAbsent("feedback:token", "first"),
    service.saveIfAbsent("feedback:token", "second"),
    service.saveIfAbsent("feedback:token", "third"),
  ]);
  assert.deepEqual(values, ["first", "first", "first"]);
  assert.equal(await service.load("feedback:token"), "first");
  assert.deepEqual(events, [{ operation: "save", keys: ["feedback:token"] }]);
});

test("deleteIfEquals：只删仍相等的值，不删时既不动盘也不发通知", async () => {
  const { filePath, events, service } = await createHarness();
  await service.save("feedback:token", "current");
  events.length = 0;
  const before = await readFile(filePath);

  await service.deleteIfEquals("feedback:token", "stale");
  await service.deleteIfEquals("missing", "x");
  assert.deepEqual(await readFile(filePath), before);
  assert.equal(events.length, 0);

  await service.deleteIfEquals("feedback:token", "current");
  assert.equal(await service.load("feedback:token"), null);
  assert.deepEqual(events, [{ operation: "delete", keys: ["feedback:token"] }]);
});

test("deleteUnreadable：清理损坏键与同组键，一次 batch 通知且键去重完整", async () => {
  const { filePath, events, service } = await createHarness();
  await service.updateMany({ broken: "x", mirror: "m", good: "g" });
  const record = await readRecord(filePath);
  await writeFile(
    filePath,
    `${JSON.stringify({ ...record, broken: damagePayload(record.broken!) }, null, 2)}\n`,
  );
  events.length = 0;

  await assert.rejects(
    () => service.loadMany(["broken"]),
    (error: { code?: string }) => error.code === "ZCODE_CREDENTIAL_DECRYPT_FAILED",
  );
  assert.equal(await service.deleteUnreadable(["good"]), false, "可读键不清理");
  assert.equal(events.length, 0);

  assert.equal(
    await service.deleteUnreadable(["broken"], {
      removeKeys: ["broken", "mirror", "broken"],
      replacements: { [OAUTH_SESSION_REVISION_KEY]: "revision-1" },
    }),
    true,
  );
  assert.equal(events.length, 1, "一次提交只发一次通知");
  assert.equal(events[0]?.operation, "batch");
  assert.deepEqual(events[0]?.keys, ["broken", "mirror", OAUTH_SESSION_REVISION_KEY]);
  assert.equal(new Set(events[0]?.keys).size, events[0]?.keys.length, "通知键必须去重");
  assert.deepEqual(
    await service.loadMany(["broken", "mirror", "good", OAUTH_SESSION_REVISION_KEY]),
    {
      broken: null,
      mirror: null,
      good: "g",
      [OAUTH_SESSION_REVISION_KEY]: "revision-1",
    },
  );
});

test("recoverUnreadable：损坏键发 recover 通知，可读键不发", async () => {
  const { filePath, events, service } = await createHarness();
  await service.updateMany({ broken: "x", good: "g" });
  const record = await readRecord(filePath);
  await writeFile(
    filePath,
    `${JSON.stringify({ ...record, broken: damagePayload(record.broken!) }, null, 2)}\n`,
  );
  events.length = 0;

  assert.equal(await service.recoverUnreadable("good", () => undefined), "g");
  assert.equal(events.length, 0, "可读键不得发恢复通知");

  assert.equal(await service.recoverUnreadable("broken", () => undefined), null);
  assert.deepEqual(events, [{ operation: "recover", keys: ["broken"] }]);
  assert.equal(await service.loadMany(["broken"]).then((values) => values.broken), null);

  // assertCurrent 抛错即放弃：不可读键留在盘上，等下一次恢复。
  await service.updateMany({ other: "o" });
  const second = await readRecord(filePath);
  await writeFile(
    filePath,
    `${JSON.stringify({ ...second, other: damagePayload(second.other!) }, null, 2)}\n`,
  );
  events.length = 0;
  await assert.rejects(
    () =>
      service.recoverUnreadable("other", () => {
        throw new Error("superseded");
      }),
    /superseded/,
  );
  assert.equal(events.length, 0);
});

test("captureRecoveryGuard：事务期间代次推进 ⇒ STORE_CHANGED，重试成功", async () => {
  const { filePath, service } = await createHarness();
  const guard = await service.captureRecoveryGuard();
  await assert.rejects(
    () =>
      guard(async () => {
        await advanceCredentialGeneration(filePath);
      }),
    (error: { code?: string }) => error.code === "ZCODE_CREDENTIAL_STORE_CHANGED",
  );

  // 作用域内写入口沿用的仍是事务起始代次：恢复之后立刻提交旧结果会被拒一次。
  const retry = await service.captureRecoveryGuard();
  await assert.rejects(
    () =>
      retry(async () => {
        await service.updateMany({ k: "v" });
        await advanceCredentialGeneration(filePath);
        await service.updateMany({ k: "w" });
      }),
    (error: { code?: string }) => error.code === "ZCODE_CREDENTIAL_STORE_CHANGED",
  );
  assert.equal(await service.load("k"), "v");
  assert.equal(await service.updateMany({ k: "after" }), true);
});

test("oauth:session_revision：提交时轮换，旧快照提交失败且不覆盖新登录", async () => {
  const keys = ["oauth:zai:access_token", OAUTH_SESSION_REVISION_KEY];
  const { service } = await createHarness();
  const first = await service.loadMany(keys);
  assert.deepEqual(first, { "oauth:zai:access_token": null, "oauth:session_revision": null });

  assert.equal(
    await commitCredentialSessionChange(service, first, { "oauth:zai:access_token": "token-A" }),
    true,
  );
  const afterA = await service.loadMany(keys);
  assert.equal(afterA["oauth:zai:access_token"], "token-A");
  assert.match(
    afterA["oauth:session_revision"] ?? "",
    /^[0-9a-f-]{36}$/,
    "版本值必须是新生成的 UUID",
  );

  // 另一进程手里还是登录前的快照：提交必须失败，且不覆盖已完成的登录。
  assert.equal(
    await commitCredentialSessionChange(service, first, { "oauth:zai:access_token": "token-B" }),
    false,
  );
  assert.equal((await service.loadMany(keys))["oauth:zai:access_token"], "token-A");
});

test("oauth:session_revision：两个并发登录只有一个提交成功", async () => {
  const keys = ["oauth:zai:access_token", OAUTH_SESSION_REVISION_KEY];
  const { service } = await createHarness();
  const snapshot = await service.loadMany(keys);

  const results = await Promise.all([
    commitCredentialSessionChange(service, snapshot, { "oauth:zai:access_token": "winner" }),
    commitCredentialSessionChange(service, snapshot, { "oauth:zai:access_token": "loser" }),
  ]);
  assert.equal(results.filter(Boolean).length, 1, "跨进程并发登录只能有一个赢家");
  assert.equal((await service.loadMany(keys))["oauth:zai:access_token"], "winner");
  assert.notEqual(createCredentialSessionRevision(), createCredentialSessionRevision());
});

test("账号面判定：任一敏感键在集合里都必须触发失效（批量不漏判）", () => {
  assert.equal(OAUTH_SESSION_REVISION_KEY, "oauth:session_revision");
  for (const key of ["oauth:active_provider", "oauth:zai:user_info", "oauth:bigmodel:user_info"]) {
    assert.equal(isAccountSurfaceCredentialKey(key), true, `${key} 必须算账号面`);
    assert.equal(
      credentialMutationTouchesAccountSurface({ operation: "batch", keys: ["unrelated", key] }),
      true,
      `批量提交里含 ${key} 不得漏判`,
    );
  }
  for (const key of [
    "oauth:zai:access_token",
    "zcodejwttoken",
    "oauth::user_info",
    "oauth:a:b:user_info",
  ]) {
    assert.equal(isAccountSurfaceCredentialKey(key), false, `${key} 不应算账号面`);
  }
  assert.equal(credentialMutationTouchesAccountSurface({ operation: "batch", keys: [] }), false);
  assert.equal(
    credentialMutationTouchesAccountSurface({
      operation: "recover",
      keys: ["oauth:zai:user_info"],
    }),
    true,
  );
});
