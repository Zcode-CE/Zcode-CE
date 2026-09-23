import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isSettingsSectionEnabled, resolveSettingsSection } from "../src/lib/settingsNavigation.js";
import { SETTINGS_SECTIONS, createSettingsPageConfig } from "../src/settings/settingsPageConfig.js";

/**
 * 「远程资产」（自定义 CDN 发布根）分区的接线回归测试。
 *
 * 新增一个 `SettingsSectionId` 要同时改**四处**，漏任何一处都有特定失败形态
 * （与 toolPolicy 那次是同一类缺陷 —— 「侧边栏里有、点开空白」就是 UI 说谎）：
 *   1. `settingsNavigation.ts` 的类型白名单 + 运行时校验函数 → 漏改：跳转意图被静默丢弃（tsc 只兜类型那半）
 *   2. `settingsPageConfig.ts` 的注册表 → 漏改：侧边栏里没有入口
 *   3. `settingsPageConfig.ts` 的平台过滤 → 漏改：Web 上出现一个点了没用的开关
 *   4. `SettingsPage.tsx` 的三元渲染链 → 漏改：**分区能点开但内容是空的**（本测试专门钉这一条）
 *
 * 第 4 条只能做源码级断言：`SettingsPage` 依赖整棵设置树与 RPC，在 node:test 里导入它会拉起
 * 整套 React/服务图。**但这不是"没验证"**：断言读的就是那条链的源码文本，
 * 把分支删掉会红（已做反向验证，见报告）。
 *
 * 运行：cd packages/ui && node --import tsx --test test/settingsRemoteAssetsSection.test.ts
 */

const here = dirname(fileURLToPath(import.meta.url));
const settingsPageSource = readFileSync(resolve(here, "../src/SettingsPage.tsx"), "utf8");

test("remoteAssets 分区已注册，且属基础设置组", () => {
  const section = SETTINGS_SECTIONS.find((candidate) => candidate.id === "remoteAssets");
  assert.ok(section, "SETTINGS_SECTIONS 里缺少 remoteAssets 分区");
  assert.equal(section.groupId, "basics");
  assert.equal(section.titleId, "settings.remoteAssets.title");
});

test("remoteAssets 不在隐藏集里，否则用户点不到", () => {
  assert.equal(isSettingsSectionEnabled("remoteAssets"), true);
  assert.equal(resolveSettingsSection("remoteAssets"), "remoteAssets");
});

test("★桌面可见、Web 隐藏：这条链只有 desktop main 消费，Web 上显示就是 UI 说谎", () => {
  const desktop = createSettingsPageConfig({ isDesktop: true });
  assert.ok(
    desktop.settingsSections.some((section) => section.id === "remoteAssets"),
    "桌面端必须能看到 remoteAssets 分区",
  );
  const web = createSettingsPageConfig({});
  assert.equal(
    web.settingsSections.some((section) => section.id === "remoteAssets"),
    false,
    "Web 端不得出现 remoteAssets 分区（该设置对 Web 完全不生效）",
  );
});

test("★渲染分支存在且指向 RemoteAssetsSetting（防「分区能点开但内容是空的」）", () => {
  assert.match(
    settingsPageSource,
    /activeSection === "remoteAssets" \? \(/u,
    "SettingsPage.tsx 的三元渲染链里缺少 remoteAssets 分支 —— 分区会显示为空白",
  );
  assert.match(
    settingsPageSource,
    /import \{ RemoteAssetsSetting \} from "@\/settings\/RemoteAssetsSetting\.js";/u,
    "缺少 RemoteAssetsSetting 的 import",
  );
  // 分支体必须真的渲染该组件，而不只是有一个同名的空分支。
  assert.match(
    settingsPageSource,
    /activeSection === "remoteAssets"[\s\S]{0,600}<RemoteAssetsSetting \/>/u,
  );
});

test("隐藏集仍按原样生效，未被本次改动意外放开", () => {
  for (const hidden of ["automations", "plugins", "workspaceFileSearch"] as const) {
    assert.equal(isSettingsSectionEnabled(hidden), false, `${hidden} 应保持隐藏`);
  }
  assert.equal(resolveSettingsSection("plugins"), "plugin");
});
