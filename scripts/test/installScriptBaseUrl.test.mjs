import assert from "node:assert/strict";
import { test } from "node:test";

import { installScriptSource } from "../zcode-distribution/installer.mjs";

/**
 * install.sh 基址的护栏。
 *
 * 为什么需要它：npm 发布链路要在"没有配置 ZCODE_DIST_BASE_URL"时也能构建包体，
 * 于是引入了一个占位基址（scripts/build-zcode.mjs 的 npmPackagingPlaceholderBaseUrl）。
 * 这个占位必须**只**出现在"确实没配真实地址"的那份 install.sh 里；
 * 一旦它泄漏进正常构建，用户拿到的 install.sh 会指向一个永不解析的域名 —— 而构建不会报错。
 */

const REAL = "https://cdn.example.com/zcode/";
const PLACEHOLDER = "https://zcode-dist.invalid/zcode/";

test("未传占位基址时，install.sh 不含任何占位内容", () => {
  const source = installScriptSource(REAL);
  assert.ok(source.includes(`BASE_URL="\${ZCODE_DIST_BASE_URL:-${REAL}}"`));
  assert.ok(!source.includes("PLACEHOLDER_BASE_URL"), "占位变量泄漏进正常 install.sh");
  assert.ok(!source.includes("zcode-dist.invalid"));
  assert.ok(!source.includes("was generated without a real download base URL"));
});

test("传了占位基址但实际用的是真实基址时，不产出占位内容", () => {
  const source = installScriptSource(REAL, { placeholderBaseUrl: PLACEHOLDER });
  assert.ok(!source.includes("PLACEHOLDER_BASE_URL"));
  assert.ok(!source.includes("zcode-dist.invalid"));
});

test("使用占位基址时，install.sh 显式告警且基址就是占位值", () => {
  const source = installScriptSource(PLACEHOLDER, { placeholderBaseUrl: PLACEHOLDER });
  assert.ok(source.includes(`BASE_URL="\${ZCODE_DIST_BASE_URL:-${PLACEHOLDER}}"`));
  assert.ok(source.includes(`PLACEHOLDER_BASE_URL="${PLACEHOLDER}"`));
  assert.ok(source.includes("was generated without a real download base URL"));
  // 告警必须打到 stderr（>&2），否则会被脚本正常输出吞掉。
  assert.ok(source.includes('Set ZCODE_DIST_BASE_URL to your hosting URL." >&2'));
});

test("运行期仍可用 ZCODE_DIST_BASE_URL 覆盖占位基址", () => {
  const source = installScriptSource(PLACEHOLDER, { placeholderBaseUrl: PLACEHOLDER });
  // 第一行赋值必须保留 ${ZCODE_DIST_BASE_URL:-...} 形态：
  // 去掉它等于把占位地址变成硬编码，用户无法覆盖。
  assert.ok(source.includes('BASE_URL="${ZCODE_DIST_BASE_URL:-'));
});
