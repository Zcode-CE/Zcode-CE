/**
 * macOS 自动更新可用性判定：纯函数判定矩阵 + 契约一致性。
 *
 * 钉的是「哪几种组合应跳过更新检查」这条规则本身。判定矩阵错了（比如误把 win/linux
 * 也跳过、或误把自托管 feed 跳过），会直接改变用户体验而非报错，只能靠测试钉住。
 *
 * 为什么不直接测 autoUpdater.ts：它顶部静态导入 electron / electron-updater，
 * node:test 里无法加载（desktop 包既有纪律，见 remoteAssetCdnSettingPriority.test.ts
 * 顶部注释）；接线层另有 electron 桩集成测试（autoUpdaterDarwinSkip.test.ts）。
 *
 * 运行：cd packages/desktop && node --import tsx --test test/autoUpdateDarwinAvailability.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { UpdateCheckResultPayload } from "@zcode/shared";
import { shouldSkipAutoUpdateCheckOnDarwinRelease } from "../src/main/autoUpdateAvailability.js";
import zhCN from "../../ui/src/i18n/locales/zh-CN.js";
import enUS from "../../ui/src/i18n/locales/en-US.js";

test("正向：darwin 正式包且无更新源覆盖 ⇒ 跳过更新检查", () => {
  assert.equal(
    shouldSkipAutoUpdateCheckOnDarwinRelease({
      platform: "darwin",
      isPackaged: true,
      updateFeedUrl: undefined,
    }),
    true,
  );
  // 空白串视为未配置（与 applyUpdateProvider 里 manifestUrl.trim() 的语义一致）。
  assert.equal(
    shouldSkipAutoUpdateCheckOnDarwinRelease({
      platform: "darwin",
      isPackaged: true,
      updateFeedUrl: "   ",
    }),
    true,
  );
  assert.equal(
    shouldSkipAutoUpdateCheckOnDarwinRelease({
      platform: "darwin",
      isPackaged: true,
      updateFeedUrl: null,
    }),
    true,
  );
});

test("豁免一：darwin 正式包配了更新源覆盖（自建 feed / 镜像） ⇒ 不跳过", () => {
  // 自托管 feed 是另一种部署形态，其 manifest 可能自行提供 macOS 包；
  // 任务要求保留该路径行为不变，不由本发行线的缺失反推禁用。
  assert.equal(
    shouldSkipAutoUpdateCheckOnDarwinRelease({
      platform: "darwin",
      isPackaged: true,
      updateFeedUrl: "https://updates.example/zcode/feed",
    }),
    false,
  );
});

test("豁免二：darwin 未打包（ZCODE_AUTO_UPDATE_DEV 本地验证链路） ⇒ 不跳过", () => {
  assert.equal(
    shouldSkipAutoUpdateCheckOnDarwinRelease({
      platform: "darwin",
      isPackaged: false,
      updateFeedUrl: undefined,
    }),
    false,
  );
});

test("豁免三：win/linux 正式包 ⇒ 一律不跳过（既有行为逐条不变）", () => {
  for (const platform of ["win32", "linux"] as const) {
    assert.equal(
      shouldSkipAutoUpdateCheckOnDarwinRelease({
        platform,
        isPackaged: true,
        updateFeedUrl: undefined,
      }),
      false,
    );
    assert.equal(
      shouldSkipAutoUpdateCheckOnDarwinRelease({
        platform,
        isPackaged: false,
        updateFeedUrl: undefined,
      }),
      false,
    );
  }
});

test("契约：unsupported-platform 是合法的 UpdateCheckResultPayload 结果", () => {
  const payload: UpdateCheckResultPayload = { kind: "unsupported-platform" };
  assert.equal(payload.kind, "unsupported-platform");
});

test("契约：两个 locale 都有 update.toast.unsupportedPlatform 且文案非空", () => {
  // 缺键会让 toast 直接展示原始键名；空串文案等于没有提示。
  assert.equal(typeof zhCN["update.toast.unsupportedPlatform"], "string");
  assert.ok((zhCN["update.toast.unsupportedPlatform"] ?? "").length > 0);
  assert.equal(typeof enUS["update.toast.unsupportedPlatform"], "string");
  assert.ok((enUS["update.toast.unsupportedPlatform"] ?? "").length > 0);
});

test("文案护栏：确定性不支持，不含「失败 / 重试」措辞（否则会读成检查失败请重试）", () => {
  const zh = zhCN["update.toast.unsupportedPlatform"];
  const en = enUS["update.toast.unsupportedPlatform"];
  assert.ok(zh && !zh.includes("失败") && !zh.includes("重试"), `zh 文案误用失败/重试: ${zh}`);
  assert.ok(en && !/failed/i.test(en) && !/retry/i.test(en), `en 文案误用 failed/retry: ${en}`);
  // 必须给出可操作引导（手动下载）。
  assert.ok(zh?.includes("GitHub Releases"), "zh 文案必须引导到 GitHub Releases");
  assert.ok(en?.includes("GitHub Releases"), "en 文案必须引导到 GitHub Releases");
});
