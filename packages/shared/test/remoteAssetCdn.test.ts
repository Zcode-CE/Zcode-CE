import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeRemoteAssetCdnBaseUrl,
  REMOTE_ASSET_CDN_BASE_URL_ERROR_CODES,
} from "../src/remoteAssetCdn.js";

/**
 * 自定义远程资产 CDN 基址的**归一化契约**测试。
 *
 * 为什么必须钉住：这个值有三个入口（设置页、手改 `setting.json`、运行期 env）而只有一处消费点，
 * 归一化一旦分叉就会出现「设置页显示 A、实际请求 B」。这里锁四件事：
 *   1. `empty` 与 `invalid` 是**两种不同结果** —— 前者是"用默认"，后者必须报错（不静默降级，
 *      否则用户以为设置生效、实际走默认 CDN，失败现象是取资源 404，无从排查）；
 *   2. 尾部斜杠被去掉，**子路径必须保留**（自建发布点常挂在 `/assets` 下）；
 *   3. 不追加任何路径段/版本号（这个值就是发布根）；
 *   4. 错误用稳定码表达，调用方不解析错误文本。
 *
 * 运行：cd packages/shared && node --import tsx --test test/remoteAssetCdn.test.ts
 */

test("留空 / 只有空白 / 未设置 ⇒ empty（= 用默认），不是错误", () => {
  for (const value of [undefined, null, "", "   ", "\n"]) {
    const normalized = normalizeRemoteAssetCdnBaseUrl(value);
    assert.equal(normalized.kind, "empty", `${JSON.stringify(value)} 应视为未设置`);
  }
});

test("合格的发布根按字面值保留，只去掉尾部斜杠", () => {
  const cases: Array<[string, string]> = [
    ["https://cdn.eidolonmachine.xyz", "https://cdn.eidolonmachine.xyz"],
    ["https://cdn.eidolonmachine.xyz/", "https://cdn.eidolonmachine.xyz"],
    ["https://cdn.eidolonmachine.xyz///", "https://cdn.eidolonmachine.xyz"],
    // 子路径必须保留：自建发布点常挂在 `/assets` 下。
    ["https://my-host/assets", "https://my-host/assets"],
    ["https://my-host/assets/", "https://my-host/assets"],
    // 内网 http + 端口：允许（自托管/内网是明确支持的场景）。
    ["http://127.0.0.1:8110", "http://127.0.0.1:8110"],
    ["  https://my-host/assets  ", "https://my-host/assets"],
  ];
  for (const [input, expected] of cases) {
    const normalized = normalizeRemoteAssetCdnBaseUrl(input);
    assert.equal(normalized.kind, "valid", `${input} 应合法`);
    assert.equal(normalized.kind === "valid" ? normalized.value : undefined, expected);
  }
});

test("非法值给稳定错误码，绝不静默降级成 empty", () => {
  const cases: Array<[unknown, string]> = [
    ["ftp://my-host", REMOTE_ASSET_CDN_BASE_URL_ERROR_CODES.protocol],
    ["my-host/assets", REMOTE_ASSET_CDN_BASE_URL_ERROR_CODES.protocol],
    ["cdn.eidolonmachine.xyz", REMOTE_ASSET_CDN_BASE_URL_ERROR_CODES.protocol],
    ["https://", REMOTE_ASSET_CDN_BASE_URL_ERROR_CODES.unparsable],
    ["https://my-host/assets?token=1", REMOTE_ASSET_CDN_BASE_URL_ERROR_CODES.queryOrFragment],
    ["https://my-host/assets#top", REMOTE_ASSET_CDN_BASE_URL_ERROR_CODES.queryOrFragment],
    [42, REMOTE_ASSET_CDN_BASE_URL_ERROR_CODES.notString],
    [{ url: "https://my-host" }, REMOTE_ASSET_CDN_BASE_URL_ERROR_CODES.notString],
    [`https://my-host/${"a".repeat(2100)}`, REMOTE_ASSET_CDN_BASE_URL_ERROR_CODES.tooLong],
  ];
  for (const [input, expectedCode] of cases) {
    const normalized = normalizeRemoteAssetCdnBaseUrl(input);
    assert.equal(
      normalized.kind,
      "invalid",
      `${JSON.stringify(input).slice(0, 60)} 必须被判非法（静默降级会让用户以为生效）`,
    );
    assert.equal(normalized.kind === "invalid" ? normalized.code : undefined, expectedCode);
  }
});

test("不追加版本号/路径段（这是发布根，不是完整资源目录）", () => {
  const normalized = normalizeRemoteAssetCdnBaseUrl("https://my-host/assets");
  const value = normalized.kind === "valid" ? normalized.value : "";
  assert.equal(value.includes("releases"), false);
  assert.equal(value.includes("zcode/electron"), false);
  assert.equal(/\(\d+\.\d+\.\d+/.test(value), false);
});
