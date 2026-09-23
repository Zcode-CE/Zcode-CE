import assert from "node:assert/strict";
import test from "node:test";
import { resolveRemoteCdnBaseUrls } from "../src/main/remoteCdn.js";

/**
 * 远程资产基址的**契约测试**。
 *
 * 为什么必须钉住：这条链路的回归现象是"用户装好安装包后连远程工作区失败"，而失败点在
 * 「取资源清单」这一步、报错是 manifest 404 —— 从用户视角看像网络问题，排障成本极高。
 * 这里锁两件事：
 *   1. 两个**自定义**旋钮（运行期 override、构建期 define/env）的值都是**发布根**，按字面值使用；
 *   2. 未设任何旋钮时回落到**官方默认值**，且官方默认值保留它自己的前缀路径。
 *
 * 2026-09-23：修正前构建期旋钮被当父目录并追加 `/zcode/electron/releases/<版本>`，
 * 与 docs/development/remote-workspace.md 的契约矛盾（自建发布根取不到资源）。把实现改回旧行为，本文件必红。
 */

const VERSION = "3.14.3-ce.2";
const OFFICIAL_DEFAULT_BASE = `https://cdn-zcode.z.ai/zcode/electron/releases/${VERSION}`;
const COMMUNITY_ROOT = "https://cdn.eidolonmachine.xyz";
const SELF_HOSTED_ROOT = "https://assets.example.internal/zcode-remote";

const DEFINE_KEY = "__ZCODE_CDN_BASE_URL__";

function withBaseUrlInputs(
  inputs: { envValue?: string; defineValue?: string },
  body: () => void,
): void {
  const previousEnv = process.env.ZCODE_CDN_BASE_URL;
  const hadDefine = DEFINE_KEY in globalThis;
  const previousDefine = (globalThis as Record<string, unknown>)[DEFINE_KEY];

  try {
    if (inputs.envValue === undefined) delete process.env.ZCODE_CDN_BASE_URL;
    else process.env.ZCODE_CDN_BASE_URL = inputs.envValue;

    if (inputs.defineValue === undefined)
      delete (globalThis as Record<string, unknown>)[DEFINE_KEY];
    else (globalThis as Record<string, unknown>)[DEFINE_KEY] = inputs.defineValue;

    body();
  } finally {
    if (previousEnv === undefined) delete process.env.ZCODE_CDN_BASE_URL;
    else process.env.ZCODE_CDN_BASE_URL = previousEnv;
    if (!hadDefine) delete (globalThis as Record<string, unknown>)[DEFINE_KEY];
    else (globalThis as Record<string, unknown>)[DEFINE_KEY] = previousDefine;
  }
}

test("未设任何旋钮 ⇒ 官方默认值，并保留官方自己的前缀路径", () => {
  withBaseUrlInputs({}, () => {
    assert.deepEqual(resolveRemoteCdnBaseUrls({ version: VERSION }), [OFFICIAL_DEFAULT_BASE]);
  });
});

test("构建期 define（社区 CDN 发布根）⇒ 按字面值使用，不再追加前缀", () => {
  withBaseUrlInputs({ defineValue: COMMUNITY_ROOT }, () => {
    assert.deepEqual(resolveRemoteCdnBaseUrls({ version: VERSION }), [COMMUNITY_ROOT]);
  });
});

test("运行期 env ⇒ 按字面值使用，且优先于构建期 define", () => {
  withBaseUrlInputs({ envValue: SELF_HOSTED_ROOT, defineValue: COMMUNITY_ROOT }, () => {
    assert.deepEqual(resolveRemoteCdnBaseUrls({ version: VERSION }), [SELF_HOSTED_ROOT]);
  });
});

test("overrideBaseUrl（运行期 ZCODE_REMOTE_ASSET_CDN_BASE_URL）优先级最高，且同样按字面值", () => {
  withBaseUrlInputs({ envValue: SELF_HOSTED_ROOT, defineValue: COMMUNITY_ROOT }, () => {
    assert.deepEqual(
      resolveRemoteCdnBaseUrls({ version: VERSION, overrideBaseUrl: COMMUNITY_ROOT }),
      [COMMUNITY_ROOT],
    );
  });
});

test("尾部斜杠被归一化，非 http(s) 取值直接失败", () => {
  withBaseUrlInputs({ defineValue: `${COMMUNITY_ROOT}/` }, () => {
    assert.deepEqual(resolveRemoteCdnBaseUrls({ version: VERSION }), [COMMUNITY_ROOT]);
  });
  withBaseUrlInputs({ defineValue: "ftp://cdn.example" }, () => {
    assert.throws(() => resolveRemoteCdnBaseUrls({ version: VERSION }), /http or https/u);
  });
});
