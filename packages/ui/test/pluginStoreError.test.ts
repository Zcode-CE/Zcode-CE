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
