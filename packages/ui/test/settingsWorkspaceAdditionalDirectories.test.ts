import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isSettingsSectionEnabled, resolveSettingsSection } from "../src/lib/settingsNavigation.js";
import { SETTINGS_SECTIONS, createSettingsPageConfig } from "../src/settings/settingsPageConfig.js";

/**
 * 「工作区附加目录」分区的接线回归（X16）。
 *
 * 新增 `SettingsSectionId` 要同时改四处（类型白名单 / 侧边栏注册表 / 平台过滤 / 渲染分支链），
 * 漏任何一处都有特定失败形态 ——「侧边栏里有、点开空白」就是 UI 说谎。前两处能在运行时断言，
 * 第三处见平台的可见性断言，第四处只能做源码级断言（`SettingsPage` 依赖整棵设置树与 RPC，
 * 在 node:test 里导入它会拉起整套 React/服务图；断言读的是那条三元链的源码文本，删掉分支即红）。
 *
 * 这条链的失效形态是静默的：分区看起来能配，实际 createSession 没带 additionalDirectories，
 * 用户只有在会话里发现环境信息缺目录才会察觉。所以注入点由
 * `packages/shared/test/workspaceAdditionalDirectories.test.ts` 钉 payload 形状，
 * 这里钉「设置页真的把这个分区渲染出来」。
 *
 * 运行：cd packages/ui && node --import tsx --test test/settingsWorkspaceAdditionalDirectories.test.ts
 */

const here = dirname(fileURLToPath(import.meta.url));
const settingsPageSource = readFileSync(resolve(here, "../src/SettingsPage.tsx"), "utf8");

test("分区已注册，且属基础设置组（与「项目搜索范围」同组）", () => {
  const section = SETTINGS_SECTIONS.find(
    (candidate) => candidate.id === "workspaceAdditionalDirectories",
  );
  assert.ok(section, "SETTINGS_SECTIONS 里缺少 workspaceAdditionalDirectories 分区");
  assert.equal(section.groupId, "basics");
  assert.equal(section.titleId, "settings.workspaceAdditionalDirectories.title");
});

test("分区不在隐藏集里，否则用户点不到", () => {
  assert.equal(isSettingsSectionEnabled("workspaceAdditionalDirectories"), true);
  assert.equal(
    resolveSettingsSection("workspaceAdditionalDirectories"),
    "workspaceAdditionalDirectories",
  );
});

test("桌面与 Web 都可见：v4 createSession 两侧都走同一份 SessionPane 注入链", () => {
  for (const config of [
    createSettingsPageConfig({}),
    createSettingsPageConfig({ isDesktop: true }),
  ]) {
    assert.ok(
      config.settingsSections.some((section) => section.id === "workspaceAdditionalDirectories"),
      "该分区对两个平台都应可见",
    );
  }
});

test("★渲染分支存在且指向 WorkspaceAdditionalDirectoriesSection（防「能点开但内容是空的」）", () => {
  assert.match(
    settingsPageSource,
    /import \{ WorkspaceAdditionalDirectoriesSection \} from "@\/settings\/WorkspaceAdditionalDirectoriesSection\.js";/u,
    "缺少 WorkspaceAdditionalDirectoriesSection 的 import",
  );
  assert.match(
    settingsPageSource,
    /activeSection === "workspaceAdditionalDirectories" \? \([\s\S]{0,400}<WorkspaceAdditionalDirectoriesSection/u,
    "SettingsPage.tsx 的三元渲染链里缺少该分支 —— 分区会显示为空白",
  );
});

test("★中枢「运行」与「提升为全局」的 createSession 也带附加目录", () => {
  for (const relative of [
    "src/settings/saved-workflows/useSavedWorkflowLauncher.ts",
    "src/settings/saved-workflows/useSavedWorkflowPromote.ts",
  ]) {
    const source = readFileSync(resolve(here, "..", relative), "utf8");
    assert.match(
      source,
      /buildAdditionalDirectoriesPayload\(/u,
      `${relative} 缺少附加目录 payload`,
    );
    assert.match(
      source,
      /resolveWorkspaceAdditionalDirectories\(/u,
      `${relative} 没从设置里取该工作区的目录`,
    );
  }
});

test("★添加目录优先走多选，平台不支持时退回单选", () => {
  const sectionSource = readFileSync(
    resolve(here, "../src/settings/WorkspaceAdditionalDirectoriesSection.tsx"),
    "utf8",
  );
  assert.match(sectionSource, /platform\.selectDirectories/u, "未接平台多选");
  assert.match(sectionSource, /platform\.selectDirectory\(\)/u, "缺少单选回退");
});
