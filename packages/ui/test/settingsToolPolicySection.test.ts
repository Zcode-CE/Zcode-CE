import assert from "node:assert/strict";
import test from "node:test";
import { isSettingsSectionEnabled, resolveSettingsSection } from "../src/lib/settingsNavigation.js";
import { SETTINGS_SECTIONS, createSettingsPageConfig } from "../src/settings/settingsPageConfig.js";

/**
 * 「工具与权限」分区的接线回归测试（task-73）。
 *
 * 新增 SettingsSectionId 必须同时改三处（类型白名单 / 隐藏集 / 渲染分支链），
 * 任何一处漏改都会表现为「分区在侧边栏里但点开空白」或「跳转意图被静默丢弃」。
 * 类型白名单由 tsc 兜底，这里锁死**运行时可观测**的两处：隐藏集与侧边栏注册表。
 *
 * 运行：cd packages/ui && node --import tsx --test test/settingsToolPolicySection.test.ts
 */

test("toolPolicy 分区已注册进设置页分区表，且属于 Agent 能力组", () => {
  const section = SETTINGS_SECTIONS.find((candidate) => candidate.id === "toolPolicy");
  assert.ok(section, "SETTINGS_SECTIONS 里缺少 toolPolicy 分区");
  assert.equal(section.groupId, "agentCapabilities");
  assert.equal(section.titleId, "settings.toolPolicy.title");
});

test("toolPolicy 分区不在隐藏集里，否则用户点不到", () => {
  assert.equal(isSettingsSectionEnabled("toolPolicy"), true);
  assert.equal(resolveSettingsSection("toolPolicy"), "toolPolicy");
});

test("toolPolicy 在桌面与 Web 都可见（策略与平台无关）", () => {
  const web = createSettingsPageConfig({});
  assert.ok(web.settingsSections.some((section) => section.id === "toolPolicy"));
  const desktop = createSettingsPageConfig({ isDesktop: true });
  assert.ok(desktop.settingsSections.some((section) => section.id === "toolPolicy"));
});

test("隐藏集仍按原样生效，未被本次改动意外放开", () => {
  for (const hidden of ["automations", "plugins", "workspaceFileSearch"] as const) {
    assert.equal(isSettingsSectionEnabled(hidden), false, `${hidden} 应保持隐藏`);
  }
  assert.equal(resolveSettingsSection("plugins"), "plugin");
});
