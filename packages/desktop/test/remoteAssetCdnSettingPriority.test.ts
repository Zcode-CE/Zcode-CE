import assert from "node:assert/strict";
import test from "node:test";
import { ZCODE_ENV, ZCODE_VERSION } from "@zcode/shared";
import { resolveRemoteCdnBaseUrlsWithOverrides } from "../src/main/remoteCdnOverrides.js";

/**
 * 「自定义远程资产 CDN 地址」的**优先级**测试（task-20）。
 *
 * 钉的是 `remoteCdnOverrides.ts` 的组合逻辑，它被 `desktopRuntimeEnv.ts` 在真实消费链上调用
 * （`resolveRemoteAssetDirs → resolveRemoteCdnBaseUrls`）。这里不导入 `desktopRuntimeEnv.ts`：
 * 那个模块会拉进 `electron`，在 node:test 里必然失败 —— 而"优先级对不对"恰恰是最容易错、
 * 又最该有可执行测试的一段，所以它被单独抽成纯模块。
 *
 * 为什么专门测（Lead 指出的接线陷阱）：env 未设置时若把 `options.overrideBaseUrl` 直接覆盖
 * 而不是 `??` 合并，设置页填了也**完全不生效且不报错** —— 用户以为切了自己的发布点，实际仍打默认 CDN。
 *   ① env 未设 + 设置已设 ⇒ 用设置   ② env 已设 + 设置已设 ⇒ 用 env
 *   ③ 都没设 ⇒ 构建期 define / 官方默认
 *
 * 运行：cd packages/desktop && node --import tsx --test test/remoteAssetCdnSettingPriority.test.ts
 */

const DEFINE_KEY = "__ZCODE_CDN_BASE_URL__";
const SETTING_ROOT = "https://settings.example/assets";
const ENV_ROOT = "https://env.example/assets";
const DEFINE_ROOT = "https://define.example/assets";
const OFFICIAL_DEFAULT = `https://cdn-zcode.z.ai/zcode/electron/releases/${ZCODE_VERSION}`;

function withDefine(value: string | undefined, body: () => void): void {
  const hadDefine = DEFINE_KEY in globalThis;
  const previousDefine = (globalThis as Record<string, unknown>)[DEFINE_KEY];
  try {
    if (value === undefined) delete (globalThis as Record<string, unknown>)[DEFINE_KEY];
    else (globalThis as Record<string, unknown>)[DEFINE_KEY] = value;
    body();
  } finally {
    if (!hadDefine) delete (globalThis as Record<string, unknown>)[DEFINE_KEY];
    else (globalThis as Record<string, unknown>)[DEFINE_KEY] = previousDefine;
  }
}

function resolve(overrides: {
  envBaseUrl?: string | undefined;
  settingsBaseUrl?: string | undefined;
}): string[] {
  return resolveRemoteCdnBaseUrlsWithOverrides({ version: ZCODE_VERSION }, overrides, ZCODE_ENV);
}

test("① env 未设 + 设置已设 ⇒ 用设置值（接线陷阱的正面）", () => {
  withDefine(DEFINE_ROOT, () => {
    assert.deepEqual(resolve({ envBaseUrl: undefined, settingsBaseUrl: SETTING_ROOT }), [
      SETTING_ROOT,
    ]);
  });
});

test("② env 已设 + 设置已设 ⇒ 用 env（env 优先级最高）", () => {
  withDefine(DEFINE_ROOT, () => {
    assert.deepEqual(resolve({ envBaseUrl: ENV_ROOT, settingsBaseUrl: SETTING_ROOT }), [ENV_ROOT]);
  });
});

test("③ 都没设 ⇒ 回落构建期 define", () => {
  withDefine(DEFINE_ROOT, () => {
    assert.deepEqual(resolve({}), [DEFINE_ROOT]);
  });
});

test("③ 都没设且无 define ⇒ 回落官方默认（含它自己的前缀路径）", () => {
  withDefine(undefined, () => {
    assert.deepEqual(resolve({}), [OFFICIAL_DEFAULT]);
  });
});

test("设置值为空串（用户选择用默认）⇒ 等同未设置", () => {
  withDefine(DEFINE_ROOT, () => {
    assert.deepEqual(resolve({ settingsBaseUrl: "" }), [DEFINE_ROOT]);
  });
});

test("设置值非法（手改 setting.json）⇒ 回落默认行为，不把非法串当基址", () => {
  withDefine(DEFINE_ROOT, () => {
    assert.deepEqual(resolve({ settingsBaseUrl: "ftp://bad.example" }), [DEFINE_ROOT]);
  });
});

test("设置值尾部斜杠被归一化（设置页显示与请求用同一个值）", () => {
  withDefine(DEFINE_ROOT, () => {
    assert.deepEqual(resolve({ settingsBaseUrl: `${SETTING_ROOT}/` }), [SETTING_ROOT]);
  });
});

test("调用方显式传入 overrideBaseUrl 时，设置值优先于它（env 仍最高）", () => {
  withDefine(DEFINE_ROOT, () => {
    const options = { version: ZCODE_VERSION, overrideBaseUrl: "https://caller.example/assets" };
    assert.deepEqual(
      resolveRemoteCdnBaseUrlsWithOverrides(options, { settingsBaseUrl: SETTING_ROOT }, ZCODE_ENV),
      [SETTING_ROOT],
    );
    assert.deepEqual(resolveRemoteCdnBaseUrlsWithOverrides(options, {}, ZCODE_ENV), [
      "https://caller.example/assets",
    ]);
  });
});
