import assert from "node:assert/strict";
import test from "node:test";
import { resolveLocalePreferenceFromSettings } from "../src/i18n/IntlProvider.js";

/**
 * 远控（setting service 为准）下的语言偏好解析。
 *
 * 远控端没有桌面系统语言的解析通道：Web 侧既没有传 resolveSystemLocale，服务层也没有暴露
 * 宿主 locale。因此把 "system" 原样传下去只会退回到手机浏览器的 navigator 语言——表现就是
 * 「桌面中文、手机英文」。「跟随系统」在远控下的准确含义是跟随桌面的系统语言，也就是桌面侧
 * 已经解析好的 locale。
 */
test("远控以桌面设置为准：桌面「跟随系统」时用桌面已解析的 locale", () => {
  assert.equal(
    resolveLocalePreferenceFromSettings({
      storedPreference: "en-US",
      settingsLocale: "zh-CN",
      settingsLocalePreference: "system",
      preferSettingServiceLocale: true,
    }),
    "zh-CN",
  );
});

test("远控忽略本机残留偏好（手机浏览器里存过的 en-US 不生效）", () => {
  assert.equal(
    resolveLocalePreferenceFromSettings({
      storedPreference: "en-US",
      settingsLocale: "zh-CN",
      settingsLocalePreference: "zh-CN",
      preferSettingServiceLocale: true,
    }),
    "zh-CN",
  );
});

test("桌面没有 locale 时才回退到桌面的偏好 / 本机偏好", () => {
  assert.equal(
    resolveLocalePreferenceFromSettings({
      storedPreference: "en-US",
      settingsLocale: undefined,
      settingsLocalePreference: "system",
      preferSettingServiceLocale: true,
    }),
    "system",
  );
  assert.equal(
    resolveLocalePreferenceFromSettings({
      storedPreference: "en-US",
      settingsLocale: undefined,
      settingsLocalePreference: undefined,
      preferSettingServiceLocale: true,
    }),
    "en-US",
  );
});

test("本机形态：本机偏好优先，其余按 settings / locale 回退", () => {
  assert.equal(
    resolveLocalePreferenceFromSettings({
      storedPreference: "en-US",
      settingsLocale: "zh-CN",
      settingsLocalePreference: "zh-CN",
      preferSettingServiceLocale: false,
    }),
    "en-US",
  );
  assert.equal(
    resolveLocalePreferenceFromSettings({
      storedPreference: null,
      settingsLocale: "zh-CN",
      settingsLocalePreference: "system",
      preferSettingServiceLocale: false,
    }),
    "system",
  );
});
