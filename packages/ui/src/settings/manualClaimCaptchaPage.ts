/**
 * claim 平面（周末 / 体验套餐手动领取）的验证码求解载体：宿主页 + 注入脚本。
 *
 * ## 为什么需要这个模块
 *
 * 官方客户端的验证码求解在 **renderer 的真实 DOM** 里完成：真实 DOM + 从 CDN 加载的
 * `AliyunCaptcha.js`，由用户完成交互挑战，`success` 回调里拿到 `verifyParam`；
 * host 只负责把 `X-Aliyun-Captcha-Verify-Param` / `-Region` 注入 claim 请求。
 * CE 的 host 侧已经完成（`claimManualPlan({ planId, captcha })`），缺的是 renderer 侧。
 *
 * CE 的 renderer 是 App 自己的 React 页面，直接在里面加载第三方 CDN 脚本会把
 * 一个外部脚本拉进应用主世界的执行环境。因此这里把官方形态搬进 **Electron `<webview>`**
 * ——它就是一个真实 Chromium 渲染环境（真实 DOM、真实 WebGL、真实指纹），
 * 同时与 App 主世界隔离（`sandbox: true` + `contextIsolation: true`，
 * 见 `desktopWindowChrome.ts` 的 `will-attach-webview`）。用户交互求解在 webview 内完成，
 * `verifyParam` 回传给 App，再随 claim 请求发出。
 *
 * ## 回传通道：`executeJavaScript` 的返回值，不用 preload
 *
 * 注入脚本返回一个 Promise，`webview.executeJavaScript(script, true)` 会等待它并
 * 把 resolve 值交给 renderer。这样不需要新增 guest preload、不需要改 `tsup.config.ts`
 * 的入口表、也不需要改 main 进程 —— 宿主页走 `data:` URL，已被
 * `isAllowedEmbeddedBrowserUrl` 的白名单放行（`data:` 在允许协议集合内）。
 *
 * ## 为什么不移植 zcode-api 的自动求解器
 *
 * 参考实现是 happy-dom + pe-VM 补丁的 2400+ 行求解器，强依赖 happy-dom 内部结构，
 * 且要持续对抗阿里云的 pe 版本轮换。CE 不引入 happy-dom，走真实 webview +
 * 真实用户交互 —— 这同时也是风控期望的形态（自动求解才是在和风控对抗）。
 *
 * ## 本文件的职责边界
 *
 * 这里只放**纯函数**（宿主页 HTML、注入脚本字符串、结果归一化），不碰 React 与 Electron，
 * 以便用 `node:test` 直接断言。DOM 事件绑定与 webview 生命周期在
 * `ManualClaimCaptchaDialog.tsx`。
 */

import type { ManualClaimCaptchaConfig, ManualClaimCaptchaSolution } from "@zcode/shared";

/**
 * 阿里云验证码 SDK 的 CDN 地址。
 *
 * 与官方客户端使用的地址一致（官方 renderer 逐字使用该 URL，见 P3-claim §3.1 实测）。
 * 该 SDK 自己会按 `region`/`prefix` 再去拉 FeiLin 指纹与 pe 引擎，
 * 因此这里只固定入口脚本，不缓存也不改写后续请求。
 */
export const ALIYUN_CAPTCHA_SDK_URL =
  "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";

/** 宿主页里 captcha 容器与隐藏按钮的 DOM id，与注入脚本的 element/button 参数一一对应。 */
export const MANUAL_CLAIM_CAPTCHA_ELEMENT_ID = "zcode-manual-claim-captcha";
export const MANUAL_CLAIM_CAPTCHA_BUTTON_ID = "zcode-manual-claim-captcha-button";

/** 求解结果消息：成功带 verifyParam，失败带可归因的阶段与原因。 */
export type ManualClaimCaptchaMessage =
  | { kind: "success"; verifyParam: string; region: string }
  | { kind: "fail"; stage: ManualClaimCaptchaFailureStage; reason: string };

/**
 * 失败阶段。UI 需要区分「SDK 没加载出来」「SDK 初始化失败」「用户/风控拒绝了挑战」，
 * 因为三者的可操作动作完全不同（检查网络 / 检查配置 / 重新验证）。
 */
export type ManualClaimCaptchaFailureStage =
  | "sdk_load"
  | "init"
  | "start"
  | "verify"
  | "timeout"
  /**
   * 当前宿主没有可用的 `<webview>`（手机 Web / 普通 Web 构建没有 Electron webviewTag）。
   * 与 "sdk_load" 区分开：这一档重试没有意义，UI 必须给出「改用桌面版」这类不同指引。
   */
  | "unsupported";

/**
 * 构造加载 `AliyunCaptcha.js` 的宿主页 HTML。
 *
 * 关键点（对齐官方 renderer 的四步形态，见 P3-claim §6.3）：
 *   1. 页面里挂 `#cap` 容器与隐藏 button —— SDK 的 `element`/`button` 参数必须有真实节点；
 *   2. 用 `<script src>` 从 CDN 加载 SDK，`window.initAliyunCaptcha` 是加载完成的判据；
 *   3. `AliyunCaptchaConfig` 必须在 `initAliyunCaptcha` 之前赋值（SDK 初始化时读它）；
 *   4. `mode:"popup"` —— 与官方一致，交互挑战以浮层呈现，不占用页面布局。
 *
 * 宿主页本身**不含任何业务逻辑**：求解脚本由 `buildManualClaimCaptchaSolveScript`
 * 在 `dom-ready` 之后注入，这样宿主页是一段静态 HTML（无内联脚本），
 * 也避免把配置相关字符串写进页面文档。
 *
 * 宿主页用 `data:` URL 承载（见 `buildManualClaimCaptchaHostPageUrl`）。
 * `data:` 的 origin 是 opaque 的，`localStorage` / `cookie` 会抛 `SecurityError`；
 * 实测 SDK 不依赖它们（它用 indexedDB + crypto + 网络回传），全流程仍可拿到凭据。
 */
export function buildManualClaimCaptchaHostPage(options?: { lang?: string }): string {
  const lang = resolveAliyunCaptchaLanguage(options?.lang);
  return [
    "<!DOCTYPE html>",
    '<html><head><meta charset="utf-8">',
    "<title>ZCode Captcha</title>",
    "<style>",
    // 宿主页是隐藏的求解载体：SDK 的 popup 模式会自建浮层，
    // 页面本身只留一个锚点容器，不参与视觉呈现。
    "html,body{margin:0;padding:0;background:transparent}",
    "#" + MANUAL_CLAIM_CAPTCHA_ELEMENT_ID + "{display:block}",
    "#" + MANUAL_CLAIM_CAPTCHA_BUTTON_ID + "{display:none}",
    "</style></head><body>",
    '<div id="' + MANUAL_CLAIM_CAPTCHA_ELEMENT_ID + '"></div>',
    '<button id="' + MANUAL_CLAIM_CAPTCHA_BUTTON_ID + '" type="button"></button>',
    // 语言只用于 SDK 自己的界面文案；用 data-* 承载，避免在 HTML 里拼 JS。
    '<div id="zcode-manual-claim-captcha-meta" data-lang="' + lang + '" hidden></div>',
    '<script src="' + ALIYUN_CAPTCHA_SDK_URL + '"></script>',
    "</body></html>",
  ].join("");
}

/** 把宿主页 HTML 编码成 webview 可加载的 `data:` URL。 */
export function buildManualClaimCaptchaHostPageUrl(options?: { lang?: string }): string {
  return (
    "data:text/html;charset=utf-8," + encodeURIComponent(buildManualClaimCaptchaHostPage(options))
  );
}

/**
 * 把 App 的 BCP-47 locale 映射到阿里云 SDK 的语言白名单。
 *
 * SDK 的 `language` **不是** BCP-47：它只接受 `cn` / `tw` / `en` / `ar` / `de` / `es` /
 * `fr` / `in` / `it` / `ja` / `ko` / `pt` / `ru` / `ms` / `th` / `tr` / `vi`
 * （实测自 CDN bundle 的参数校验表），传 `zh-CN` 会命中 `language参数传入值不合法`。
 * 未知语言回落到 `en` 而不是 `cn`：宁可给英文界面，也不要把英文用户丢进中文挑战。
 */
export function resolveAliyunCaptchaLanguage(locale: string | undefined): string {
  const normalized = locale?.trim().toLowerCase() ?? "";
  if (!normalized) {
    return "cn";
  }
  // 繁体中文（zh-TW / zh-HK / zh-Hant）走 SDK 的 tw 词表。
  if (normalized.startsWith("zh")) {
    return /tw|hk|hant|mo/.test(normalized) ? "tw" : "cn";
  }
  const primary = normalized.split(/[-_]/)[0] ?? "";
  return ALIYUN_CAPTCHA_LANGUAGES.has(primary) ? primary : "en";
}

/** SDK 的 language 白名单（实测自 CDN bundle 的参数校验表）。 */
const ALIYUN_CAPTCHA_LANGUAGES = new Set([
  "cn",
  "tw",
  "en",
  "ar",
  "de",
  "es",
  "fr",
  "in",
  "it",
  "ja",
  "ko",
  "pt",
  "ru",
  "ms",
  "th",
  "tr",
  "vi",
]);

/** 真实凭据约 280 字符（实测）；200 是保守下限，用于挡住 SDK 降级路径的短值。 */
export const MIN_VERIFY_PARAM_LENGTH = 200;

/**
 * 构造在宿主页里执行的求解脚本。
 *
 * 四步形态与官方 renderer 一致：
 *   1. `window.AliyunCaptchaConfig = { region, prefix }`；
 *   2. `initAliyunCaptcha({ SceneId, mode:"popup", region, prefix, element, button })`；
 *   3. `getInstance` 里调 `startTracelessVerification()`（官方 `auto` 档语义：允许交互挑战）；
 *   4. `success` 取 verifyParam 回传。
 *
 * **没有走 traceless-only 的降级档**：官方 `allowInteractive !== false` 默认为 true，
 * 即「允许交互挑战」，`traceless` 才是显式降级。这里保持官方默认行为。
 *
 * 脚本以**字符串**返回而不是直接执行：它要被 `executeJavaScript` 送进 guest，
 * 且需要在单测里断言其形状（例如「必须调用 startTracelessVerification」）。
 *
 * 返回值是一个 Promise，因此调用方（renderer）用 `executeJavaScript(script, true)`
 * 直接 await 到求解结果，无需 preload 或 IPC 频道。
 */
export function buildManualClaimCaptchaSolveScript(options: {
  config: ManualClaimCaptchaConfig;
  timeoutMs: number;
}): string {
  // 归一化函数先注入：求解脚本的 success 分支要用它判空。
  return [RESOLVE_VERIFY_PARAM_SOURCE, buildManualClaimCaptchaSolveExpression(options)].join("\n");
}

/**
 * 求解脚本的表达式部分（不含前置的归一化函数注入）。
 *
 * 单独导出是为了让 Web / 手机远控的主世界求值路径复用同一份表达式：
 * 那里用 new Function(归一化源码 + "return (" + 表达式 + ");") 求值，
 * 而 webview 路径用 executeJavaScript(完整脚本)。两条路径的求解逻辑逐字同源，
 * 任何修正都会同时作用于两个平面。
 */
export function buildManualClaimCaptchaSolveExpression(options: {
  config: ManualClaimCaptchaConfig;
  timeoutMs: number;
}): string {
  const payload = JSON.stringify({
    sceneId: options.config.sceneId,
    prefix: options.config.prefix,
    region: options.config.region,
    timeoutMs: options.timeoutMs,
    elementId: MANUAL_CLAIM_CAPTCHA_ELEMENT_ID,
    buttonId: MANUAL_CLAIM_CAPTCHA_BUTTON_ID,
  });
  return [
    "(function(){",
    "  var o = " + payload + ";",
    "  return new Promise(function(resolve){",
    "    var settled = false;",
    "    function finish(message) {",
    "      if (settled) return;",
    "      settled = true;",
    "      clearTimeout(timer);",
    "      resolve(message);",
    "    }",
    "    function fail(stage, reason) {",
    "      finish({ kind: 'fail', stage: stage, reason: String(reason || '') });",
    "    }",
    "    if (typeof window.initAliyunCaptcha !== 'function') {",
    "      fail('sdk_load', 'AliyunCaptcha SDK not loaded');",
    "      return;",
    "    }",
    "    var timer = setTimeout(function() { fail('timeout', 'captcha solve timeout'); }, o.timeoutMs);",
    "    try {",
    "      window.AliyunCaptchaConfig = { region: o.region, prefix: o.prefix };",
    "      window.initAliyunCaptcha({",
    "        SceneId: o.sceneId,",
    "        mode: 'popup',",
    "        region: o.region,",
    "        prefix: o.prefix,",
    "        element: '#' + o.elementId,",
    "        button: '#' + o.buttonId,",
    "        showErrorTip: true,",
    "        getInstance: function(instance) {",
    "          try {",
    "            var start = instance && (instance.startTracelessVerification || instance.show);",
    "            if (typeof start !== 'function') { fail('start', 'no start entry'); return; }",
    "            start.call(instance);",
    "          } catch (e) { fail('start', e && e.message ? e.message : e); }",
    "        },",
    "        success: function(result) {",
    "          var verifyParam = window.__zcodeResolveVerifyParam(result);",
    "          if (!verifyParam) { fail('verify', 'empty verifyParam'); return; }",
    "          finish({ kind: 'success', verifyParam: verifyParam, region: o.region });",
    "        },",
    "        fail: function(error) {",
    "          fail('verify', error && error.verifyCode ? error.verifyCode : JSON.stringify(error || {}));",
    "        },",
    "        onError: function(error) {",
    "          fail('verify', JSON.stringify(error || {}));",
    "        }",
    "      });",
    "    } catch (e) {",
    "      fail('init', e && e.message ? e.message : e);",
    "    }",
    "  });",
    "})()",
  ].join("\n");
}

/**
 * 求解脚本在 guest 里用到的 verifyParam 归一化函数源码。
 *
 * SDK 不同版本的成功回调形态不一致：字符串、`{ verifyParam }`、`{ data }`、`{ param }`
 * 都出现过（参考实现同样做了四选一兜底）。这里把归一化逻辑同时注入 guest，
 * 使「判空」发生在凭据产生的那一侧 —— renderer 侧再校验一次（见 `resolveVerifyParam`）。
 */
export const RESOLVE_VERIFY_PARAM_SOURCE = [
  "window.__zcodeResolveVerifyParam = function(result) {",
  "  function norm(value) {",
  "    if (typeof value !== 'string') return null;",
  "    var trimmed = value.trim();",
  "    return trimmed.length >= " + String(MIN_VERIFY_PARAM_LENGTH) + " ? trimmed : null;",
  "  }",
  "  if (typeof result === 'string') return norm(result);",
  "  if (result && typeof result === 'object') {",
  "    var keys = ['verifyParam', 'data', 'param'];",
  "    for (var i = 0; i < keys.length; i++) {",
  "      var found = norm(result[keys[i]]);",
  "      if (found) return found;",
  "    }",
  "  }",
  "  return null;",
  "};",
].join("\n");

/**
 * 从 SDK 的 `success` 回调参数里取出 verifyParam（renderer 侧同规则校验）。
 *
 * 拒绝明显不完整的值：空串会让 claim 请求带上一个必然失败的验证头（服务端回 3007），
 * 不如在这里就判定为失败，让 UI 提示用户重试。
 */
export function resolveVerifyParam(result: unknown): string | null {
  if (typeof result === "string") {
    return normalizeVerifyParam(result);
  }
  if (result && typeof result === "object") {
    const candidate = result as { verifyParam?: unknown; data?: unknown; param?: unknown };
    for (const value of [candidate.verifyParam, candidate.data, candidate.param]) {
      const normalized = normalizeVerifyParam(value);
      if (normalized) {
        return normalized;
      }
    }
  }
  return null;
}

function normalizeVerifyParam(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length >= MIN_VERIFY_PARAM_LENGTH ? trimmed : null;
}

/**
 * 归一化求解结果消息，用于 UI 侧类型收窄。
 * 不做信任假设：结果从 guest 跨进程边界回来，字段必须逐个校验。
 */
export function parseManualClaimCaptchaMessage(raw: unknown): ManualClaimCaptchaMessage | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const candidate = raw as {
    kind?: unknown;
    verifyParam?: unknown;
    region?: unknown;
    stage?: unknown;
    reason?: unknown;
  };
  if (candidate.kind === "success") {
    const verifyParam = resolveVerifyParam(candidate.verifyParam);
    if (!verifyParam) {
      return null;
    }
    return {
      kind: "success",
      verifyParam,
      region: typeof candidate.region === "string" ? candidate.region.trim() : "",
    };
  }
  if (candidate.kind === "fail") {
    return {
      kind: "fail",
      stage: normalizeFailureStage(candidate.stage),
      reason: typeof candidate.reason === "string" ? candidate.reason : "",
    };
  }
  return null;
}

function normalizeFailureStage(value: unknown): ManualClaimCaptchaFailureStage {
  return value === "sdk_load" ||
    value === "init" ||
    value === "start" ||
    value === "verify" ||
    value === "timeout" ||
    value === "unsupported"
    ? value
    : "verify";
}

/**
 * 判断当前宿主是否真的提供了可用的 `<webview>`。
 *
 * Electron 只在 **节点插入文档之后** 才把 `executeJavaScript` 等方法挂到 webview 元素上
 * （实测：detached 时 `typeof el.loadURL === "undefined"`，attach 后为 function）。
 * 手机 Web / 普通 Web 构建没有 webviewTag，元素永远拿不到这些方法。
 * 因此这个判据必须在 ref 回调（节点已插入）里调用，不能提前看构造函数。
 */
export function isManualClaimCaptchaWebviewSupported(element: unknown): boolean {
  return (
    typeof element === "object" &&
    element !== null &&
    typeof (element as { executeJavaScript?: unknown }).executeJavaScript === "function"
  );
}

/** 求解结果 → claim 请求的 captcha 字段。region 为空时回落到配置里的 region。 */
export function toManualClaimCaptchaSolution(
  message: Extract<ManualClaimCaptchaMessage, { kind: "success" }>,
  config: ManualClaimCaptchaConfig,
): ManualClaimCaptchaSolution {
  return {
    verifyParam: message.verifyParam,
    region: message.region.trim() || config.region,
  };
}
