import assert from "node:assert/strict";
import test from "node:test";
import { PlatformChannels } from "../src/channels.js";

/**
 * F1 地基：平台层新增目录多选通道。
 *
 * 单测只钉住「通道名独立、不会被覆写」这一层；真正的对话框行为由 desktop main 的
 * ipcMain handler 提供，UI 侧在 settingsWorkspaceAdditionalDirectories.test 里钉接线。
 */

test("目录多选是独立通道，不与单选取值相同", () => {
  assert.equal(PlatformChannels.SelectDirectories, "zcode:select-directories");
  assert.notEqual(PlatformChannels.SelectDirectories, PlatformChannels.SelectDirectory);
  assert.ok(PlatformChannels.SelectDirectory.length > 0);
});
