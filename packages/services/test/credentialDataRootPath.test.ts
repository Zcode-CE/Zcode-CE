import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import {
  resolveCredentialsFilePath,
  resolveCredentialsFilePathIn,
} from "@zcode/shared/credential-paths";
import { createSystemCredentialCipher } from "@zcode/shared/credential-security";
import { createCredentialService } from "../src/credential/credentialService.js";
import { getCredentialsFilePath, setDataBaseDir } from "../src/paths.js";

/**
 * T13：凭据文件路径必须「跟随数据根」且与 CLI 逐字节相等。
 *
 * 为什么必须钉住：系统凭据库条目名 = sha256(凭据文件绝对路径)。Host 与 CLI 若解析出不同路径，
 * 就会给同一个文件造两把密钥 —— 一半密文永久解不开，用户表现为「时不时掉登录」。
 * 桌面切数据根时只有 Host 知道新根（setDataBaseDir），所以 Host 侧必须真的跟着新根走；
 * CLI 侧用同一个解析器（`resolveCredentialsFilePath(env)`），两者只差 baseDir 的来源。
 *
 * 运行：cd packages/services && node --import tsx --test test/credentialDataRootPath.test.ts
 */

const temporaryDirs: string[] = [];

after(async () => {
  setDataBaseDir(null);
  await Promise.all(temporaryDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-cred-root-"));
  temporaryDirs.push(dir);
  return dir;
}

const CREDENTIAL_KEY = "oauth:zai:access_token";

test("T13：同一 env + 同一数据根下，Host 与 CLI 的凭据路径逐字节相等", () => {
  const root = "/tmp/zcode-cred-path-contract";
  const env = { ZCODE_DATA_BASE_DIR: root, HOME: "/tmp/zcode-cred-path-home" };

  // CLI 侧（adapters 的 resolveSharedZCodeCredentialsPath 无 baseDir/filePath 时就是这一支）。
  const cliPath = resolveCredentialsFilePath(env);
  setDataBaseDir(root);
  assert.equal(getCredentialsFilePath(), cliPath, "两侧必须解析出同一个文件");

  // 归一化差异（相对段、尾斜杠）也不能让两侧分叉：解析器用 resolve() 折叠。
  setDataBaseDir(`${root}/nested/..`);
  assert.equal(getCredentialsFilePath(), cliPath);
  assert.equal(
    resolveCredentialsFilePath({ ...env, ZCODE_DATA_BASE_DIR: `${root}/nested/..` }),
    cliPath,
    "带 .. 的数据根必须归一到同一路径",
  );
  assert.equal(resolveCredentialsFilePathIn(root), cliPath);

  // 反向：不同数据根必须得到不同路径（否则切根会读写同一个文件）。
  setDataBaseDir("/tmp/zcode-cred-path-other");
  assert.notEqual(getCredentialsFilePath(), cliPath);
  setDataBaseDir(null);
});

test("数据根切换：根 A 写入 → 切到根 B → Host/CLI 都读 B，A 的密文不被误读", async () => {
  const rootA = await createRoot();
  const rootB = await createRoot();
  const service = createCredentialService();

  setDataBaseDir(rootA);
  const fileA = getCredentialsFilePath();
  assert.equal(fileA, resolveCredentialsFilePathIn(rootA));
  await service.save(CREDENTIAL_KEY, "token-A");
  assert.equal(await service.load(CREDENTIAL_KEY), "token-A");
  const recordA = JSON.parse(await readFile(fileA, "utf8")) as Record<string, string>;
  assert.ok(recordA[CREDENTIAL_KEY]?.startsWith("enc:v2:"), "根 A 必须是 v2 密文");

  // 切到根 B：路径跟随新根，且读不到 A 的值（不是「回落到旧根」）。
  setDataBaseDir(rootB);
  const fileB = getCredentialsFilePath();
  assert.equal(fileB, resolveCredentialsFilePathIn(rootB), "凭据路径必须跟随数据根");
  assert.notEqual(fileB, fileA);
  assert.equal(await service.load(CREDENTIAL_KEY), null, "切根后不得读到旧根的值");
  await service.save(CREDENTIAL_KEY, "token-B");
  assert.equal(await service.load(CREDENTIAL_KEY), "token-B");

  // CLI 视角：同一 env/dataRoot ⇒ 同一路径 ⇒ 同一把密钥 ⇒ 能解 Host 在 B 写的值。
  const cliPath = resolveCredentialsFilePath({ ZCODE_DATA_BASE_DIR: rootB });
  assert.equal(cliPath, fileB);
  const recordB = JSON.parse(await readFile(cliPath, "utf8")) as Record<string, string>;
  const cliCipher = createSystemCredentialCipher({ filePath: cliPath, env: {} });
  assert.equal(await cliCipher.decrypt(recordB[CREDENTIAL_KEY]!), "token-B");

  // 两个数据根各有自己的密钥（文件兜底），因此 A 的密文在 B 的密钥下必须明确失败，
  // 而不是被当成可解析内容返回。
  const secretA = await readFile(join(rootA, ".zcode", "v2", "credential-secret"), "utf8");
  const secretB = await readFile(join(rootB, ".zcode", "v2", "credential-secret"), "utf8");
  assert.notEqual(secretA, secretB, "不同数据根必须各自持有密钥");
  await assert.rejects(
    () => cliCipher.decrypt(recordA[CREDENTIAL_KEY]!),
    (error: { code?: string }) => error.code === "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE",
    "用 B 的密钥解 A 的密文必须报告存储/密钥错误，不得静默返回内容",
  );

  // 切回根 A：A 的文件与密钥都完好，值仍可解（切换不是破坏性操作）。
  setDataBaseDir(rootA);
  assert.equal(getCredentialsFilePath(), fileA);
  assert.equal(await service.load(CREDENTIAL_KEY), "token-A");
  setDataBaseDir(null);
});
