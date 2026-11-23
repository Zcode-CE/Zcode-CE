import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectWebE2eLoginState } from "./webE2eLoginState.js";

/**
 * 挂载前提判据的自测（task-11）。
 *
 * 为什么这条判据本身需要测试：它决定 `windowControllerChannelNoise` 与 `workspaceRegistryReconnect`
 * 这两条真浏览器 E2E 跑还是不跑。判据一旦写错（例如把「存在但缺 providerFamilyDomain」判成合格，
 * 或把非法 JSON 判成合格），那两条 E2E 会重新回到「等待超时」的假红；反过来若判据永远 skip，
 * 两条 E2E 会静默失去覆盖 —— 两种失败都不会有人发现，只能靠这里钉住。
 *
 * 全部在临时目录里做，不读也不写真实 `~/.zcode`。
 */

function createProfileDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "zcode-login-guard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("空资料目录：判为未登录，且缺什么就报什么", (t) => {
  const profileDir = createProfileDir(t);
  const report = inspectWebE2eLoginState(profileDir);
  assert.ok(report.skipReason, "缺 credentials.json 与 setting.json 时必须给出 skip 原因");
  assert.match(report.skipReason, /credentials\.json 不存在/);
  assert.match(report.skipReason, /setting\.json 不存在/);
  assert.match(report.skipReason, /显式跳过，不等于通过/);
  assert.match(report.skipReason, /登录一次账号/, "skip 文案必须写清怎么补");
});

test("credentials.json 是空文件：凭据损坏也算缺挂载前提", (t) => {
  const profileDir = createProfileDir(t);
  writeFileSync(join(profileDir, "credentials.json"), "");
  writeFileSync(join(profileDir, "setting.json"), JSON.stringify({ providerFamilyDomain: "zai" }));
  const report = inspectWebE2eLoginState(profileDir);
  assert.ok(report.skipReason);
  assert.match(report.skipReason, /是空文件（登录凭据损坏）/);
  assert.doesNotMatch(report.skipReason, /providerFamilyDomain（客户端启动会停在登录页）/);
});

test("有凭据但 setting.json 缺 providerFamilyDomain：仍会停在登录页，必须 skip", (t) => {
  const profileDir = createProfileDir(t);
  writeFileSync(join(profileDir, "credentials.json"), JSON.stringify({ token: "unit-test" }));
  writeFileSync(join(profileDir, "setting.json"), JSON.stringify({ theme: "dark" }));
  const report = inspectWebE2eLoginState(profileDir);
  assert.ok(
    report.skipReason,
    "useProviderAvailabilityLoginEntryGuard 的 !providerFamilyDomain 分支会打开登录页",
  );
  assert.match(report.skipReason, /providerFamilyDomain/);
});

test("setting.json 不是合法 JSON：如实说「无法解析」，不冒充已登录", (t) => {
  const profileDir = createProfileDir(t);
  writeFileSync(join(profileDir, "credentials.json"), JSON.stringify({ token: "unit-test" }));
  writeFileSync(join(profileDir, "setting.json"), "{ 这不是 JSON");
  const report = inspectWebE2eLoginState(profileDir);
  assert.ok(report.skipReason);
  assert.match(report.skipReason, /无法解析/);
});

test("凭据 + providerFamilyDomain 都在：判为可挂载，不 skip", (t) => {
  const profileDir = createProfileDir(t);
  writeFileSync(join(profileDir, "credentials.json"), JSON.stringify({ token: "unit-test" }));
  writeFileSync(
    join(profileDir, "setting.json"),
    JSON.stringify({ providerFamilyDomain: " bigmodel " }),
  );
  const report = inspectWebE2eLoginState(profileDir);
  assert.equal(report.skipReason, null);
  assert.deepEqual(report.missing, []);
});
