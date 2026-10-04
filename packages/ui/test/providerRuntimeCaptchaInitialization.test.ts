import assert from "node:assert/strict";
import test from "node:test";
import {
  CAPTCHA_INITIALIZATION_TIMEOUT_FAILURE_REASON,
  CAPTCHA_INITIALIZATION_TIMEOUT_MESSAGE,
  CAPTCHA_INITIALIZATION_TIMEOUT_REASON,
} from "../src/settings/manualClaimCaptchaPage.js";
import {
  solveCaptchaInBrowser,
  solveCaptchaInWebview,
} from "../src/v4/providerRuntimeCaptchaSolver.js";

/**
 * 官方 3.14.4「验证码初始化显式超时 + 分类」移植的回归测试。
 *
 * 背景（.reverse/99-v3144/UPDATE-ANALYSIS.md §2.3 C1/C2）：官方 3.14.4 给渲染层验证码
 * 子系统新增 initialization_drain 排空、initialization_timeout 分类与显式超时文案
 * 「Captcha initialization timed out. Please restart the app or reload the page and try again.」，
 * 取代「初始化卡死时挂起到通用超时」。CE 的对应实现是给三段既有初始化等待
 * （宿主页方法就绪 / SDK 入口就绪 / Web 主世界 SDK 加载）加独立失败分类：
 * ManualClaimCaptchaFailureStage 的 initialization 阶段 + 上面的官方文案。
 *
 * 本文件钉三件事：
 * 1. 三段初始化等待超时后都得到 initialization 分类 + 官方文案（不是 verify 的裸错误，
 *    也不是 sdk_load 的「查网络」指引）；
 * 2. 快速失败（script error / 入口缺失）仍归 sdk_load 且保留原始原因 —— 卡死与失败
 *    是两类动作，不能合并；
 * 3. 成功路径不变：初始化正常完成时行为与之前完全一致。
 *
 * 运行：cd packages/ui && node --import tsx --test test/providerRuntimeCaptchaInitialization.test.ts
 */

const CONFIG = {
  enabled: true,
  prefix: "no8xfe",
  sceneId: "11xygtvd",
  region: "cn",
} as const;

const VALID_VERIFY_PARAM = Buffer.from(
  JSON.stringify({
    certifyId: "wQPXHYxvn9",
    sceneId: "11xygtvd",
    isSign: true,
    securityToken:
      "6oOo7e72nA61uVLiZVKiLYqF1m9rOno3vEIPJKiA7KLxCJqb1UBwRpl4p7EcFTgdg4FhpqbWG11Ub8Ds9/14ByXk1aghHbPw5LiOHyMnbpUSMXkpeBaVeiER57eiVa",
  }),
).toString("base64");

const GUARD_MESSAGE =
  "The WebView must be attached to the DOM and the dom-ready event emitted before this method can be called.";

/** 与真实时序同构的伪 webview：方法永远不可用（attach/dom-ready 一直没完成）。 */
function createNeverReadyWebview() {
  return {
    executeJavaScript(_code: string, _userGesture?: boolean): Promise<unknown> {
      throw new Error(GUARD_MESSAGE);
    },
  };
}

/** 方法可用、但 SDK 入口永远不就绪的伪 webview。 */
function createSdkNeverReadyWebview() {
  return {
    executeJavaScript(code: string, _userGesture?: boolean): Promise<unknown> {
      if (code === "void 0") return Promise.resolve(undefined);
      return Promise.resolve(false);
    },
  };
}

/** 可用且 SDK 就绪的伪 webview（成功路径回归用）。 */
function createReadyWebview() {
  return {
    executeJavaScript(code: string, _userGesture?: boolean): Promise<unknown> {
      if (code === "void 0") return Promise.resolve(undefined);
      if (code.startsWith("typeof window.initAliyunCaptcha")) return Promise.resolve(true);
      return Promise.resolve({
        kind: "success",
        verifyParam: VALID_VERIFY_PARAM,
        region: "cn",
      });
    },
  };
}

test("官方文案与分类 token 逐字对齐 3.14.4（分类前缀 + 可操作动作）", () => {
  assert.equal(CAPTCHA_INITIALIZATION_TIMEOUT_REASON, "initialization_timeout");
  assert.equal(
    CAPTCHA_INITIALIZATION_TIMEOUT_MESSAGE,
    "Captcha initialization timed out. Please restart the app or reload the page and try again.",
  );
  // reason = 分类 token + 官方文案：机器可 grep 的前缀 + 用户可读的动作。
  assert.ok(
    CAPTCHA_INITIALIZATION_TIMEOUT_FAILURE_REASON.startsWith(
      CAPTCHA_INITIALIZATION_TIMEOUT_REASON + ": ",
    ),
  );
  assert.ok(
    CAPTCHA_INITIALIZATION_TIMEOUT_FAILURE_REASON.includes(CAPTCHA_INITIALIZATION_TIMEOUT_MESSAGE),
  );
});

test("G1 桌面：宿主页方法一直不可用 → initialization 分类 + 官方文案（不是 verify 裸错误）", async () => {
  const message = await solveCaptchaInWebview({
    element: createNeverReadyWebview(),
    config: CONFIG,
    timeoutMs: 60_000,
    // 注入小上限：单测不必等 30s 真超时；生产默认仍是 WEBVIEW_READY_TIMEOUT_MS。
    webviewReadyTimeoutMs: 250,
  });
  assert.deepEqual(message, {
    kind: "fail",
    stage: "initialization",
    reason: CAPTCHA_INITIALIZATION_TIMEOUT_FAILURE_REASON,
  });
});

test("ensureHostPageReady 抛错时也被收敛为 initialization（不裸抛给编排器）", async () => {
  const message = await solveCaptchaInWebview({
    element: createReadyWebview(),
    config: CONFIG,
    timeoutMs: 60_000,
    ensureHostPageReady: async () => {
      throw new Error("custom host page failure");
    },
  });
  assert.deepEqual(message, {
    kind: "fail",
    stage: "initialization",
    reason: CAPTCHA_INITIALIZATION_TIMEOUT_FAILURE_REASON,
  });
});

test("G2 桌面：SDK 入口一直不就绪 → initialization 分类（此前是 sdk_load，动作不对）", async () => {
  const message = await solveCaptchaInWebview({
    element: createSdkNeverReadyWebview(),
    config: CONFIG,
    timeoutMs: 60_000,
    sdkReadyTimeoutMs: 300,
  });
  assert.deepEqual(message, {
    kind: "fail",
    stage: "initialization",
    reason: CAPTCHA_INITIALIZATION_TIMEOUT_FAILURE_REASON,
  });
});

test("G5 成功路径回归：桌面初始化正常完成时结果与之前完全一致", async () => {
  const message = await solveCaptchaInWebview({
    element: createReadyWebview(),
    config: CONFIG,
    timeoutMs: 1_000,
  });
  assert.equal(message?.kind, "success");
  assert.equal((message as { verifyParam: string }).verifyParam, VALID_VERIFY_PARAM);
});

test("G3 Web：SDK 加载超时 → initialization 分类 + 官方文案（卡死与失败分开）", async () => {
  const doc = createFakeDocument({ sdkEntry: undefined });
  const message = await solveCaptchaInBrowser({
    config: CONFIG,
    timeoutMs: 60_000,
    doc,
    sdkLoadTimeoutMs: 250,
    evaluate: () => Promise.resolve(undefined),
  });
  assert.deepEqual(message, {
    kind: "fail",
    stage: "initialization",
    reason: CAPTCHA_INITIALIZATION_TIMEOUT_FAILURE_REASON,
  });
});

test("G3 Web：script 加载失败（快速失败）→ sdk_load + 原始原因（动作是查网络，不是重启）", async () => {
  const doc = createFakeDocument({ sdkEntry: undefined });
  // 必须在 promise 挂起期间触发 error：solveCaptchaInBrowser 内部已同步注册好监听，
  // 但要等它的 await 让出控制权后事件才能真正到达 —— 先拿 promise，再点火，最后 await。
  const messagePromise = solveCaptchaInBrowser({
    config: CONFIG,
    timeoutMs: 60_000,
    doc,
    evaluate: () => Promise.resolve(undefined),
  });
  doc.fireScriptError();
  const message = await messagePromise;
  assert.deepEqual(message, {
    kind: "fail",
    stage: "sdk_load",
    reason: "Failed to load AliyunCaptcha script",
  });
});

test("Web：script 加载完成但入口缺失 → sdk_load + 原始原因", async () => {
  const doc = createFakeDocument({ sdkEntry: undefined });
  const messagePromise = solveCaptchaInBrowser({
    config: CONFIG,
    timeoutMs: 60_000,
    doc,
    evaluate: () => Promise.resolve(undefined),
  });
  doc.fireScriptLoad();
  const message = await messagePromise;
  assert.deepEqual(message, {
    kind: "fail",
    stage: "sdk_load",
    reason: "AliyunCaptcha script loaded but window.initAliyunCaptcha is missing",
  });
});

test("G5 成功路径回归：Web 初始化正常完成时结果与之前完全一致", async () => {
  const doc = createFakeDocument({ sdkEntry: () => undefined });
  const message = await solveCaptchaInBrowser({
    config: CONFIG,
    timeoutMs: 1_000,
    doc,
    evaluate: () =>
      Promise.resolve({
        kind: "success",
        verifyParam: VALID_VERIFY_PARAM,
        region: "cn",
      }),
  });
  assert.equal(message?.kind, "success");
  assert.equal((message as { verifyParam: string }).verifyParam, VALID_VERIFY_PARAM);
});

/**
 * 伪 Document 暴露的测试钩子：在 promise 挂起期间手动触发 script 的 load / error。
 */
type FakeDocument = Document & {
  fireScriptLoad(): void;
  fireScriptError(): void;
};

/**
 * 伪 Document：只实现求解路径用到的最小表面（元素创建 / body+head 追加 / defaultView）。
 *
 * 用 as unknown as FakeDocument 而不是实现整个 Document 接口：ui 包测试不引入 jsdom，
 * 此前 packages/ui 的测试一律用最小伪造对象 + 受控注入（见 manualClaimCaptcha.test.ts 的
 * webview 判据测试）；这里只需要 ensureAliyunCaptchaHostElements 与
 * ensureAliyunCaptchaSdkLoaded 两条路径的可控表面。
 */
function createFakeDocument(options: { sdkEntry: (() => void) | undefined }) {
  const win: Record<string, unknown> = {};
  if (options.sdkEntry) {
    win.initAliyunCaptcha = options.sdkEntry;
  }
  const listeners: Record<string, Array<() => void>> = {};
  const script = {
    src: "",
    async: false,
    addEventListener(event: string, handler: () => void) {
      (listeners[event] ??= []).push(handler);
    },
    removeEventListener(_event: string, _handler: () => void) {
      // ensureAliyunCaptchaSdkLoaded 结算时会移除监听；测试不依赖调用次数，留空即可。
    },
  };
  // ensureAliyunCaptchaHostElements 会给容器/按钮调 setAttribute 与设 type/id；
  // script 之外的标签给一个最小的通用元素即可。
  const genericElement = {
    id: "",
    type: "",
    setAttribute(_name: string, _value: string) {},
  };
  const doc = {
    defaultView: win,
    getElementById: () => null,
    createElement: (tag: string) => (tag === "script" ? script : genericElement),
    head: { appendChild: () => script },
    body: { appendChild: () => undefined },
    fireScriptLoad() {
      for (const handler of listeners.load ?? []) handler();
    },
    fireScriptError() {
      for (const handler of listeners.error ?? []) handler();
    },
  };
  return doc as unknown as FakeDocument;
}
