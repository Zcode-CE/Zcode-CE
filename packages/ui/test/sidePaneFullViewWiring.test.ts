import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isSidePaneFullViewShortcut } from "../src/app-shell/sidePaneFullViewShortcut.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

/**
 * 侧边面板全视图（CE 版）的接线护栏。
 *
 * 关键不变量：对话区不卸载（面板 absolute 覆盖而不是替换 DOM）、退出后布局状态不变、
 * 快捷键只在桌面注册。真实布局/快捷键需要桌面人工验证，这里钉实现形状。
 */

const here = dirname(fileURLToPath(import.meta.url));
const layoutSource = readFileSync(
  resolve(here, "../src/app-shell/WorkspaceShellLayout.tsx"),
  "utf8",
);
const panelSource = readFileSync(
  resolve(here, "../src/app-shell/AnimatedSidePanePanel.tsx"),
  "utf8",
);

test("全视图由面板覆盖实现，不替换对话 DOM", () => {
  assert.match(layoutSource, /isSidePaneFullView/u);
  assert.match(panelSource, /fullView && "!absolute !inset-0/u);
  assert.match(panelSource, /fullView && "hidden"/u);
});

test("关闭面板或切换 owner 会退出全视图", () => {
  assert.match(layoutSource, /if \(!isSidePaneVisible\) setIsSidePaneFullView\(false\)/u);
  assert.match(layoutSource, /sidePaneFullViewOwnerRef/u);
});

test("快捷键只在桌面注册，按钮与文案在位", () => {
  assert.match(layoutSource, /if \(!isDesktop\) return;/u);
  assert.match(layoutSource, /isSidePaneFullViewShortcut\(event\)/u);
  assert.match(layoutSource, /onToggleFullView=\{toggleSidePaneFullView\}/u);
  assert.match(panelSource, /sidePane\.fullView\.enter/u);
  assert.ok("sidePane.fullView.enter" in zhCN);
  assert.ok("sidePane.fullView.exit" in enUS);
});

test("快捷键判定：⌘/Ctrl+Shift+F，排除 Alt、无 Shift 与非 F 键", () => {
  const base = { key: "f", metaKey: false, ctrlKey: false, shiftKey: true, altKey: false };
  assert.equal(isSidePaneFullViewShortcut({ ...base, metaKey: true }), true);
  assert.equal(isSidePaneFullViewShortcut({ ...base, ctrlKey: true }), true);
  assert.equal(isSidePaneFullViewShortcut({ ...base, key: "F", ctrlKey: true }), true);
  assert.equal(isSidePaneFullViewShortcut({ ...base, ctrlKey: true, altKey: true }), false);
  assert.equal(isSidePaneFullViewShortcut({ ...base, ctrlKey: true, shiftKey: false }), false);
  assert.equal(isSidePaneFullViewShortcut({ ...base, ctrlKey: true, key: "g" }), false);
  assert.equal(isSidePaneFullViewShortcut({ ...base }), false);
});
