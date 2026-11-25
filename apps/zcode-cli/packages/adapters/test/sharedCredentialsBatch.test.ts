import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import {
  createSystemCredentialCipher,
  type CredentialCipher,
  type CredentialKeyStore,
} from "@zcode/shared/credential-security";
import {
  createSharedZCodeCredentialStore,
  SHARED_ZCODE_CREDENTIAL_KEYS,
  type SharedZCodeCredentialStore,
} from "../src/auth/shared-credentials.js";

/**
 * CLI 侧批量凭据契约（SPEC §7.1/§7.3/§7.6）的对齐断言。
 *
 * CLI store 与 Host 服务共用同一份 credentials.json，也共用共享层的批量实现：
 * 整组 CAS 失败必须返回 false 且不写盘、一次成功提交只发一次变更通知、
 * 会话版本键必须与 Host 侧同名 —— 两侧一旦分叉，跨进程登录竞态就失去了统一代次。
 * 解不开的密文只能在锁内复检仍损坏时清掉（deleteUnreadable / recoverUnreadable），
 * 否则另一进程刚修好的值会被误删。
 */

const temporaryDirs: string[] = [];

after(async () => {
  await Promise.all(temporaryDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Harness {
  readonly store: SharedZCodeCredentialStore;
  readonly filePath: string;
  readonly cipher: CredentialCipher;
  /** 每次 onDidChange 记一次，用来断言「一次提交只发一次通知」。 */
  readonly notifications: number[];
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
  const dir = await mkdtemp(join(tmpdir(), "zcode-cli-credential-batch-"));
  temporaryDirs.push(dir);
  const filePath = join(dir, "credentials.json");
  const cipher = createSystemCredentialCipher({
    filePath,
    env: {},
    keyStore: createFakeKeyStore(),
  });
  const notifications: number[] = [];
  const store = createSharedZCodeCredentialStore({ filePath, cipher });
  store.onDidChange(() => {
    notifications.push(1);
  });
  return { store, filePath, cipher, notifications };
}

const SESSION_REVISION_KEY = SHARED_ZCODE_CREDENTIAL_KEYS.sessionRevision;

test("sessionRevision 与 Host 侧同名：登出清理覆盖它", () => {
  assert.equal(SESSION_REVISION_KEY, "oauth:session_revision");
  assert.ok(
    Object.values(SHARED_ZCODE_CREDENTIAL_KEYS).includes(SESSION_REVISION_KEY),
    "登出按 Object.values(SHARED_ZCODE_CREDENTIAL_KEYS) 清理，版本键必须在同一张表里",
  );
});

test("updateMany：整组 CAS 成功才写，stale 快照返回 false 且磁盘字节不变", async () => {
  const harness = await createHarness();
  const { store } = harness;
  await store.saveMany({ k1: "v1", k2: "v2" });
  harness.notifications.length = 0;

  const before = await readFile(harness.filePath);
  assert.equal(
    await store.updateMany({ k1: "stale" }, { expected: { k1: "v1", k2: "old" } }),
    false,
    "期望值不符时必须返回 false（不是抛错）",
  );
  assert.deepEqual(await readFile(harness.filePath), before, "CAS 失败不得写盘");
  assert.equal(harness.notifications.length, 0, "CAS 失败不得发通知");

  const snapshot = await store.loadMany(["k1", "k2", "k3"]);
  assert.equal(
    await store.updateMany({ k1: "n1", k2: null, k3: "n3" }, { expected: snapshot }),
    true,
  );
  assert.deepEqual(await store.loadMany(["k1", "k2", "k3"]), {
    k1: "n1",
    k2: null,
    k3: "n3",
  });
  assert.equal(harness.notifications.length, 1, "一次成功提交只发一次通知");
});

test("updateMany：两个 store 实例并发提交同一份快照，只有一个生效且版本键轮换", async () => {
  const harness = await createHarness();
  const other = createSharedZCodeCredentialStore({
    filePath: harness.filePath,
    cipher: harness.cipher,
  });
  const keys = ["oauth:zai:access_token", SESSION_REVISION_KEY];
  const snapshotA = await harness.store.loadMany(keys);
  const snapshotB = await other.loadMany(keys);
  assert.deepEqual(snapshotA, snapshotB, "两个实例读到同一份会话前状态");

  const results = await Promise.all([
    harness.store.updateMany(
      { "oauth:zai:access_token": "token-winner", [SESSION_REVISION_KEY]: randomUUID() },
      { expected: snapshotA },
    ),
    other.updateMany(
      { "oauth:zai:access_token": "token-loser", [SESSION_REVISION_KEY]: randomUUID() },
      { expected: snapshotB },
    ),
  ]);

  assert.equal(results.filter(Boolean).length, 1, "跨进程并发登录只能有一个赢家");
  const stored = await harness.store.loadMany(keys);
  assert.equal(
    stored["oauth:zai:access_token"],
    results[0] ? "token-winner" : "token-loser",
    "落盘的是赢家的 token",
  );
  assert.equal(typeof stored[SESSION_REVISION_KEY], "string", "版本键必须落成新值");
  assert.notEqual(stored[SESSION_REVISION_KEY], null);
});

test("updateMany：assertCurrent 在锁内执行，抛错时不写盘", async () => {
  const harness = await createHarness();
  await harness.store.saveMany({ k: "v" });
  const snapshot = await harness.store.loadMany(["k"]);
  harness.notifications.length = 0;

  await assert.rejects(
    () =>
      harness.store.updateMany(
        { k: "next" },
        {
          expected: snapshot,
          assertCurrent: () => {
            throw new Error("调用方前提已失效");
          },
        },
      ),
    /前提已失效/,
  );
  assert.equal(await harness.store.load("k"), "v", "锁内复核失败不得写盘");
  assert.equal(harness.notifications.length, 0);
});

/** 解密失败的判据：与「存储不可用」区分，只有它才代表密文本身坏了。 */
function isDecryptFailure(error: { code?: string }): boolean {
  return error.code === "ZCODE_CREDENTIAL_DECRYPT_FAILED";
}

/** 保留来源与密钥指纹、替换载荷：模拟「密钥还在但密文损坏」，与「换了密钥」区分。 */
function damagePayload(ciphertext: string): string {
  const parts = ciphertext.split(":");
  return [...parts.slice(0, -1), Buffer.from("damaged").toString("base64url")].join(":");
}

/** 直接改坏磁盘上的值（模拟另一进程写入的损坏密文），不经 store 的写闸门。 */
async function damageStoredValue(filePath: string, key: string): Promise<void> {
  const record = JSON.parse(await readFile(filePath, "utf8")) as Record<string, string>;
  const current = record[key];
  if (current === undefined) throw new Error(`credential key missing: ${key}`);
  record[key] = damagePayload(current);
  await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

test("deleteUnreadable：坏密文 ⇒ 删掉后读取继续，可读键不动且只发一次通知", async () => {
  const harness = await createHarness();
  await harness.store.saveMany({ broken: "b", good: "g" });
  await damageStoredValue(harness.filePath, "broken");
  harness.notifications.length = 0;

  // 调用方先看到解不开的密文（账号连接组原先就卡在这里），据此发起清理。
  await assert.rejects(() => harness.store.loadMany(["broken"]), isDecryptFailure);

  assert.equal(await harness.store.deleteUnreadable(["good"]), false, "可读键不清理");
  assert.equal(harness.notifications.length, 0, "未提交不得发通知");

  assert.equal(await harness.store.deleteUnreadable(["broken"]), true);
  assert.deepEqual(await harness.store.loadMany(["broken", "good"]), { broken: null, good: "g" });
  assert.equal(harness.notifications.length, 1, "一次提交只发一次通知");
});

test("deleteUnreadable：锁内已被修复 ⇒ 返回 false 不删，期望值不匹配同样不删", async () => {
  const harness = await createHarness();
  await harness.store.saveMany({ broken: "b", good: "g" });
  await damageStoredValue(harness.filePath, "broken");

  assert.equal(
    await harness.store.deleteUnreadable(["broken"], { expected: { good: "other" } }),
    false,
    "期望值不匹配 ⇒ 不提交",
  );

  // 另一实例把这个键修好了：锁内复检看到可读值，不再按「不可读」删除。
  const other = createSharedZCodeCredentialStore({
    filePath: harness.filePath,
    cipher: harness.cipher,
  });
  await other.save("broken", "fixed");
  harness.notifications.length = 0;
  const before = await readFile(harness.filePath);

  assert.equal(await harness.store.deleteUnreadable(["broken"]), false, "已被修复 ⇒ 不删");
  assert.deepEqual(await readFile(harness.filePath), before, "未提交不得写盘");
  assert.equal(harness.notifications.length, 0, "未提交不得发通知");
  assert.equal(await harness.store.load("broken"), "fixed");
});

test("deleteUnreadable：removeKeys 与 replacements 同一次提交，通知只发一次", async () => {
  const harness = await createHarness();
  await harness.store.saveMany({ broken: "b", derived: "d", keep: "k" });
  await damageStoredValue(harness.filePath, "broken");
  harness.notifications.length = 0;

  assert.equal(
    await harness.store.deleteUnreadable(["broken"], {
      removeKeys: ["broken", "derived"],
      replacements: { revision: "r1" },
    }),
    true,
  );
  assert.deepEqual(await harness.store.loadMany(["broken", "derived", "revision", "keep"]), {
    broken: null,
    derived: null,
    revision: "r1",
    keep: "k",
  });
  assert.equal(harness.notifications.length, 1, "多键提交仍只发一次通知");
});

test("recoverUnreadable：可读返回原值不动盘；坏密文删键并通知一次；锁内复核抛错不写盘", async () => {
  const harness = await createHarness();
  await harness.store.saveMany({ good: "g", broken: "b" });
  await damageStoredValue(harness.filePath, "broken");
  harness.notifications.length = 0;

  const before = await readFile(harness.filePath);
  assert.equal(await harness.store.recoverUnreadable("good", () => undefined), "g");
  assert.deepEqual(await readFile(harness.filePath), before, "可读键不得改写磁盘");
  assert.equal(harness.notifications.length, 0, "可读键不是恢复事件");
  assert.equal(await harness.store.recoverUnreadable("missing", () => undefined), null);

  // 删除不可读键之前必须再复核一次：调用方前提失效时不得删。
  let checks = 0;
  await assert.rejects(
    () =>
      harness.store.recoverUnreadable("broken", () => {
        checks += 1;
        if (checks > 1) throw new Error("会话版本已变");
      }),
    /会话版本已变/,
  );
  assert.equal(checks, 2, "删除前必须再复核一次");
  assert.equal(harness.notifications.length, 0, "复核失败不得发通知");
  await assert.rejects(() => harness.store.loadMany(["broken"]), isDecryptFailure);

  assert.equal(await harness.store.recoverUnreadable("broken", () => undefined), null);
  assert.deepEqual(await harness.store.loadMany(["broken", "good"]), { broken: null, good: "g" });
  assert.equal(harness.notifications.length, 1, "恢复事件只发一次");
});
