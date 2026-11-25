import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import {
  CREDENTIAL_SOURCE_FILE,
  CREDENTIAL_SECURE_STORAGE_UNAVAILABLE_CODE,
  CREDENTIAL_STORE_CHANGED_CODE,
  advanceCredentialGeneration,
  captureCredentialGuard,
  captureCredentialGeneration,
  createSystemCredentialCipher,
  deleteCredentialValueIfEquals,
  deleteUnreadableCredentialValues,
  loadManyCredentialValues,
  privateSecretPath,
  recoverUnreadableCredentialValue,
  saveCredentialValueIfAbsent,
  updateCredentialValuesMany,
  withCredentialGenerationScope,
  type CredentialKeyStore,
  type CredentialRecordTarget,
} from "../src/credential-security/module.js";

/**
 * 批量凭据契约（SPEC §7）的验收断言。
 *
 * 这里钉住的是「改动理由本身」：CAS 必须整组生效、失败不写盘；并发写不得丢键；
 * 只删仍解不开/仍相等的值；缺失与空值必须可区分；代次变化必须在写盘前拦住。
 * 用 fake KeyStore 走真 keyring 分支，避免测试依赖宿主系统凭据库。
 */

const temporaryDirs: string[] = [];

after(async () => {
  await Promise.all(temporaryDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-credential-batch-"));
  temporaryDirs.push(dir);
  return join(dir, "credentials.json");
}

interface FakeKeyStoreState {
  value: string | null;
  gets: number;
  failGet: boolean;
}

/** 模拟系统凭据库；failGet 用于区分「密钥不可用」与「密文解不开」。 */
function createFakeKeyStore(initial: string | null = null): {
  store: CredentialKeyStore;
  state: FakeKeyStoreState;
} {
  const state: FakeKeyStoreState = { value: initial, gets: 0, failGet: false };
  const store: CredentialKeyStore = {
    async get() {
      state.gets += 1;
      if (state.failGet) throw Object.assign(new Error("keyring locked"), { code: "EKEYRING" });
      return state.value;
    },
    async set(value: string) {
      state.value = value;
    },
  };
  return { store, state };
}

async function readRecord(filePath: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as Record<string, string>;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return {};
    throw error;
  }
}

async function writeRecord(filePath: string, record: Record<string, string>): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

interface TargetOptions {
  filePath?: string;
  keyStore?: CredentialKeyStore;
  writes?: { count: number };
}

async function createTarget(options: TargetOptions = {}) {
  const filePath = options.filePath ?? (await createFile());
  const { store } = options.keyStore ? { store: options.keyStore } : createFakeKeyStore();
  const cipher = createSystemCredentialCipher({ filePath, env: {}, keyStore: store });
  const writes = options.writes ?? { count: 0 };
  const target: CredentialRecordTarget = {
    filePath,
    cipher,
    read: () => readRecord(filePath),
    write: async (record) => {
      writes.count += 1;
      await writeRecord(filePath, record);
    },
  };
  return { target, cipher, filePath, writes };
}

/** 用真 cipher 构造一组可直接落盘的密文。 */
async function encryptAll(
  cipher: { encrypt(value: string): string | Promise<string> },
  values: Record<string, string>,
): Promise<Record<string, string>> {
  const entries = await Promise.all(
    Object.entries(values).map(async ([key, value]) => [key, await cipher.encrypt(value)] as const),
  );
  return Object.fromEntries(entries);
}

const CORRUPT_CIPHERTEXT = "enc:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/** 保留来源与密钥指纹、破坏载荷：模拟「密钥还在但密文损坏」，与「换了密钥」区分。 */
function damagePayload(ciphertext: string): string {
  const [prefix, source, fingerprint] = ciphertext.split(":");
  return `${prefix}:${source}:${fingerprint}:${Buffer.from("damaged").toString("base64url")}`;
}

test("loadMany：缺失返回 null，空值返回空串，且不返回未请求的键", async () => {
  const { target, cipher, filePath, writes } = await createTarget();
  const record = await encryptAll(cipher, { empty: "", present: "value", unrequested: "x" });
  await writeRecord(filePath, record);

  const values = await loadManyCredentialValues(target, ["empty", "present", "missing"]);
  assert.deepEqual(values, { empty: "", present: "value", missing: null });
  // 结构上必须能区分「没有这个键」与「键存在但值为空」。
  assert.notEqual(values.empty, values.missing);
  assert.equal(writes.count, 0, "普通读取不写盘");
});

test("loadMany：读期间代次推进 ⇒ STORE_CHANGED，不返回可能已过期的结果", async () => {
  const { target, cipher, filePath } = await createTarget();
  await writeRecord(filePath, await encryptAll(cipher, { k: "v" }));

  const racing: CredentialRecordTarget = {
    ...target,
    read: async () => {
      const record = await readRecord(filePath);
      await advanceCredentialGeneration(filePath);
      return record;
    },
  };
  await assert.rejects(
    () => loadManyCredentialValues(racing, ["k"]),
    (error: { code?: string }) => error.code === CREDENTIAL_STORE_CHANGED_CODE,
  );
});

test("updateMany：整组 CAS 成功才写，stale 快照返回 false 且磁盘字节不变", async () => {
  const { target, cipher, filePath, writes } = await createTarget();
  await writeRecord(filePath, await encryptAll(cipher, { k1: "v1", k2: "v2" }));
  const snapshot = await loadManyCredentialValues(target, ["k1", "k2", "k3"]);
  assert.deepEqual(snapshot, { k1: "v1", k2: "v2", k3: null });

  const before = await readFile(filePath);
  assert.equal(writes.count, 0);
  // 旧快照以过期期望值提交：整组一个都不写。
  assert.equal(
    await updateCredentialValuesMany(
      target,
      { k1: "stale" },
      { expected: { k1: "v1", k2: "old" } },
    ),
    false,
  );
  assert.deepEqual(await readFile(filePath), before, "CAS 失败不得写盘");
  assert.equal(writes.count, 0, "CAS 失败一次写都不发");

  // 期望值匹配：整组生效（含删除与新增）。
  assert.equal(
    await updateCredentialValuesMany(
      target,
      { k1: "n1", k2: null, k3: "n3" },
      { expected: snapshot },
    ),
    true,
  );
  assert.deepEqual(await loadManyCredentialValues(target, ["k1", "k2", "k3"]), {
    k1: "n1",
    k2: null,
    k3: "n3",
  });
});

test("updateMany：expected 的 null 语义是「必须不存在」，存在即失败", async () => {
  const { target, cipher, filePath } = await createTarget();
  await writeRecord(filePath, await encryptAll(cipher, { existing: "v" }));

  assert.equal(
    await updateCredentialValuesMany(target, { other: "x" }, { expected: { existing: null } }),
    false,
    "期望缺失但实际存在 ⇒ 不写",
  );
  assert.equal(
    await updateCredentialValuesMany(target, { other: "x" }, { expected: { missing: null } }),
    true,
  );
  assert.deepEqual(await loadManyCredentialValues(target, ["other", "existing"]), {
    other: "x",
    existing: "v",
  });
});

test("updateMany：并发 3 个不同键的提交不丢更新", async () => {
  const { target, filePath } = await createTarget();
  const results = await Promise.all(
    ["a", "b", "c"].map((key) => updateCredentialValuesMany(target, { [key]: `v-${key}` })),
  );
  assert.deepEqual(results, [true, true, true]);
  assert.deepEqual(await loadManyCredentialValues(target, ["a", "b", "c"]), {
    a: "v-a",
    b: "v-b",
    c: "v-c",
  });
  assert.deepEqual(Object.keys(await readRecord(filePath)).sort(), ["a", "b", "c"]);
});

test("updateMany：assertCurrent 在锁内执行，抛错即不写盘；密文解不开期望值按不等处理", async () => {
  const { target, cipher, filePath, writes } = await createTarget();
  await writeRecord(filePath, await encryptAll(cipher, { k: "v", broken: CORRUPT_CIPHERTEXT }));

  await assert.rejects(
    () =>
      updateCredentialValuesMany(
        target,
        { k: "new" },
        {
          assertCurrent: () => {
            throw new Error("session superseded");
          },
        },
      ),
    /session superseded/,
  );
  assert.equal(writes.count, 0, "assertCurrent 抛错不得写盘");
  assert.equal(await loadManyCredentialValues(target, ["k"]).then((v) => v.k), "v");

  // 期望值是明文、当前密文解不开 ⇒ 视为不等（返回 false），不是异常。
  assert.equal(
    await updateCredentialValuesMany(target, { k: "new" }, { expected: { broken: "anything" } }),
    false,
  );
  assert.equal(writes.count, 0);
});

test("updateMany：密钥不可用 ⇒ STORAGE_UNAVAILABLE（不是 CAS 失败），磁盘不变", async () => {
  const { target: healthy, cipher, filePath } = await createTarget();
  await writeRecord(filePath, await encryptAll(cipher, { k: "v" }));

  const broken = createFakeKeyStore();
  broken.state.failGet = true;
  const failingCipher = createSystemCredentialCipher({
    filePath,
    env: {},
    keyStore: broken.store,
  });
  const failing: CredentialRecordTarget = { ...healthy, cipher: failingCipher };
  const before = await readFile(filePath);

  await assert.rejects(
    () => updateCredentialValuesMany(failing, { k: "new" }, { expected: { k: "v" } }),
    (error: { code?: string; diagnostic?: { stage?: string } }) =>
      error.code === CREDENTIAL_SECURE_STORAGE_UNAVAILABLE_CODE &&
      error.diagnostic?.stage === "read",
  );
  assert.deepEqual(await readFile(filePath), before);
});

test("deleteUnreadable：只删锁内仍解不开的键，可读时返回 null 且不写盘", async () => {
  const { target, cipher, filePath, writes } = await createTarget();
  await writeRecord(
    filePath,
    Object.assign(await encryptAll(cipher, { good: "g", mirror: "m" }), {
      broken: CORRUPT_CIPHERTEXT,
    }),
  );

  assert.equal(await deleteUnreadableCredentialValues(target, ["good"]), null, "可读 ⇒ 不删");
  assert.equal(writes.count, 0);

  assert.deepEqual(await deleteUnreadableCredentialValues(target, ["broken"]), ["broken"]);
  assert.deepEqual(await loadManyCredentialValues(target, ["good", "broken"]), {
    good: "g",
    broken: null,
  });
  assert.equal(writes.count, 1);
});

test("deleteUnreadable：removeKeys 与 replacements 同一次提交，keys 去重且完整", async () => {
  const { target, cipher, filePath } = await createTarget();
  await writeRecord(
    filePath,
    Object.assign(await encryptAll(cipher, { legacy: "l", derived: "d" }), {
      broken: CORRUPT_CIPHERTEXT,
    }),
  );

  const committed = await deleteUnreadableCredentialValues(target, ["broken"], {
    removeKeys: ["broken", "derived"],
    replacements: { revision: "r1" },
  });
  assert.deepEqual(committed, ["broken", "derived", "revision"]);
  assert.equal(new Set(committed).size, committed?.length, "通知键必须去重");
  assert.deepEqual(
    await loadManyCredentialValues(target, ["broken", "derived", "legacy", "revision"]),
    {
      broken: null,
      derived: null,
      legacy: "l",
      revision: "r1",
    },
  );
});

test("deleteUnreadable：锁内已被修复 ⇒ 返回 null 不删（CAS 期望值同样生效）", async () => {
  const { target, cipher, filePath, writes } = await createTarget();
  await writeRecord(
    filePath,
    Object.assign(await encryptAll(cipher, { good: "g" }), { broken: CORRUPT_CIPHERTEXT }),
  );

  assert.equal(
    await deleteUnreadableCredentialValues(target, ["broken"], { expected: { good: "other" } }),
    null,
    "期望值不匹配 ⇒ 不提交",
  );
  assert.equal(writes.count, 0);

  // 另一个进程用可读替换值修好了这个键：不应再被当成「不可读」删除。
  assert.deepEqual(
    await deleteUnreadableCredentialValues(target, ["broken"], {
      removeKeys: [],
      replacements: { broken: "fixed" },
    }),
    ["broken"],
  );
  assert.equal(writes.count, 1);
  assert.equal(await deleteUnreadableCredentialValues(target, ["broken"]), null);
  assert.equal(writes.count, 1, "已修复的键不得再次写盘");
});

test("saveIfAbsent：并发收敛到先写入者并返回实际值，不覆盖已有键", async () => {
  const { target, filePath, writes } = await createTarget();
  const values = await Promise.all([
    saveCredentialValueIfAbsent(target, "token", "first"),
    saveCredentialValueIfAbsent(target, "token", "second"),
    saveCredentialValueIfAbsent(target, "token", "third"),
  ]);
  assert.deepEqual(values, [
    { value: "first", written: true },
    { value: "first", written: false },
    { value: "first", written: false },
  ]);
  assert.equal(writes.count, 1, "只有先写入者落盘");
  assert.deepEqual(await loadManyCredentialValues(target, ["token"]), { token: "first" });
  assert.equal(Object.keys(await readRecord(filePath)).length, 1);
});

test("saveIfAbsent：已有值解不开时抛 DECRYPT_FAILED，不覆盖", async () => {
  const { target, filePath, writes } = await createTarget();
  const before = { token: CORRUPT_CIPHERTEXT };
  await writeRecord(filePath, before);
  await assert.rejects(
    () => saveCredentialValueIfAbsent(target, "token", "new"),
    (error: { code?: string }) => error.code === "ZCODE_CREDENTIAL_DECRYPT_FAILED",
  );
  assert.equal(writes.count, 0);
  assert.deepEqual(await readRecord(filePath), before);
});

test("deleteIfEquals：只删仍相等的值，不等或缺失不写盘", async () => {
  const { target, cipher, filePath, writes } = await createTarget();
  await writeRecord(
    filePath,
    Object.assign(await encryptAll(cipher, { token: "current" }), {
      broken: CORRUPT_CIPHERTEXT,
    }),
  );

  assert.equal(await deleteCredentialValueIfEquals(target, "token", "stale"), false);
  assert.equal(await deleteCredentialValueIfEquals(target, "missing", "x"), false);
  assert.equal(await deleteCredentialValueIfEquals(target, "broken", "x"), false, "解不开不得删");
  assert.equal(writes.count, 0);

  assert.equal(await deleteCredentialValueIfEquals(target, "token", "current"), true);
  assert.equal(writes.count, 1);
  assert.deepEqual(await loadManyCredentialValues(target, ["token"]), { token: null });
});

test("recoverUnreadable：可读不动盘；不可读删键并返回 null；assertCurrent 在锁内复检", async () => {
  const { target, cipher, filePath, writes } = await createTarget();
  await writeRecord(
    filePath,
    Object.assign(await encryptAll(cipher, { good: "g" }), { broken: CORRUPT_CIPHERTEXT }),
  );

  let checks = 0;
  assert.deepEqual(
    await recoverUnreadableCredentialValue(target, "good", () => {
      checks += 1;
    }),
    { value: "g", removed: false },
  );
  assert.equal(writes.count, 0, "可读键不得改写磁盘");
  assert.equal(checks, 1);

  assert.deepEqual(await recoverUnreadableCredentialValue(target, "missing", () => undefined), {
    value: null,
    removed: false,
  });

  // 第一次复检通过，第二次（删除前）抛错 ⇒ 不得删除不可读键。
  let secondCheck = 0;
  await assert.rejects(
    () =>
      recoverUnreadableCredentialValue(target, "broken", () => {
        secondCheck += 1;
        if (secondCheck > 1) throw new Error("revision changed");
      }),
    /revision changed/,
  );
  assert.equal(writes.count, 0);
  assert.equal((await readRecord(filePath)).broken, CORRUPT_CIPHERTEXT);

  assert.deepEqual(await recoverUnreadableCredentialValue(target, "broken", () => undefined), {
    value: null,
    removed: true,
  });
  assert.equal((await readRecord(filePath)).broken, undefined);
});

test("captureRecoveryGuard：事务期间代次变化 ⇒ STORE_CHANGED；作用域内写入口拒绝旧代次", async () => {
  const { target, filePath } = await createTarget();
  const guard = await captureCredentialGuard(target);

  await assert.rejects(
    () =>
      guard(async () => {
        await advanceCredentialGeneration(filePath);
        return "done";
      }),
    (error: { code?: string }) => error.code === CREDENTIAL_STORE_CHANGED_CODE,
  );

  const second = await captureCredentialGuard(target);
  await assert.rejects(
    () =>
      second(async () => {
        await updateCredentialValuesMany(target, { k: "v" });
        await advanceCredentialGeneration(filePath);
        return updateCredentialValuesMany(target, { k: "w" });
      }),
    (error: { code?: string }) => error.code === CREDENTIAL_STORE_CHANGED_CODE,
  );
  assert.deepEqual(await loadManyCredentialValues(target, ["k"]), { k: "v" });

  // 无作用域时按当前代次提交：重置之后的新事务不应被旧代次卡住。
  assert.equal(await updateCredentialValuesMany(target, { k: "after" }), true);
});

test("withCredentialGenerationScope：嵌套复用起始代次，代次推进后写入口即拒绝", async () => {
  const { target, filePath } = await createTarget();
  const generation = await captureCredentialGeneration(filePath);
  await withCredentialGenerationScope(filePath, async () => {
    assert.equal(await captureCredentialGeneration(filePath), generation);
    await advanceCredentialGeneration(filePath);
    await assert.rejects(
      () => updateCredentialValuesMany(target, { k: "v" }),
      (error: { code?: string }) => error.code === CREDENTIAL_STORE_CHANGED_CODE,
    );
  });
});

test("keyring 路径：批量写入落 os 密文与来源标记，loadMany 用同一把密钥读回", async () => {
  const { store, state } = createFakeKeyStore();
  const { target, cipher, filePath } = await createTarget({ keyStore: store });
  assert.equal(
    (await saveCredentialValueIfAbsent(target, "oauth:zai:access_token", "token")).written,
    true,
  );
  assert.equal(
    await updateCredentialValuesMany(target, { "oauth:zai:refresh_token": "refresh" }),
    true,
  );

  const record = await readRecord(filePath);
  assert.ok(record["oauth:zai:access_token"]?.startsWith("enc:v2:os:"), "必须写成系统库密文");
  assert.ok(
    Object.values(record).every((value) => value.startsWith("enc:v2:os:")),
    "容器里每个值都必须是系统库密文，不得落明文",
  );
  assert.ok(
    Object.values(record).every((value) => !value.includes("token") && !value.includes("refresh")),
    "容器不得含明文值",
  );
  assert.equal(await readFile(join(filePath, "..", CREDENTIAL_SOURCE_FILE), "utf8"), "os\n");
  // 首次创建密钥是「读一次 + 写后读回校验一次」；之后的读写都必须命中进程内缓存。
  const getsAfterCreate = state.gets;
  assert.equal(getsAfterCreate, 2, "首次创建只允许 get 两次（读 + 读回校验）");
  await assert.rejects(stat(privateSecretPath(filePath)), "系统库可用时不发布私有密钥");
  assert.equal(await cipher.decrypt(record["oauth:zai:access_token"]!), "token");
  assert.deepEqual(await loadManyCredentialValues(target, ["oauth:zai:access_token"]), {
    "oauth:zai:access_token": "token",
  });
  assert.equal(state.gets, getsAfterCreate, "同一把密钥只加载一次");
});

test("keyring 路径：密文损坏 ⇒ DECRYPT_FAILED 且可被 deleteUnreadable 清理", async () => {
  const { store } = createFakeKeyStore();
  const { target, filePath } = await createTarget({ keyStore: store });
  await updateCredentialValuesMany(target, { a: "1", b: "2" });
  const record = await readRecord(filePath);
  const damaged = damagePayload(record.a!);
  await writeRecord(filePath, { ...record, a: damaged });

  // 指纹仍是本目录这把密钥 ⇒ 是「密文损坏」而不是「密钥不可用」。
  await assert.rejects(
    () => loadManyCredentialValues(target, ["a"]),
    (error: { code?: string }) => error.code === "ZCODE_CREDENTIAL_DECRYPT_FAILED",
  );
  assert.deepEqual(await deleteUnreadableCredentialValues(target, ["a"]), ["a"]);
  assert.deepEqual(await loadManyCredentialValues(target, ["a", "b"]), { a: null, b: "2" });
});

test("keyring 路径：换了密钥 ⇒ 存储错误且一条不删（不清库、不换来源）", async () => {
  const { store } = createFakeKeyStore();
  const { target, filePath } = await createTarget({ keyStore: store });
  await updateCredentialValuesMany(target, { a: "1", b: "2" });
  const before = await readFile(filePath);

  const otherKey = createFakeKeyStore("m".repeat(43));
  const otherCipher = createSystemCredentialCipher({ filePath, env: {}, keyStore: otherKey.store });
  const wrongKey: CredentialRecordTarget = { ...target, cipher: otherCipher };
  await assert.rejects(
    () => loadManyCredentialValues(wrongKey, ["a"]),
    (error: { code?: string }) => error.code === CREDENTIAL_SECURE_STORAGE_UNAVAILABLE_CODE,
  );
  await assert.rejects(
    () => deleteUnreadableCredentialValues(wrongKey, ["a", "b"]),
    (error: { code?: string }) => error.code === CREDENTIAL_SECURE_STORAGE_UNAVAILABLE_CODE,
    "密钥不可用时不得把整库当成可清理",
  );
  assert.deepEqual(await readFile(filePath), before, "存储错误不得改写凭据文件");
});

test("keyring 路径：系统库读取失败 ⇒ STORAGE_UNAVAILABLE 且一条不删", async () => {
  const { store } = createFakeKeyStore();
  const { target, filePath } = await createTarget({ keyStore: store });
  await updateCredentialValuesMany(target, { c: "3" });
  const before = await readFile(filePath);

  const deadStore = createFakeKeyStore();
  deadStore.state.failGet = true;
  const deadCipher = createSystemCredentialCipher({ filePath, env: {}, keyStore: deadStore.store });
  const unusable: CredentialRecordTarget = { ...target, cipher: deadCipher };
  await assert.rejects(
    () => deleteUnreadableCredentialValues(unusable, ["c"]),
    (error: { code?: string }) => error.code === CREDENTIAL_SECURE_STORAGE_UNAVAILABLE_CODE,
  );
  assert.deepEqual(await readFile(filePath), before, "密钥不可用时不得清库");
});
