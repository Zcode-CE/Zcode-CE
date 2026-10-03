import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  solveCaptchaInWebview,
  waitForWebviewMethodsReady,
} from "../src/v4/providerRuntimeCaptchaSolver.js";
import { RESOLVE_VERIFY_PARAM_SOURCE } from "../src/settings/manualClaimCaptchaPage.js";

/**
 * start-plan 桌面 webview 求解的时序回归测试（issue #3）。
 *
 * 背景：v4 桌面求解路径曾用无 src 的 `<webview>` + 立即 `loadURL(url)` 的形态。
 * Electron 守卫在 attach 与首次 dom-ready 之前调用 webview 方法会同步抛
 * "The WebView must be attached to the DOM and the dom-ready event emitted
 * before this method can be called."（docs/api/webview-tag.md「The webview element
 * must be loaded before using the methods」），该错误经编排器收敛成
 * `verify: The WebView must be attached...` 应答给 host，agent 侧因此
 * `headersApplied:false` → `RuntimeHeadersRefreshError` → `reason=unknown retryable=false`。
 *
 * 修复形态与 claim 平面（ManualClaimCaptchaDialog）逐字一致：宿主页由
 * `<webview src={hostUrl}>` 承载，求解侧只等待就绪、绝不调用 loadURL。
 *
 * 运行：cd packages/ui && node --import tsx --test test/providerRuntimeCaptchaWebviewTiming.test.ts
 */

const GUARD_MESSAGE =
  "The WebView must be attached to the DOM and the dom-ready event emitted before this method can be called.";

const VALID_VERIFY_PARAM = Buffer.from(
  JSON.stringify({
    certifyId: "wQPXHYxvn9",
    sceneId: "11xygtvd",
    isSign: true,
    securityToken:
      "6oOo7e72nA61uVLiZVKiLYF1m9rOno3vEIPJKiA7KLxCJqb1UBwRpl4p7EcFTgdg4FhpqbWG11Ub8Ds9/14ByXk1aghHbPw5LiOHyMnbpUSMXKpeBaVeiZER57eiVa",
  }),
).toString("base64");

const CONFIG = {
  enabled: true,
  prefix: "no8xfe",
  sceneId: "11xygtvd",
  region: "cn",
};

/** 与真实时序同构的伪 webview：先同步抛 Electron 守卫错误若干次，再变为可用。 */
function createFakeWebview(options: { guardErrors: number; sdkDelay: number }) {
  let guardLeft = options.guardErrors;
  let sdkChecks = 0;
  let sdkReady = false;
  let loadUrlCalls = 0;
  const element = {
    loadURL(_url: string): Promise<void> {
      loadUrlCalls++;
      return Promise.resolve();
    },
    executeJavaScript(code: string, _userGesture?: boolean): Promise<unknown> {
      // Electron 守卫：attach/dom-ready 之前的方法调用同步抛错。
      // 用同步 throw（而非 reject）复现真实形态——promise.catch 接不住同步 throw。
      if (guardLeft > 0) {
        guardLeft--;
        throw new Error(GUARD_MESSAGE);
      }
      // 方法就绪后的探测：`void 0` 是 waitForWebviewMethodsReady 的就绪探针。
      if (code === "void 0") {
        return Promise.resolve(undefined);
      }
      if (code.startsWith("typeof window.initAliyunCaptcha")) {
        sdkChecks++;
        if (sdkChecks <= options.sdkDelay && !sdkReady) {
          return Promise.resolve(false);
        }
        sdkReady = true;
        return Promise.resolve(true);
      }
      // 求解脚本：真实环境由宿主页 SDK 产出，这里直接回一个合法求解结果。
      assert.ok(code.includes(RESOLVE_VERIFY_PARAM_SOURCE), "求解脚本应逐字同源于 claim 平面");
      return Promise.resolve({
        kind: "success",
        verifyParam: VALID_VERIFY_PARAM,
        region: "cn",
      });
    },
    get loadUrlCallCount(): number {
      return loadUrlCalls;
    },
  };
  return element;
}

test("webview 未就绪期间的方法守卫错误被等待吸收，不传播为求解失败（issue #3 核心回归）", async () => {
  const webview = createFakeWebview({
    // 前 3 次方法调用处于 attach/dom-ready 之前：真实环境里这是 solver 进入的时刻。
    guardErrors: 3,
    // SDK 在宿主页 script 异步加载：前 2 次探测时还没就绪。
    sdkDelay: 2,
  });
  const message = await solveCaptchaInWebview({
    element: webview,
    config: CONFIG,
    timeoutMs: 1_000,
  });
  assert.equal(message?.kind, "success");
  assert.equal((message as { verifyParam: string }).verifyParam, VALID_VERIFY_PARAM);
  assert.equal(webview.loadUrlCallCount, 0, "修复后不得再调用 loadURL");
});

test("ensureHostPageReady 注入点仍按宿主页 URL 被调用（默认实现只等待、不加载）", async () => {
  let receivedUrl: string | undefined;
  const webview = createFakeWebview({ guardErrors: 1, sdkDelay: 0 });
  const message = await solveCaptchaInWebview({
    element: webview,
    config: CONFIG,
    timeoutMs: 1_000,
    ensureHostPageReady: async (url) => {
      receivedUrl = url;
    },
  });
  assert.equal(message?.kind, "success");
  assert.ok(
    typeof receivedUrl === "string" && receivedUrl.startsWith("data:text/html;"),
    "注入实现应拿到宿主页 data: URL",
  );
  assert.equal(webview.loadUrlCallCount, 0);
});

test("方法一直不可用时快速失败（不悬挂到 180s 上限）", async () => {
  const execute = (): Promise<unknown> => {
    throw new Error(GUARD_MESSAGE);
  };
  await assert.rejects(
    () => waitForWebviewMethodsReady(execute, 400),
    /webview methods unavailable/,
    "超时必须抛可读错误，而不是静默悬挂",
  );
});

test("不支持的宿主（无 webviewTag）显式失败，不走必然失败的方法调用", async () => {
  const message = await solveCaptchaInWebview({
    element: {},
    config: CONFIG,
    timeoutMs: 1_000,
  });
  assert.deepEqual(message, { kind: "fail", stage: "unsupported", reason: "webview_unavailable" });
});

// ── 源码断言（防回退护栏，沿用 packages/ui/test 既有风格） ──

test("solver 默认路径不得再调用 loadURL（回退会把时序 bug 带回来）", () => {
  const source = readFileSync(
    new URL("../src/v4/providerRuntimeCaptchaSolver.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    !source.includes("target.loadURL"),
    "solveCaptchaInWebview 不得用 loadURL 加载宿主页——attach/dom-ready 之前调用会同步抛守卫错误（issue #3）",
  );
  // 宿主页必须由 src 承载、求解侧只等待：这是修复的形态判据。
  assert.ok(
    source.includes("waitForWebviewMethodsReady"),
    "必须有「等待 webview 方法可用」这一环，不能假设挂载即可调用",
  );
});

test("附件 webview 必须用 src 承载宿主页（Electron 在 attach 时自动读取加载）", () => {
  const source = readFileSync(
    new URL("../src/v4/ProviderRuntimeHeadersCaptchaAttachment.tsx", import.meta.url),
    "utf8",
  );
  const webviewTag = source.slice(source.indexOf("<webview"), source.indexOf("</webview>"));
  assert.ok(
    webviewTag.includes("src={hostUrl}"),
    "webview 必须带 src：宿主页（含 SDK script 标签）由 src 在 attach 时自动加载，求解侧只等待就绪",
  );
  assert.ok(
    source.includes("buildManualClaimCaptchaHostPageUrl"),
    "宿主页 URL 必须复用 claim 平面同一构造函数（求解逻辑逐字同源）",
  );
});
