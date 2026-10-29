import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsPatchSchema, appSettingsSchema } from "../src/validationAppSettings.js";
import { appToolSearchModeSchema } from "../src/toolSearch.js";

/**
 * F14 工具搜索模式在设置面的词表与缺席语义。
 *
 * 两处消费面必须同词表：AppSettings（用户选择）与 runtime preferences（Host 下发给 CLI）。
 * 这里钉住：四态合法、未知值拒绝、缺席不伪造默认值（老配置 = off）。
 */

test("四态合法，未知值被拒绝", () => {
  for (const mode of ["auto", "native", "local", "off"] as const) {
    assert.equal(appToolSearchModeSchema.parse(mode), mode);
  }
  assert.equal(appToolSearchModeSchema.safeParse("enabled").success, false);
});

test("老配置缺字段 ⇒ 解析结果不出现该键（缺席 = off）", () => {
  const parsed = appSettingsSchema.parse({});
  assert.equal("toolSearchMode" in parsed, false);
  assert.equal(JSON.stringify(parsed).includes("toolSearchMode"), false);
});

test("设置 patch 与读盘都接受四态，非法值在写入前被拒", () => {
  assert.equal(appSettingsPatchSchema.parse({ toolSearchMode: "local" }).toolSearchMode, "local");
  assert.equal(appSettingsSchema.parse({ toolSearchMode: "auto" }).toolSearchMode, "auto");
  assert.equal(appSettingsPatchSchema.safeParse({ toolSearchMode: "yes" }).success, false);
});
