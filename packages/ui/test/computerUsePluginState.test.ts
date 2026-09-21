import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  resolveComputerUseAvailability,
  resolveComputerUsePluginState,
  shouldDisableComputerUseToggle,
} from "@/settings/computerUseAvailability.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import enUS from "../src/i18n/locales/en-US.js";

/**
 * 「启用电脑控制」总开关的状态与文案回归。
 *
 * 背景：插件补进包之前，设置页把「store 还没加载完」和「插件根本不在构建里」都折叠成
 * enabled=false，用户点开关只能拿到 Plugin not found: computer-use@zcode-plugins-official。
 * 这里锁死三件不能回归的性质：
 * 1. 前置状态优先于启用态（加载中 / 不可用不得显示成「未启用」）；
 * 2. 前置状态下开关不可点（不能让用户点出没有出路的失败）；
 * 3. 接线与文案必须真实存在（源码断言 + 中英 key 同时存在），并与 Linux 实验性提示解耦。
 *
 * 运行：cd packages/ui && node --import tsx --test test/computerUsePluginState.test.ts
 */

function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

const NEW_KEYS = [
  "settings.computerUse.toggleDescriptionUnavailable",
  "settings.computerUse.pluginState.loadingTitle",
  "settings.computerUse.pluginState.loadingDescription",
  "settings.computerUse.pluginState.loadFailedTitle",
  "settings.computerUse.pluginState.loadFailedDescription",
  "settings.computerUse.pluginState.unavailableTitle",
  "settings.computerUse.pluginState.unavailableDescription",
  "settings.computerUse.pluginState.enableFailedTitle",
  "settings.computerUse.pluginState.enableFailedFallback",
  "settings.computerUse.pluginState.enabled",
  "settings.computerUse.pluginState.disabled",
  "settings.computerUse.pluginState.loading",
  "settings.computerUse.pluginState.loadFailed",
  "settings.computerUse.pluginState.unavailable",
  "settings.computerUse.pluginState.retry",
  "settings.computerUse.pluginState.retrying",
];

test("插件条目存在时按启用态给出 enabled / disabled", () => {
  assert.equal(
    resolveComputerUsePluginState({ loaded: true, loadFailed: false, present: true, enabled: true })
      .kind,
    "enabled",
  );
  assert.equal(
    resolveComputerUsePluginState({
      loaded: true,
      loadFailed: false,
      present: true,
      enabled: false,
    }).kind,
    "disabled",
  );
});

test("store 还没加载完时是 loading，不得显示成「未启用」", () => {
  // 旧实现 cuaPlugin?.enabled ?? false 在这里会给出「未启用」——这正是本次修复的状态。
  assert.deepEqual(
    resolveComputerUsePluginState({
      loaded: false,
      loadFailed: false,
      present: false,
      enabled: false,
    }),
    { kind: "loading" },
  );
});

test("加载完成但列表里没有该插件时是不可用，成因是 not-found", () => {
  assert.deepEqual(
    resolveComputerUsePluginState({
      loaded: true,
      loadFailed: false,
      present: false,
      enabled: false,
    }),
    { kind: "unavailable", reason: "not-found" },
  );
});

test("列表加载失败时是不可用且可重试，成因是 load-failed", () => {
  assert.deepEqual(
    resolveComputerUsePluginState({
      loaded: true,
      loadFailed: true,
      present: false,
      enabled: false,
    }),
    { kind: "unavailable", reason: "load-failed" },
  );
});

test("已经拿到插件条目时，一次无关的列表加载失败不能把可用插件判成不可用", () => {
  assert.equal(
    resolveComputerUsePluginState({ loaded: true, loadFailed: true, present: true, enabled: true })
      .kind,
    "enabled",
  );
  assert.equal(
    resolveComputerUsePluginState({
      loaded: false,
      loadFailed: false,
      present: true,
      enabled: true,
    }).kind,
    "enabled",
  );
});

test("加载中与不可用都必须禁用总开关（点下去必然失败）", () => {
  assert.equal(shouldDisableComputerUseToggle("loading"), true);
  assert.equal(shouldDisableComputerUseToggle("unavailable"), true);
  assert.equal(shouldDisableComputerUseToggle("disabled"), false);
  assert.equal(shouldDisableComputerUseToggle("enabled"), false);
});

test("总开关把状态机与禁用判据直接接到 Switch 上", () => {
  const source = readSource("src/settings/ComputerUseSection.tsx");
  assert.match(source, /const pluginState = resolveComputerUsePluginState\(\{/);
  assert.match(
    source,
    /const pluginToggleDisabled =\s*\n?\s*shouldDisableComputerUseToggle\(pluginState\.kind\)/,
  );
  assert.match(source, /data-testid="cua-settings-enabled-switch"/);
  // detail 显示同一份 pluginState，圆点与文案同源，不会出现颜色与文字互相矛盾。
  assert.match(source, /data-cua-plugin-state=\{pluginState\.kind\}/);
  assert.match(source, /\{intl\.formatMessage\(\{ id: pluginStateLabelId \}\)\}/);
});

test("加载中 / 不可用 / 启用失败三种状态都有独立文案卡片，且启用失败带重试入口", () => {
  const source = readSource("src/settings/ComputerUseSection.tsx");
  assert.match(source, /pluginState\.kind === "loading" \? \(/);
  assert.match(source, /pluginState\.kind === "unavailable" \? \(/);
  assert.match(source, /settings\.computerUse\.pluginState\.retry/);
  assert.match(source, /role="alert"/);
});

test("输入框按钮开关在插件不可用时同样不可点", () => {
  const source = readSource("src/settings/ComputerUseSection.tsx");
  assert.match(
    source,
    /disabled=\{\s*\n?\s*composerEntrySaving \|\|\s*\n?\s*!cuaEnabled \|\|\s*\n?\s*shouldDisableComputerUseToggle\(pluginState\.kind\)\s*\n?\s*\}\s*\n?\s*onCheckedChange/,
  );
});

test("新增文案在中英两侧都存在（缺 key 会渲染成 key 原文）", () => {
  for (const key of NEW_KEYS) {
    assert.ok(key in zhCN, `zh-CN 缺少文案: ${key}`);
    assert.ok(key in enUS, `en-US 缺少文案: ${key}`);
  }
});

test("Linux 实验性提示只按平台判定，Windows / macOS 不显示", () => {
  const linux = resolveComputerUseAvailability({
    isDesktop: true,
    isWindowsDesktop: false,
    isMacDesktop: false,
  });
  assert.equal(linux.kind, "local-linux");
  assert.equal(linux.experimental, true);
  const windows = resolveComputerUseAvailability({
    isDesktop: true,
    isWindowsDesktop: true,
    isMacDesktop: false,
  });
  assert.equal(windows.kind, "local-windows");
  assert.equal(windows.experimental, undefined);
  const mac = resolveComputerUseAvailability({ isDesktop: true, isMacDesktop: true });
  assert.equal(mac.kind, "local-macos");
  assert.equal(mac.experimental, undefined);
  // 远端 / web 仍走另一条分支，不受平台判定影响。
  assert.equal(
    resolveComputerUseAvailability({ isDesktop: true, remoteTarget: null }).kind,
    "local-linux",
  );
});

test("实验性提示的渲染条件仍是 local-linux（不按 isWindowsDesktop 反向误判）", () => {
  const source = readSource("src/settings/ComputerUseSection.tsx");
  assert.match(
    source,
    /supportsLocalLinuxWorkspace \? \(\s*\n?\s*<div className="rounded-lg border border-warning\/40/,
  );
  assert.match(source, /const supportsLocalLinuxWorkspace = availability\.kind === "local-linux"/);
});
