import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { readPermissionRuleScopes } from "../src/lib/permissionRuleScopes.js";

/**
 * 权限弹窗「批准范围可视化」测试（task-73）。
 *
 * 回归的是安全审计 task-72 的 P1 兜底缺口：原实现按 `endsWith(":*")` 过滤，
 * 把**无 ruleContent 的规则**（匹配一切）静默丢弃 —— 用户在没有任何范围提示的情况下
 * 批准了整个工具的任意命令。
 *
 * 运行：cd packages/ui && node --import tsx --test test/permissionRuleScopes.test.ts
 */

const allowUpdate = (rules: Array<{ toolName: string; ruleContent?: string }>) => ({
  behavior: "allow" as const,
  rules,
  type: "addRules" as const,
});

test("无 ruleContent 的规则被显式展示为「任意命令」，不再被静默丢弃", () => {
  const scopes = readPermissionRuleScopes({
    response: { permissionUpdates: [allowUpdate([{ toolName: "Bash" }])] },
  });
  assert.equal(scopes.length, 1);
  assert.equal(scopes[0]?.kind, "any");
  assert.equal(scopes[0]?.toolName, "Bash");
});

test("无 ruleContent 的规则对任何工具都展示（不是 Bash 专属）", () => {
  const scopes = readPermissionRuleScopes({
    response: { permissionUpdates: [allowUpdate([{ toolName: "Agent" }])] },
  });
  assert.equal(scopes.length, 1);
  assert.equal(scopes[0]?.kind, "any");
  assert.equal(scopes[0]?.toolName, "Agent");
});

test("前缀规则仍按前缀展示（行为不变）", () => {
  const scopes = readPermissionRuleScopes({
    response: {
      permissionUpdates: [allowUpdate([{ ruleContent: "npm install:*", toolName: "Bash" }])],
    },
  });
  assert.equal(scopes.length, 1);
  assert.equal(scopes[0]?.kind, "prefix");
  assert.equal(scopes[0]?.display, "npm install …");
});

test("精确规则也展示 —— 用户要看出「记住」的到底是哪一条", () => {
  const scopes = readPermissionRuleScopes({
    response: {
      permissionUpdates: [allowUpdate([{ ruleContent: "rm -rf /tmp/x", toolName: "Bash" }])],
    },
  });
  assert.equal(scopes.length, 1);
  assert.equal(scopes[0]?.kind, "exact");
  assert.equal(scopes[0]?.display, "rm -rf /tmp/x …");
});

test("非 Bash 的带内容规则不展示（避免噪声，行为不变）", () => {
  const scopes = readPermissionRuleScopes({
    response: { permissionUpdates: [allowUpdate([{ ruleContent: "/tmp/x", toolName: "Write" }])] },
  });
  assert.deepEqual(scopes, []);
});

test("deny 更新不参与展示", () => {
  const scopes = readPermissionRuleScopes({
    response: {
      permissionUpdates: [
        { behavior: "deny", rules: [{ ruleContent: "rm:*", toolName: "Bash" }], type: "addRules" },
      ],
    },
  });
  assert.deepEqual(scopes, []);
});

test("没有 permissionUpdates 时返回空数组（不抛异常）", () => {
  assert.deepEqual(readPermissionRuleScopes({ response: undefined }), []);
  assert.deepEqual(readPermissionRuleScopes({}), []);
});

test("最多展示 5 条，避免撑爆弹窗", () => {
  const scopes = readPermissionRuleScopes({
    response: {
      permissionUpdates: [
        allowUpdate(
          Array.from({ length: 8 }, (_, index) => ({
            ruleContent: `cmd${index}:*`,
            toolName: "Bash",
          })),
        ),
      ],
    },
  });
  assert.equal(scopes.length, 5);
});

test("超长规则截断并标记 truncated", () => {
  const long = "a".repeat(400);
  const scopes = readPermissionRuleScopes({
    response: {
      permissionUpdates: [allowUpdate([{ ruleContent: `${long}:*`, toolName: "Bash" }])],
    },
  });
  assert.equal(scopes[0]?.truncated, true);
  assert.ok((scopes[0]?.display.length ?? 0) <= 160);
});

/**
 * 切到「完全访问」（yolo）前的风险确认（上游 3.17.2 X19 的 UI 侧）。
 *
 * 回归形态：切档时不告知风险就放宽权限；或者告知了但仍能用 Enter / 默认焦点
 * 一路确认过去 —— 这等于确认框不存在。这里钉住四处结构约束：
 * ① 只有「切入 yolo」才弹（已经在 yolo 时不重复打扰）；
 * ② Enter 兜底对该弹窗失效；
 * ③ 确认按钮必须勾选风险告知后才可用，默认焦点落在「取消」；
 * ④ 组合器（模式菜单与快捷键循环）都走带确认的入口，不能绕过。
 */
const here = dirname(fileURLToPath(import.meta.url));
const readSource = (relative: string) => readFileSync(resolve(here, relative), "utf8");
const dialogSource = readSource("../src/ConfirmDialog.tsx");
const confirmHookSource = readSource("../src/hooks/useConfirmDialog.ts");
const composerModeSource = readSource("../src/v4/composer/V4ComposerModeControls.tsx");

const YOLO_KEYS = [
  "mode.yoloConfirmation.title",
  "mode.yoloConfirmation.description",
  "mode.yoloConfirmation.files",
  "mode.yoloConfirmation.files.description",
  "mode.yoloConfirmation.commands",
  "mode.yoloConfirmation.commands.description",
  "mode.yoloConfirmation.network",
  "mode.yoloConfirmation.network.description",
  "mode.yoloConfirmation.risk",
  "mode.yoloConfirmation.acknowledgement",
  "mode.yoloConfirmation.confirm",
] as const;

test("只在切入完全访问时弹确认，已在完全访问不重复打扰", () => {
  assert.match(confirmHookSource, /nextMode !== "yolo" \|\| currentMode === "yolo"/);
  assert.match(confirmHookSource, /presentation: "yolo-confirmation"/);
});

test("确认弹窗接管风险告知：Enter 兜底失效、必须勾选、默认焦点在取消", () => {
  assert.match(dialogSource, /presentation === "yolo-confirmation"/);
  assert.match(dialogSource, /if \(!open \|\| isYoloConfirmation\)/);
  assert.match(dialogSource, /disabled=\{!checkboxChecked\}/);
  assert.match(dialogSource, /cancelRef\.current\?\.focus\(\)/);
  // 勾选只属于本次请求：关闭后重开不能沿用上次的风险确认。
  assert.match(dialogSource, /checkboxSelection\.request === displayedRequest/);
});

test("模式菜单与快捷键循环都走带确认的切换入口", () => {
  assert.match(composerModeSource, /useYoloModeConfirmation\(/);
  assert.match(composerModeSource, /onValueChange=\{requestSwitchMode\}/);
  assert.match(composerModeSource, /if \(next\) requestSwitchMode\(next\);/);
});

test("风险告知文案两份字典齐全", () => {
  for (const key of YOLO_KEYS) {
    assert.ok(key in zhCN, "zh-CN 缺少 " + key);
    assert.ok(key in enUS, "en-US 缺少 " + key);
  }
});
