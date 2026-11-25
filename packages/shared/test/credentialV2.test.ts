import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import {
  CREDENTIAL_SECURE_STORAGE_UNAVAILABLE_CODE,
  CREDENTIAL_SOURCE_FILE,
  CREDENTIAL_STORE_CHANGED_CODE,
  LEGACY_PREFIX,
  OS_SOURCE_MARKER,
  SYSTEM_PREFIX,
  advanceCredentialGeneration,
  captureCredentialGeneration,
  createLegacyCredentialCipher,
  createServerCredentialCipher,
  createSystemCredentialCipher,
  migrateCredentialRecord,
  needsCredentialMigration,
  privateSecretPath,
  writeCredentialRecordLocked,
  type CredentialKeyStore,
} from "../src/credential-security/module.js";

/**
 * 凭据 v2 P1 的验收断言（SPEC §4.11 的 T1–T15 中与共享层相关的部分）。
 *
 * 这里钉住的是「改动理由本身」：拿到 credentials.json 副本不再等于拿到 token；
 * 无头形态不得静默生成弱密钥；钥匙串坏掉只能走「只解除绑定、不清库」；
 * 旧 v1 密文必须就地升级且升级后不再以旧格式落盘。
 */

const temporaryDirs: string[] = [];

after(async () => {
  await Promise.all(temporaryDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createCredentialsPath(): Promise<{ dir: string; filePath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-credential-v2-"));
  temporaryDirs.push(dir);
  return { dir, filePath: join(dir, "credentials.json") };
}

interface FakeKeyStoreState {
  value: string | null;
  gets: number;
  sets: number;
  failGet: boolean;
  failSet: boolean;
}

/** 模拟系统凭据库：可注入「读到失败」「写入失败」「写后读回不一致」。 */
function createFakeKeyStore(
  initial: string | null = null,
  options: { delayMs?: number } = {},
): { store: CredentialKeyStore; state: FakeKeyStoreState } {
  const state: FakeKeyStoreState = {
    value: initial,
    gets: 0,
    sets: 0,
    failGet: false,
    failSet: false,
  };
  const pause = async () => {
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
  };
  const store: CredentialKeyStore = {
    async get() {
      state.gets += 1;
      await pause();
      if (state.failGet) throw Object.assign(new Error("keyring locked"), { code: "EKEYRING" });
      return state.value;
    },
    async set(value: string) {
      state.sets += 1;
      await pause();
      if (state.failSet) throw Object.assign(new Error("quota exceeded"), { osCode: 8 });
      state.value = value;
    },
  };
  return { store, state };
}

async function writeRecord(filePath: string, record: Record<string, string>): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

async function readRecord(filePath: string): Promise<Record<string, string>> {
  return JSON.parse(await readFile(filePath, "utf8")) as Record<string, string>;
}

function ciphertextFingerprint(value: string): string {
  const parts = value.slice(SYSTEM_PREFIX.length).split(":");
  return `${parts[0]}:${parts[1]}`;
}

test("T2/T1：钥匙串可用时用它加密，凭据文件不落明文也不落私有密钥", async () => {
  const { dir, filePath } = await createCredentialsPath();
  const { store, state } = createFakeKeyStore();
  const cipher = createSystemCredentialCipher({ filePath, env: {}, keyStore: store });

  const encrypted = await cipher.encrypt("token-value");
  assert.ok(encrypted.startsWith(`${SYSTEM_PREFIX}os:`), encrypted.slice(0, 16));
  assert.equal(state.sets, 1, "首次访问只生成一把密钥");
  assert.equal(await cipher.decrypt(encrypted), "token-value");
  assert.equal(await readFile(join(dir, CREDENTIAL_SOURCE_FILE), "utf8"), OS_SOURCE_MARKER);

  await writeRecord(filePath, { "oauth:zai:access_token": encrypted });
  const raw = await readFile(filePath, "utf8");
  assert.ok(!raw.includes("token-value"), "容器副本不得包含明文");
  await assert.rejects(stat(privateSecretPath(filePath)), "系统库可用时不发布私有密钥");

  // I1：只用 platform/homedir/username 推导的旧密钥解不开 v2 密文。
  const legacy = createLegacyCredentialCipher({});
  assert.throws(() => legacy.decrypt(encrypted));
});

test("T2：同一进程内第二次访问复用密钥与失败结果，不重复写系统库", async () => {
  const { filePath } = await createCredentialsPath();
  const { store, state } = createFakeKeyStore();
  const first = createSystemCredentialCipher({ filePath, env: {}, keyStore: store });
  const encrypted = await first.encrypt("a");

  const second = createSystemCredentialCipher({ filePath, env: {}, keyStore: store });
  const secondEncrypted = await second.encrypt("b");
  assert.equal(state.sets, 1, "同一路径只生成一次密钥");
  assert.equal(ciphertextFingerprint(encrypted), ciphertextFingerprint(secondEncrypted));
  assert.equal(await second.decrypt(encrypted), "a");
});

test("T3：并发首次访问只产生一把密钥", async () => {
  const { filePath } = await createCredentialsPath();
  const { store, state } = createFakeKeyStore(null, { delayMs: 5 });
  const ciphers = Array.from({ length: 8 }, () =>
    createSystemCredentialCipher({ filePath, env: {}, keyStore: store }),
  );

  const encrypted = await Promise.all(ciphers.map((cipher) => cipher.encrypt("v")));
  assert.equal(state.sets, 1, "8 个并发首次访问只能 set 一次");
  assert.equal(
    new Set(encrypted.map((value) => ciphertextFingerprint(value))).size,
    1,
    "所有并发结果必须指向同一把密钥",
  );
});

test("T7：钥匙串不可用 + 未绑定目录 ⇒ 发布 0600 私有文件并改用文件密钥", async () => {
  const { filePath } = await createCredentialsPath();
  const broken = createFakeKeyStore();
  broken.state.failGet = true;
  let fallbacks = 0;
  const cipher = createSystemCredentialCipher({
    filePath,
    env: {},
    keyStore: broken.store,
    onFallback: () => {
      fallbacks += 1;
    },
  });

  const encrypted = await cipher.encrypt("token");
  assert.ok(encrypted.startsWith(`${SYSTEM_PREFIX}env:`));
  assert.equal(fallbacks, 1, "回退回调只触发一次，且不带密钥/路径");
  const metadata = await stat(privateSecretPath(filePath));
  if (process.platform !== "win32") {
    assert.equal(metadata.mode & 0o777, 0o600, "私有密钥文件必须 0600");
  }

  // 之后的进程先发现该文件，不再访问系统库。
  const later = createFakeKeyStore();
  later.state.failGet = true;
  const second = createSystemCredentialCipher({ filePath, env: {}, keyStore: later.store });
  assert.equal(await second.decrypt(encrypted), "token");
  assert.equal(later.state.gets, 0, "已有私有文件时不得再访问系统库");
});

test("T8/I3：钥匙串不可用 + 已有 os 密文 ⇒ 存储错误，不清库、不换来源", async () => {
  const { dir, filePath } = await createCredentialsPath();
  const healthy = createFakeKeyStore();
  const cipher = createSystemCredentialCipher({ filePath, env: {}, keyStore: healthy.store });
  const encrypted = await cipher.encrypt("token");
  await writeRecord(filePath, { k: encrypted });
  const before = await readFile(filePath);

  const broken = createFakeKeyStore();
  broken.state.failGet = true;
  const failing = createSystemCredentialCipher({ filePath, env: {}, keyStore: broken.store });
  await assert.rejects(
    () => failing.decrypt(encrypted),
    (error: { code?: string; diagnostic?: { stage?: string } }) => {
      assert.equal(error.code, CREDENTIAL_SECURE_STORAGE_UNAVAILABLE_CODE);
      assert.equal(error.diagnostic?.stage, "read");
      return true;
    },
  );
  assert.deepEqual(await readFile(filePath), before, "存储错误不得改写凭据文件");
  assert.equal(await readFile(join(dir, CREDENTIAL_SOURCE_FILE), "utf8"), OS_SOURCE_MARKER);
  await assert.rejects(stat(privateSecretPath(filePath)), "已绑定目录不得切换来源");
});

test("D1'：已绑定 os 但文件无 v2 密文 ⇒ 只解除绑定，不清库", async () => {
  const { dir, filePath } = await createCredentialsPath();
  await writeFile(join(dir, CREDENTIAL_SOURCE_FILE), OS_SOURCE_MARKER);
  const broken = createFakeKeyStore();
  broken.state.failGet = true;
  const cipher = createSystemCredentialCipher({ filePath, env: {}, keyStore: broken.store });

  const migrated = await migrateCredentialRecord({ legacy: "plain-token" }, cipher);
  assert.ok(migrated, "旧值必须就地升级");
  assert.ok(migrated.legacy?.startsWith(`${SYSTEM_PREFIX}env:`));
  await assert.rejects(stat(join(dir, CREDENTIAL_SOURCE_FILE)), "来源标记必须被删除");
  const secret = await readFile(privateSecretPath(filePath), "utf8");
  assert.equal(secret.length, 43, "改用同目录私有密钥文件");
  assert.equal(await cipher.decrypt(migrated.legacy!), "plain-token");
});

test("D2'：无头形态无来源 ⇒ 明确拒绝就绪且不自动生成密钥", async () => {
  const { dir, filePath } = await createCredentialsPath();
  const broken = createFakeKeyStore();
  broken.state.failGet = true;

  await assert.rejects(
    () => createServerCredentialCipher({ filePath, env: {}, keyStore: broken.store }),
    (error: { code?: string; message?: string }) => {
      assert.equal(error.code, CREDENTIAL_SECURE_STORAGE_UNAVAILABLE_CODE);
      assert.match(error.message ?? "", /credential-secret/);
      assert.ok((error.message ?? "").includes(dir), "错误必须给出可操作目录");
      assert.match(error.message ?? "", /32–4096/);
      return true;
    },
  );
  await assert.rejects(stat(privateSecretPath(filePath)), "无头形态不得自动生成");
});

test("D2'：无头形态挂载 32–4096 字节私有文件后可用", async () => {
  const { filePath } = await createCredentialsPath();
  await writeFile(privateSecretPath(filePath), "k".repeat(43), { mode: 0o600 });
  const broken = createFakeKeyStore();
  broken.state.failGet = true;
  const cipher = await createServerCredentialCipher({
    filePath,
    env: {},
    keyStore: broken.store,
  });
  const encrypted = await cipher.encrypt("token");
  assert.ok(encrypted.startsWith(`${SYSTEM_PREFIX}env:`));
  assert.equal(await cipher.decrypt(encrypted), "token");
});

test("T9：SECRET 与 SECRET_FILE 同时设置 ⇒ stage=config 拒绝", async () => {
  const { filePath } = await createCredentialsPath();
  const { store } = createFakeKeyStore();
  const cipher = createSystemCredentialCipher({
    filePath,
    env: {
      ZCODE_CREDENTIAL_SECRET: "x".repeat(32),
      ZCODE_CREDENTIAL_SECRET_FILE: join(filePath, "secret"),
    },
    keyStore: store,
  });
  await assert.rejects(
    () => cipher.encrypt("v"),
    (error: { diagnostic?: { stage?: string } }) => error.diagnostic?.stage === "config",
  );
});

test("T10：私有密钥文件权限放宽 / 长度越界 ⇒ stage=managed 拒绝", async () => {
  const { filePath } = await createCredentialsPath();
  const broken = createFakeKeyStore();
  broken.state.failGet = true;
  const cipher = createSystemCredentialCipher({ filePath, env: {}, keyStore: broken.store });

  if (process.platform !== "win32") {
    await writeFile(privateSecretPath(filePath), "k".repeat(43), { mode: 0o644 });
    await assert.rejects(
      () => cipher.encrypt("v"),
      (error: { diagnostic?: { stage?: string } }) => error.diagnostic?.stage === "managed",
    );
  }

  await writeFile(privateSecretPath(filePath), "short", { mode: 0o600 });
  await assert.rejects(
    () => cipher.encrypt("v"),
    (error: { diagnostic?: { stage?: string } }) => error.diagnostic?.stage === "managed",
  );

  await writeFile(privateSecretPath(filePath), "k".repeat(4097), { mode: 0o600 });
  await assert.rejects(
    () => cipher.encrypt("v"),
    (error: { diagnostic?: { stage?: string } }) => error.diagnostic?.stage === "managed",
  );
});

test("T4：v1 三个历史候选密钥都能就地升级为 v2", async () => {
  const { filePath } = await createCredentialsPath();
  const secret = "  spaced-secret  ";
  const legacyFallback = createLegacyCredentialCipher({});
  const legacyRaw = createLegacyCredentialCipher({ ZCODE_CREDENTIAL_SECRET: secret });
  const legacyTrimmed = createLegacyCredentialCipher({ ZCODE_CREDENTIAL_SECRET: secret.trim() });
  const record = {
    fallback: legacyFallback.encrypt("token-a"),
    raw: legacyRaw.encrypt("token-b"),
    trimmed: legacyTrimmed.encrypt("token-c"),
  };
  assert.ok(Object.values(record).every((value) => value.startsWith(LEGACY_PREFIX)));

  const { store } = createFakeKeyStore();
  const cipher = createSystemCredentialCipher({
    filePath,
    env: { ZCODE_CREDENTIAL_SECRET: secret },
    keyStore: store,
  });
  const migrated = await migrateCredentialRecord(record, cipher);
  assert.ok(migrated);
  assert.equal(await cipher.decrypt(migrated.fallback!), "token-a");
  assert.equal(await cipher.decrypt(migrated.raw!), "token-b");
  assert.equal(await cipher.decrypt(migrated.trimmed!), "token-c");
  assert.deepEqual(Object.keys(migrated).sort(), ["fallback", "raw", "trimmed"], "不得删键");
  assert.ok(
    Object.values(migrated).every((value) => value.startsWith(`${SYSTEM_PREFIX}env:`)),
    "写入恒为 v2 且来源为 env",
  );
  assert.ok(
    !Object.values(migrated).some((value) => needsCredentialMigration(value)),
    "升级后不再有旧格式值",
  );

  // 磁盘上只保留 v2：旧格式文件不再可读。
  await writeRecord(filePath, migrated);
  const raw = await readFile(filePath, "utf8");
  assert.ok(!raw.includes(LEGACY_PREFIX));
});

test("T4：无显式密钥时 fallback v1 升级为 enc:v2:os", async () => {
  const { filePath } = await createCredentialsPath();
  const legacy = createLegacyCredentialCipher({});
  const { store, state } = createFakeKeyStore();
  const cipher = createSystemCredentialCipher({ filePath, env: {}, keyStore: store });

  const migrated = await migrateCredentialRecord({ k: legacy.encrypt("token") }, cipher);
  assert.ok(migrated);
  assert.ok(migrated.k?.startsWith(`${SYSTEM_PREFIX}os:`));
  assert.equal(state.sets, 1);
  assert.equal(await cipher.decrypt(migrated.k!), "token");
});

test("T5：混合容器里 v2 密钥不可用 ⇒ 整组迁移失败，不产生半份结果", async () => {
  const { filePath } = await createCredentialsPath();
  const healthy = createFakeKeyStore();
  const writer = createSystemCredentialCipher({ filePath, env: {}, keyStore: healthy.store });
  const osCiphertext = await writer.encrypt("already-v2");
  const legacy = createLegacyCredentialCipher({});
  const record = { v2: osCiphertext, old: legacy.encrypt("old-token") };
  await writeRecord(filePath, record);
  const before = await readFile(filePath);

  const broken = createFakeKeyStore();
  broken.state.failGet = true;
  const failing = createSystemCredentialCipher({ filePath, env: {}, keyStore: broken.store });
  await assert.rejects(() => migrateCredentialRecord(record, failing));
  assert.deepEqual(await readFile(filePath), before, "迁移失败不得写盘");
});

test("T6：单条 v1 解不开 ⇒ 保留原值，其他照常迁移，不删任何键", async () => {
  const { filePath } = await createCredentialsPath();
  const legacy = createLegacyCredentialCipher({});
  const { store } = createFakeKeyStore();
  const cipher = createSystemCredentialCipher({ filePath, env: {}, keyStore: store });
  const broken = `${LEGACY_PREFIX}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
  const record = { good: legacy.encrypt("ok-token"), broken };

  const migrated = await migrateCredentialRecord(record, cipher);
  assert.ok(migrated);
  assert.ok(migrated.good?.startsWith(`${SYSTEM_PREFIX}os:`));
  assert.equal(migrated.broken, broken, "解不开的值必须原样保留");
  assert.deepEqual(Object.keys(migrated).sort(), ["broken", "good"]);
});

test("T11：新产生 enc:v2:os 但来源标记缺失 ⇒ 拒绝写盘，磁盘字节不变", async () => {
  const { filePath } = await createCredentialsPath();
  const { store } = createFakeKeyStore();
  const cipher = createSystemCredentialCipher({ filePath, env: {}, keyStore: store });
  const encrypted = await cipher.encrypt("token");
  await writeRecord(filePath, {});
  const before = await readFile(filePath);
  const { rm: removeFile } = await import("node:fs/promises");
  await removeFile(join(filePath, "..", CREDENTIAL_SOURCE_FILE), { force: true });

  await assert.rejects(
    () =>
      writeCredentialRecordLocked(
        filePath,
        { k: encrypted },
        {
          previous: {},
          write: (record) => writeRecord(filePath, record),
        },
      ),
    (error: { diagnostic?: { stage?: string } }) => error.diagnostic?.stage === "source",
  );
  assert.deepEqual(await readFile(filePath), before);
});

test("T15：磁盘上已有 os 密文时写入旧值 ⇒ 放行（不回退检查历史值）", async () => {
  const { filePath } = await createCredentialsPath();
  const { store } = createFakeKeyStore();
  const cipher = createSystemCredentialCipher({ filePath, env: {}, keyStore: store });
  const encrypted = await cipher.encrypt("token");
  const previous = { k: encrypted };
  await writeRecord(filePath, previous);

  const { rm: removeFile } = await import("node:fs/promises");
  await removeFile(join(filePath, "..", CREDENTIAL_SOURCE_FILE), { force: true });
  await writeCredentialRecordLocked(
    filePath,
    { k: encrypted, legacy: "plain-value" },
    { previous, write: (record) => writeRecord(filePath, record) },
  );
  assert.equal((await readRecord(filePath)).legacy, "plain-value");
});

test("T12：加密后、写盘前代次变化 ⇒ STORE_CHANGED 拒绝写盘，重试成功", async () => {
  const { filePath } = await createCredentialsPath();
  const generation = await captureCredentialGeneration(filePath);
  await advanceCredentialGeneration(filePath);

  let written = 0;
  await assert.rejects(
    () =>
      writeCredentialRecordLocked(
        filePath,
        { k: "v" },
        {
          expectedGeneration: generation,
          write: async () => {
            written += 1;
          },
        },
      ),
    (error: { code?: string }) => error.code === CREDENTIAL_STORE_CHANGED_CODE,
  );
  assert.equal(written, 0, "代次变化不得写盘");

  const retry = await captureCredentialGeneration(filePath);
  await writeCredentialRecordLocked(
    filePath,
    { k: "v" },
    {
      expectedGeneration: retry,
      write: async (record) => {
        written += 1;
        await writeRecord(filePath, record);
      },
    },
  );
  assert.equal(written, 1);
});

test("未知 enc: 前缀 ⇒ 明确报错而不是当明文返回", async () => {
  const { filePath } = await createCredentialsPath();
  const { store } = createFakeKeyStore();
  const cipher = createSystemCredentialCipher({ filePath, env: {}, keyStore: store });
  await assert.rejects(
    () => cipher.decrypt("enc:v9:unknown-format"),
    (error: { code?: string }) => error.code === "ZCODE_CREDENTIAL_DECRYPT_FAILED",
  );
  assert.equal(await cipher.decrypt("plain-token"), "plain-token");
});

test("T14：数据根切换把同一把密钥登记到目标路径，目标已有另一把则拒绝覆盖", async () => {
  const { dir, filePath } = await createCredentialsPath();
  const targetDir = join(dir, "switched");
  await mkdir(targetDir, { recursive: true });
  const targetFile = join(targetDir, "credentials.json");

  const source = createFakeKeyStore();
  const sourceCipher = createSystemCredentialCipher({
    filePath,
    env: {},
    keyStore: source.store,
  });
  const encrypted = await sourceCipher.encrypt("token");
  await writeRecord(filePath, { k: encrypted });
  await writeRecord(targetFile, { k: encrypted });
  await writeFile(join(targetDir, CREDENTIAL_SOURCE_FILE), OS_SOURCE_MARKER);

  const target = createFakeKeyStore();
  await sourceCipher.shareKeyWithCopiedCredentials(targetFile, target.store);
  assert.equal(target.state.value, source.state.value, "目标条目必须是同一把密钥");

  const conflicting = createFakeKeyStore("m".repeat(43));
  await writeRecord(filePath, { k: encrypted });
  await assert.rejects(
    () => sourceCipher.shareKeyWithCopiedCredentials(targetFile, conflicting.store),
    (error: { code?: string }) => error.code === CREDENTIAL_SECURE_STORAGE_UNAVAILABLE_CODE,
  );
  assert.equal(conflicting.state.value, "m".repeat(43), "不得覆盖目标已有密钥");
});
