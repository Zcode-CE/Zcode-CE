import assert from "node:assert/strict";
import test from "node:test";
import {
  ALIYUN_CAPTCHA_SDK_URL,
  MANUAL_CLAIM_CAPTCHA_BUTTON_ID,
  MANUAL_CLAIM_CAPTCHA_ELEMENT_ID,
  MIN_VERIFY_PARAM_LENGTH,
  buildManualClaimCaptchaHostPage,
  buildManualClaimCaptchaHostPageUrl,
  buildManualClaimCaptchaSolveScript,
  isManualClaimCaptchaWebviewSupported,
  parseManualClaimCaptchaMessage,
  resolveAliyunCaptchaLanguage,
  resolveVerifyParam,
  toManualClaimCaptchaSolution,
} from "../src/settings/manualClaimCaptchaPage.js";

/**
 * claim 平面「验证码前端接线」的回归测试。
 *
 * 重点防四类回归（每一类都对应一个已实测的官方/SDK 事实）：
 *
 * 1. **语言参数**：阿里云 SDK 的 `language` 是它自己的白名单（`cn`/`en`/…），
 *    **不是** BCP-47。传 `zh-CN` 会命中 SDK 的 `language参数传入值不合法` 分支（实测），
 *    表现为验证组件不渲染 —— 但流程其它部分看起来都正常，很难定位。
 * 2. **四步形态**：宿主页必须挂 `#cap` 容器与 button、必须在 init 前设
 *    `AliyunCaptchaConfig`、必须调 `startTracelessVerification`（官方 `auto` 档语义，
 *    允许交互挑战）。漏掉任何一步都会静默退化成「不弹挑战」或「不返回凭据」。
 * 3. **凭据校验**：真实 verifyParam 约 280 字符 base64 JSON（含 securityToken）。
 *    SDK 降级路径会返回短值，直接发出去只会拿服务端 3007；必须在本地判定为无效。
 * 4. **跨边界取值**：求解结果从 webview guest 回来，字段必须逐个校验，
 *    不能因为「是我们自己注入的脚本」就信任其形状。
 *
 * 运行：cd packages/ui && node --import tsx --test test/manualClaimCaptcha.test.ts
 */

const CONFIG = {
  enabled: true,
  prefix: "no8xfe",
  sceneId: "11xygtvd",
  region: "cn",
} as const;

/** 与真实凭据同构的哨兵值：base64 JSON 含 securityToken，长度约 280。 */
const VALID_VERIFY_PARAM = Buffer.from(
  JSON.stringify({
    certifyId: "wQPXHYxvn9",
    sceneId: "11xygtvd",
    isSign: true,
    securityToken:
      "6oOo7e72nA61uVLiZVKiLYqF1m9rOno3vEIPJKaL7KLxCJqb1UBwRpl4p7EcFTgdg4FhpqbWG11Ub8Ds9/14ByoXk1aghHbPw5LiOHyMnbpUSMXkpeBaVeiZER57eiVa",
  }),
).toString("base64");

test("宿主页挂载 captcha 容器与隐藏按钮，并从 CDN 加载 SDK", () => {
  const html = buildManualClaimCaptchaHostPage();
  assert.ok(html.includes(`id="${MANUAL_CLAIM_CAPTCHA_ELEMENT_ID}"`), "缺少 captcha 容器");
  assert.ok(html.includes(`id="${MANUAL_CLAIM_CAPTCHA_BUTTON_ID}"`), "缺少隐藏 button");
  assert.ok(html.includes(ALIYUN_CAPTCHA_SDK_URL), "缺少 SDK script 标签");
  assert.ok(
    ALIYUN_CAPTCHA_SDK_URL.startsWith("https://"),
    "SDK 必须走 https，否则会被 webview 的混合内容策略拦掉",
  );
  // 宿主页自身不能内联业务脚本：求解脚本由 executeJavaScript 在 dom-ready 后注入。
  assert.equal(
    /<script(?![^>]*\bsrc=)/i.test(html),
    false,
    "宿主页不应包含内联 script（求解逻辑必须走注入）",
  );
});

test("宿主页 URL 是 data: 编码形态，可被 webview 白名单放行", () => {
  const url = buildManualClaimCaptchaHostPageUrl({ lang: "zh-CN" });
  assert.ok(url.startsWith("data:text/html;charset=utf-8,"), "宿主页必须走 data: URL");
  // desktopWindowChrome 的 will-attach-webview 只放行 about:/data:/http:/https:/zcode-browser-restore:，
  // 用别的协议会被 preventDefault 掉，表现为 webview 空白且没有 dom-ready。
  const protocol = new URL(url).protocol;
  assert.ok(
    ["about:", "data:", "http:", "https:", "zcode-browser-restore:"].includes(protocol),
    `宿主页协议 ${protocol} 不在 will-attach-webview 白名单内`,
  );
  const decoded = decodeURIComponent(url.slice("data:text/html;charset=utf-8,".length));
  assert.ok(decoded.includes(ALIYUN_CAPTCHA_SDK_URL), "解码后应含 SDK 地址");
});

test("语言映射使用 SDK 白名单，绝不把 BCP-47 直接透传", () => {
  // SDK 只认这些两位码；传 zh-CN 会命中 languageError（实测）。
  assert.equal(resolveAliyunCaptchaLanguage("zh-CN"), "cn");
  assert.equal(resolveAliyunCaptchaLanguage("zh-TW"), "tw");
  assert.equal(resolveAliyunCaptchaLanguage("zh-HK"), "tw");
  assert.equal(resolveAliyunCaptchaLanguage("zh-Hant"), "tw");
  assert.equal(resolveAliyunCaptchaLanguage("en-US"), "en");
  assert.equal(resolveAliyunCaptchaLanguage("ja-JP"), "ja");
  assert.equal(resolveAliyunCaptchaLanguage("ko"), "ko");
  assert.equal(resolveAliyunCaptchaLanguage("de-DE"), "de");
  assert.equal(resolveAliyunCaptchaLanguage("fr-CA"), "fr");
  // 未知语言回落 en 而不是 cn：不把英文用户丢进中文挑战。
  assert.equal(resolveAliyunCaptchaLanguage("xx-YY"), "en");
  assert.equal(resolveAliyunCaptchaLanguage(undefined), "cn");
  assert.equal(resolveAliyunCaptchaLanguage(""), "cn");
});

test("宿主页把语言写进 data-lang，且不是 BCP-47 原值", () => {
  const html = buildManualClaimCaptchaHostPage({ lang: "zh-CN" });
  assert.ok(html.includes('data-lang="cn"'), "应写入 SDK 语言码 cn");
  assert.equal(html.includes("zh-CN"), false, "宿主页不应出现 BCP-47 原值");
});

test("求解脚本包含官方四步形态的每一步", () => {
  const script = buildManualClaimCaptchaSolveScript({ config: CONFIG, timeoutMs: 1000 });
  // 1. AliyunCaptchaConfig 必须在 init 之前赋值；SDK 初始化时读它。
  const configIndex = script.indexOf("AliyunCaptchaConfig");
  const initIndex = script.indexOf("initAliyunCaptcha({");
  assert.ok(configIndex >= 0, "缺少 AliyunCaptchaConfig");
  assert.ok(initIndex >= 0, "缺少 initAliyunCaptcha 调用");
  assert.ok(configIndex < initIndex, "AliyunCaptchaConfig 必须在 initAliyunCaptcha 之前");
  // 2. 配置逐项透传。
  assert.ok(script.includes(CONFIG.sceneId), "缺少 SceneId");
  assert.ok(script.includes(CONFIG.prefix), "缺少 prefix");
  assert.ok(script.includes(CONFIG.region), "缺少 region");
  assert.ok(script.includes(MANUAL_CLAIM_CAPTCHA_ELEMENT_ID), "缺少容器 id");
  assert.ok(script.includes(MANUAL_CLAIM_CAPTCHA_BUTTON_ID), "缺少 button id");
  // 3. getInstance → startTracelessVerification（官方 auto 档：允许交互挑战）。
  assert.ok(
    script.includes("startTracelessVerification"),
    "必须调用 startTracelessVerification —— 这是官方 auto 档语义（允许交互挑战）",
  );
  assert.ok(script.includes("getInstance"), "缺少 getInstance 回调");
  // 4. 成功/失败/异常三条回调都要接，否则会出现「卡住不返回」。
  assert.ok(script.includes("success:"), "缺少 success 回调");
  assert.ok(script.includes("fail:"), "缺少 fail 回调");
  assert.ok(script.includes("onError:"), "缺少 onError 回调");
  assert.ok(script.includes("popup"), "mode 必须是 popup");
});

test("求解脚本是合法 JS，并返回一个 Promise（executeJavaScript 依赖它）", () => {
  const script = buildManualClaimCaptchaSolveScript({ config: CONFIG, timeoutMs: 1000 });
  // 语法必须成立：脚本以字符串形式跨进程送进 guest，语法错误只会在 guest 里静默失败。
  assert.doesNotThrow(() => new Function(script), "注入脚本必须是合法 JS");
  assert.ok(script.includes("return new Promise"), "必须返回 Promise，renderer 才能 await 到结果");
  // 超时兜底：否则 SDK 不回调时 Promise 永不 settle，对话框永久卡住。
  assert.ok(script.includes("setTimeout"), "必须有超时兜底");
  assert.ok(script.includes("settled"), "必须防重复 settle");
});

test("求解脚本不含 IPC/Node 依赖，可纯浏览器环境执行", () => {
  const script = buildManualClaimCaptchaSolveScript({ config: CONFIG, timeoutMs: 1000 });
  for (const forbidden of ["require(", "ipcRenderer", "process.", "import "]) {
    assert.equal(
      script.includes(forbidden),
      false,
      `求解脚本不应依赖 ${forbidden} —— guest 是 sandbox+contextIsolation 环境`,
    );
  }
});

test("verifyParam 接受真实形态，拒绝 SDK 降级路径的短值", () => {
  assert.ok(VALID_VERIFY_PARAM.length >= MIN_VERIFY_PARAM_LENGTH, "哨兵值本身应达标");
  assert.equal(resolveVerifyParam(VALID_VERIFY_PARAM), VALID_VERIFY_PARAM);
  // 四种历史回调形态都要认（参考实现同样做了四选一兜底）。
  assert.equal(resolveVerifyParam({ verifyParam: VALID_VERIFY_PARAM }), VALID_VERIFY_PARAM);
  assert.equal(resolveVerifyParam({ data: VALID_VERIFY_PARAM }), VALID_VERIFY_PARAM);
  assert.equal(resolveVerifyParam({ param: VALID_VERIFY_PARAM }), VALID_VERIFY_PARAM);
  // 短值来自降级路径，发出去只会拿 3007；必须在本地判定无效。
  assert.equal(resolveVerifyParam(""), null);
  assert.equal(resolveVerifyParam("abc"), null);
  assert.equal(resolveVerifyParam("x".repeat(MIN_VERIFY_PARAM_LENGTH - 1)), null);
  assert.equal(resolveVerifyParam({ verifyParam: "short" }), null);
  assert.equal(resolveVerifyParam({}), null);
  assert.equal(resolveVerifyParam(null), null);
  assert.equal(resolveVerifyParam(42), null);
});

test("verifyParam 两侧留白被裁剪，不会带进请求头", () => {
  assert.equal(resolveVerifyParam("  " + VALID_VERIFY_PARAM + "  "), VALID_VERIFY_PARAM);
});

test("跨边界消息解析：只接受校验通过的形状", () => {
  const ok = parseManualClaimCaptchaMessage({
    kind: "success",
    verifyParam: VALID_VERIFY_PARAM,
    region: "cn",
  });
  assert.deepEqual(ok, { kind: "success", verifyParam: VALID_VERIFY_PARAM, region: "cn" });

  const failed = parseManualClaimCaptchaMessage({
    kind: "fail",
    stage: "sdk_load",
    reason: "AliyunCaptcha SDK not loaded",
  });
  assert.deepEqual(failed, {
    kind: "fail",
    stage: "sdk_load",
    reason: "AliyunCaptcha SDK not loaded",
  });

  // 未知 stage 收敛为 verify，而不是原样透传一个 UI 不认识的枚举。
  assert.deepEqual(parseManualClaimCaptchaMessage({ kind: "fail", stage: "bogus" }), {
    kind: "fail",
    stage: "verify",
    reason: "",
  });
  // success 但凭据不达标 → 整体判为无效，不能让空凭据流到 claim。
  assert.equal(parseManualClaimCaptchaMessage({ kind: "success", verifyParam: "short" }), null);
  // 非对象 / 未知 kind / 缺 kind 一律拒绝。
  assert.equal(parseManualClaimCaptchaMessage(null), null);
  assert.equal(parseManualClaimCaptchaMessage("success"), null);
  assert.equal(parseManualClaimCaptchaMessage({ kind: "other" }), null);
  assert.equal(parseManualClaimCaptchaMessage({}), null);
});

test("求解结果转 claim 凭据：region 缺省回落到配置", () => {
  const solution = toManualClaimCaptchaSolution(
    { kind: "success", verifyParam: VALID_VERIFY_PARAM, region: "cn" },
    CONFIG,
  );
  assert.deepEqual(solution, { verifyParam: VALID_VERIFY_PARAM, region: "cn" });

  // guest 没回 region 时不能发空 region 头：服务端按 region 校验凭据。
  const fallback = toManualClaimCaptchaSolution(
    { kind: "success", verifyParam: VALID_VERIFY_PARAM, region: "" },
    CONFIG,
  );
  assert.equal(fallback.region, CONFIG.region);
});

test("webview 能力判据：只有真正挂上方法才算支持（手机 Web 必须判为不支持）", () => {
  // Electron 只在节点插入文档后才把 executeJavaScript 挂到 webview 上；
  // 手机 Web / 普通 Web 没有 webviewTag，元素永远拿不到它。
  // 判错方向的代价：把用户送进一个必然失败的对话框，或误报「不支持」。
  assert.equal(isManualClaimCaptchaWebviewSupported({ executeJavaScript() {} }), true);
  assert.equal(isManualClaimCaptchaWebviewSupported(null), false);
  assert.equal(isManualClaimCaptchaWebviewSupported(undefined), false);
  assert.equal(isManualClaimCaptchaWebviewSupported("webview"), false);
  assert.equal(isManualClaimCaptchaWebviewSupported(42), false);
  // 只有属性名但没有函数（未 attach 的占位元素）同样判为不支持。
  assert.equal(isManualClaimCaptchaWebviewSupported({ executeJavaScript: undefined }), false);
  assert.equal(
    isManualClaimCaptchaWebviewSupported({ executeJavaScript: "not-a-function" }),
    false,
  );
});

test("unsupported 是独立失败阶段，不会被收敛成 verify", () => {
  // 与 sdk_load 区分：unsupported 重试无意义，UI 要给「改用桌面版」而不是「重试」。
  const parsed = parseManualClaimCaptchaMessage({ kind: "fail", stage: "unsupported" });
  assert.deepEqual(parsed, { kind: "fail", stage: "unsupported", reason: "" });
});
