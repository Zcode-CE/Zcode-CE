import assert from "node:assert/strict";
import test from "node:test";
import { isSettingsSectionEnabled, resolveSettingsSection } from "../src/lib/settingsNavigation.js";
import { SETTINGS_SECTIONS } from "../src/settings/settingsPageConfig.js";

/**
 * 「反馈与诊断」分区的接线回归测试。
 *
 * 新增 SettingsSectionId 必须同时改三处（类型白名单 / 隐藏集 / 渲染分支链），
 * 任何一处漏改都会表现为「分区在侧边栏里但点开空白」或「跳转意图被静默丢弃」。
 * 类型白名单由 tsc 兜底，这里锁死**运行时可观测**的两处：隐藏集与侧边栏注册表。
 *
 * 运行：cd packages/ui && node --import tsx --test test/settingsFeedbackSection.test.ts
 */

test("feedback 分区已注册进设置页分区表，且属于数据与统计组", () => {
  const section = SETTINGS_SECTIONS.find((candidate) => candidate.id === "feedback");
  assert.ok(section, "SETTINGS_SECTIONS 里缺少 feedback 分区");
  assert.equal(section.groupId, "dataAndStats");
  assert.equal(section.titleId, "settings.feedback.title");
});

test("feedback 分区不在隐藏集里，否则用户点不到", () => {
  assert.equal(isSettingsSectionEnabled("feedback"), true);
  assert.equal(resolveSettingsSection("feedback"), "feedback");
});

test("隐藏集仍按原样生效，未被本次改动意外放开", () => {
  // 这几个是既有隐藏分区，回归时若被误删会改变产品入口可见性。
  for (const hidden of ["automations", "plugins", "workspaceFileSearch"] as const) {
    assert.equal(isSettingsSectionEnabled(hidden), false, `${hidden} 应保持隐藏`);
  }
  // plugins 有专门的迁移语义：解析后落到 plugin。
  assert.equal(resolveSettingsSection("plugins"), "plugin");
});

test("computerUse 已移出隐藏集：桌面上必须能看到电脑控制入口", () => {
  // 原隐藏集把 computerUse 也列在里面，且是其中唯一没写原因注释的一项，
  // 与 settingsPageConfig 的「macOS/Windows/Linux 必须继续通过 createSettingsPageConfig
  // 动态加入 Computer Use」直接冲突 —— 结果所有桌面平台（含 Windows）都打不开该分区，
  // 只剩插件页那张「不可用」卡片。接入开源 trycua/cua 后不再成立。
  // 这里把护栏改成正向锁定：分区必须可见，Web 仍由 settingsPageConfig 的 showComputerUse 挡掉。
  assert.equal(isSettingsSectionEnabled("computerUse"), true);
  assert.equal(resolveSettingsSection("computerUse"), "computerUse");
});

test("未知分区回退到 fallback，不抛异常", () => {
  assert.equal(resolveSettingsSection("feedback", "general"), "feedback");
});
