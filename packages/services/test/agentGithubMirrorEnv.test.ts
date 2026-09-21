import assert from "node:assert/strict";
import test from "node:test";
import { ZCODE_GITHUB_MIRROR_ENV_KEY } from "@zcode/shared";
import {
  buildAgentGithubMirrorEnv,
  buildAgentRuntimeEnv,
} from "../src/runtime-tools/agentProxyEnv.js";

/**
 * 「设置页的 GitHub 加速前缀送达 agent 子进程」的回归测试。
 *
 * 为什么必须锁这条链路：插件市场安装在 **agent 子进程**内执行
 * （bootstrap/zcode-protocol/plugins.ts → adapters/plugins/marketplace.ts），
 * 子进程里没有设置服务，只能靠 spawn env 拿到前缀。
 * 一旦宿主侧漏注入，设置页保存成功、UI 正常，但插件市场仍会直连 GitHub ——
 * 这是**静默失效**：没有任何报错，用户只会觉得"配了没用"。
 *
 * 运行：cd packages/services && node --import tsx --test test/agentGithubMirrorEnv.test.ts
 */

const PREFIX = "https://ghfast.top/";

test("a configured prefix reaches the agent subprocess under the documented key", () => {
  assert.deepEqual(buildAgentGithubMirrorEnv(PREFIX), {
    [ZCODE_GITHUB_MIRROR_ENV_KEY]: PREFIX,
  });
  // 前缀会被规范化（补结尾斜杠），子进程拿到的始终是可直接拼接的形态。
  assert.deepEqual(buildAgentGithubMirrorEnv("https://ghfast.top"), {
    [ZCODE_GITHUB_MIRROR_ENV_KEY]: PREFIX,
  });
});

test("no prefix configured injects nothing, so the default stays direct", () => {
  for (const value of [undefined, "", "   "]) {
    assert.deepEqual(buildAgentGithubMirrorEnv(value), {}, String(value));
  }
});

test("an invalid prefix is not injected rather than breaking agent startup", () => {
  // 保存期已拒绝这些值；这里防的是手工编辑 setting.json 或旧版本回写。
  // 注入非法值会让子进程侧白算一次，不如不注入，让它退回直连。
  for (const value of ["http://ghfast.top/", "ghfast.top", "https://user:pass@ghfast.top/"]) {
    assert.deepEqual(buildAgentGithubMirrorEnv(value), {}, value);
  }
});

test("the mirror env composes with proxy and CA injection without clobbering them", () => {
  // 三个补丁共用同一个 spawn env 装配点，键不能互相覆盖。
  const proxyEnv = buildAgentRuntimeEnv({
    httpProxy: "http://127.0.0.1:7890",
    caCertPath: "/tmp/root-ca.pem",
  });
  const merged = { ...proxyEnv, ...buildAgentGithubMirrorEnv(PREFIX) };

  assert.equal(merged[ZCODE_GITHUB_MIRROR_ENV_KEY], PREFIX);
  assert.equal(merged.HTTPS_PROXY, "http://127.0.0.1:7890");
  assert.equal(merged.NODE_EXTRA_CA_CERTS, "/tmp/root-ca.pem");
});
