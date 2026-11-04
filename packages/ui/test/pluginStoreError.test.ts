import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { resolvePluginStoreErrorMessage } from "../src/lib/pluginStoreError.js";

/**
 * 插件管理 store 的用户可见错误走 i18n key（audit P2 遗留：store 里三条中文硬编码）。
 *
 * store 不持有 intl，所以它只写稳定 key（plugin.error.*），展示方用同一 helper 解析；
 * 服务端/底层错误仍原样透传。本测试钉住映射与双语在位，避免再出现「英文界面显示中文」。
 */

const here = dirname(fileURLToPath(import.meta.url));
const storeSource = readFileSync(resolve(here, "../src/store/pluginStore.ts"), "utf8");
const fakeIntl = { formatMessage: ({ id }: { id: string }) => id };

const KEYS = ["noWorkspaceInstall", "noWorkspaceUninstall", "noWorkspaceToggle"] as const;

test("store 只写稳定 key，不再硬编码中文提示", () => {
  for (const key of KEYS) {
    assert.ok(storeSource.includes("plugin.error." + key), "store 缺少 " + key + " 的稳定 key");
  }
  assert.doesNotMatch(storeSource, /请先打开一个工作区/, "store 里不应再有硬编码中文提示");
});

test("helper 把 key 映射到设置字典，且中英都在位", () => {
  for (const key of KEYS) {
    const id = "settings.plugins.error." + key;
    assert.equal(resolvePluginStoreErrorMessage(fakeIntl, "plugin.error." + key), id);
    assert.ok(id in zhCN, "zh-CN 缺少 " + id);
    assert.ok(id in enUS, "en-US 缺少 " + id);
  }
});

test("非 key 错误原样透传，空值返回 null", () => {
  assert.equal(
    resolvePluginStoreErrorMessage(fakeIntl, "service unavailable"),
    "service unavailable",
  );
  assert.equal(resolvePluginStoreErrorMessage(fakeIntl, null), null);
  assert.equal(resolvePluginStoreErrorMessage(fakeIntl, undefined), null);
});

/**
 * 概览请求的过期防护（audit A6）。
 *
 * 回归形态：切工作区后旧请求才返回，把上一台机器的市场与开关状态写进当前工作区
 * （远程同路径 workspace 尤其明显，因为两者 workspacePath 相同）。修复后按请求代号
 * 与当前目标（path + identity）双重判定，过期响应直接丢弃。
 */

import { usePluginStore } from "../src/store/pluginStore.js";

type Overview = {
  marketplaces: unknown[];
  availablePlugins: unknown[];
  installedPlugins: unknown[];
  capability: null;
};

function deferredOverview() {
  let settle!: (value: Overview) => void;
  const promise = new Promise<Overview>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

const overviewOf = (name: string): Overview => ({
  marketplaces: [{ name }],
  availablePlugins: [],
  installedPlugins: [],
  capability: null,
});

const serviceReturning = (promise: Promise<Overview>) => ({ getOverview: () => promise }) as never;

test("过时的概览响应不得覆盖当前工作区（切工作区后才返回）", async () => {
  const store = usePluginStore;
  store.getState().resetWorkspaceContext();
  const slowA = deferredOverview();
  const fastB = deferredOverview();

  const pendingA = store.getState().initialize("/workspace-a", serviceReturning(slowA.promise));
  const pendingB = store.getState().initialize("/workspace-b", serviceReturning(fastB.promise));

  fastB.settle(overviewOf("from-b"));
  await pendingB;
  slowA.settle(overviewOf("from-a"));
  await pendingA;

  assert.equal(store.getState().workspacePath, "/workspace-b");
  assert.deepEqual(store.getState().marketplaces, [{ name: "from-b" }]);
});

test("同路径不同主机的过期响应同样被丢弃（identity 参与判定）", async () => {
  const store = usePluginStore;
  store.getState().resetWorkspaceContext();
  const slowHost = deferredOverview();
  const fastHost = deferredOverview();

  const pendingHost1 = store
    .getState()
    .initialize("/same-path", serviceReturning(slowHost.promise), "ssh://host-1");
  const pendingHost2 = store
    .getState()
    .initialize("/same-path", serviceReturning(fastHost.promise), "ssh://host-2");

  fastHost.settle(overviewOf("host-2"));
  await pendingHost2;
  slowHost.settle(overviewOf("host-1"));
  await pendingHost1;

  assert.equal(store.getState().workspaceIdentity, "ssh://host-2");
  assert.deepEqual(store.getState().marketplaces, [{ name: "host-2" }]);
});

test("清空工作区上下文后，在途概览不得把清单填回来", async () => {
  const store = usePluginStore;
  store.getState().resetWorkspaceContext();
  const slow = deferredOverview();

  const pending = store.getState().initialize("/workspace-a", serviceReturning(slow.promise));
  store.getState().resetWorkspaceContext();
  slow.settle(overviewOf("from-a"));
  await pending;

  assert.equal(store.getState().workspacePath, null);
  assert.deepEqual(store.getState().marketplaces, []);
});

test("过期请求的失败不污染当前工作区的错误态", async () => {
  const store = usePluginStore;
  store.getState().resetWorkspaceContext();
  let failSlow!: (error: Error) => void;
  const failing = new Promise<Overview>((_resolve, reject) => {
    failSlow = reject;
  });
  const fast = deferredOverview();

  const pendingA = store.getState().initialize("/workspace-a", serviceReturning(failing));
  const pendingB = store.getState().initialize("/workspace-b", serviceReturning(fast.promise));

  fast.settle(overviewOf("from-b"));
  await pendingB;
  failSlow(new Error("stale-host-failure"));
  await pendingA;

  assert.equal(store.getState().workspacePath, "/workspace-b");
  assert.equal(store.getState().error, null);
  assert.deepEqual(store.getState().marketplaces, [{ name: "from-b" }]);
});
