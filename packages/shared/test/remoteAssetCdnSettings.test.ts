import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsPatchSchema, appSettingsSchema } from "../src/validationAppSettings.js";

/**
 * 「自定义远程资产 CDN 地址」在 AppSettings（`setting.json`）层的**保存往返**测试（task-20）。
 *
 * 为什么在这一层测：`settingService.update` 用 `appSettingsPatchSchema` 校验 patch、读盘用
 * `appSettingsSchema`（`packages/services/src/setting/settingService.ts:301` 与 `:147`）。
 * 这条链是设置的**唯一持久化入口**，也是唯一能拦住「手改 setting.json 写入非法值」的地方 ——
 * 而它必须**报错**而不是静默丢弃：静默丢弃会让用户以为设置生效，实际仍走默认 CDN。
 *
 * 运行：cd packages/shared && node --import tsx --test test/remoteAssetCdnSettings.test.ts
 */

const VALID = "https://cdn.eidolonmachine.xyz";

test("保存往返：合法值经 patch 校验后原样落盘，再读回来仍在", () => {
  const patched = appSettingsPatchSchema.parse({ remoteAssetCdnBaseUrl: VALID });
  assert.equal(patched.remoteAssetCdnBaseUrl, VALID);

  const readBack = appSettingsSchema.parse({ remoteAssetCdnBaseUrl: VALID });
  assert.equal(readBack.remoteAssetCdnBaseUrl, VALID);
});

test("归一化在两端一致：尾部斜杠被去掉（读盘路径与设置页保存路径共用一份实现）", () => {
  const fromPatch = appSettingsPatchSchema.parse({ remoteAssetCdnBaseUrl: `${VALID}/` });
  assert.equal(fromPatch.remoteAssetCdnBaseUrl, VALID);
  const fromFile = appSettingsSchema.parse({ remoteAssetCdnBaseUrl: `${VALID}//` });
  assert.equal(fromFile.remoteAssetCdnBaseUrl, VALID);
});

test("清空设置：空串是合法的「用默认」，落成空串而不是被拒", () => {
  const patched = appSettingsPatchSchema.parse({ remoteAssetCdnBaseUrl: "" });
  assert.equal(patched.remoteAssetCdnBaseUrl, "");
});

test("非法值被**明确拒绝**（不是静默丢弃）", () => {
  for (const invalid of [
    "ftp://host",
    "host/assets",
    "https://host/a?x=1",
    "https://my-host#frag",
  ]) {
    assert.equal(
      appSettingsPatchSchema.safeParse({ remoteAssetCdnBaseUrl: invalid }).success,
      false,
      `${invalid} 必须被拒`,
    );
  }
});

test("未设置该键 ⇒ 不产生显式值（老配置零迁移，不写看起来像用户选过的字段）", () => {
  const parsed = appSettingsSchema.parse({});
  assert.equal("remoteAssetCdnBaseUrl" in parsed, false);
});
