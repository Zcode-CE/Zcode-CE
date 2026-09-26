/**
 * start-plan 验证码求解的渲染层载体（spec 130 §4.1 第①段：渲染层求解）。
 *
 * ## 为什么需要这个模块
 *
 * start-plan（官方赠送额度）的模型请求经网关转发时会强制要求
 * `X-Aliyun-Captcha-Verify-Param` 头（阿里云无痕验证）。官方客户端为此有一条三段式链路，
 * CE 此前三段全缺，表现为模型请求必然报 `provider_code=3007`
 * （见 docs/development/126-start-plan-3007-root-cause.md 与 130-start-plan-captcha-spec.md）。
 *
 * Task B 已补齐 host 侧两段：守卫收紧（只有非 start-plan 才走 host 自答短路）+
 * 渲染层应答入口 `respondProviderRuntimeHeaders`。本模块补的是第三段：渲染层求解。
 *
 * ## 与 claim 平面求解器的关系：复用，不重写
 *
 * claim 平面（周末/体验套餐手动领取）已有一套验证码求解载体
 * （`settings/manualClaimCaptchaPage.ts`）：宿主页 HTML、求解表达式、消息归一化全是纯函数。
 * 本模块复用它们，只在「SDK 怎么加载 / 结果怎么取」上分叉：
 *
 * | 平面 | SDK 加载方式 | 结果取值 |
 * | --- | --- | --- |
 * | claim（桌面） | Electron webview 加载 data: 宿主页 | executeJavaScript 的 Promise 返回值 |
 * | 本平面（桌面） | 同上 | 同上 |
 * | 本平面（Web / 手机远控） | 主世界动态插入 script 标签 | 求值求解表达式得到的 Promise |
 *
 * ## 为什么 Web 端接受「主世界加载第三方脚本」
 *
 * 这是一处刻意的安全取舍，不是疏漏：
 *
 * 1. 官方 renderer 本身就是主世界加载。实测官方 3.14.3 的 renderer bundle
 *    （.reverse/94-account-capability/official-3.14.3/asar-out/out/renderer/assets/styles-DEELZGp2.js）
 *    在 renderer 页面里直接 document.createElement("script") 插入
 *    https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js，
 *    并直接操作 window.initAliyunCaptcha / window.AliyunCaptchaConfig。
 *    CE 的 claim 平面当初选 webview 是隔离偏好（避免第三方脚本进 App 主世界），
 *    不是技术必需 —— 浏览器里没有 webviewTag 时那条路根本走不通。
 * 2. Web / 手机远控是浏览器，没有 Electron webview。若不主世界加载，这两个前端就永远无法求解，
 *    start-plan 在那里必然失败（用户已明确要求它们是可求解的一等公民）。
 * 3. CSP 不构成阻碍（已实测）：packages/server/src/webExposureGuard.ts:394-399 下发的策略
 *    只有 frame-ancestors 'none'，没有 script-src / connect-src 限制，加载 o.alicdn.com
 *    与访问 *.aliyuncs.com 均不被拦。
 *    ⚠ 若将来把 CSP 收紧为 enforce 全量策略，必须同步把这两个域名加入白名单 —— 这是一处
 *    必须记得改的点，否则 Web 端验证码会静默加载失败。
 * 4. 只在确实需要求解时才注入（见 ensureAliyunCaptchaSdkLoaded）：页面加载、浏览会话都不会
 *    触发 SDK 下载，只有 start-plan 请求真的到达时才注入一次。
 *
 * ## 本文件的职责边界
 *
 * 只放纯函数与浏览器侧小工具，不碰 React。服务事件订阅与能力声明在
 * `v4/ProviderRuntimeHeadersCaptchaAttachment.tsx`，判定/去重/应答编排在
 * `v4/providerRuntimeHeadersSolver.ts`。
 */
import type { ManualClaimCaptchaConfig } from "@zcode/shared";
import {
  ALIYUN_CAPTCHA_SDK_URL,
  MANUAL_CLAIM_CAPTCHA_BUTTON_ID,
  MANUAL_CLAIM_CAPTCHA_ELEMENT_ID,
  RESOLVE_VERIFY_PARAM_SOURCE,
  buildManualClaimCaptchaHostPageUrl,
  buildManualClaimCaptchaSolveExpression,
  buildManualClaimCaptchaSolveScript,
  isManualClaimCaptchaWebviewSupported,
  parseManualClaimCaptchaMessage,
  toManualClaimCaptchaSolution,
  type ManualClaimCaptchaFailureStage,
  type ManualClaimCaptchaMessage,
} from "@/settings/manualClaimCaptchaPage.js";

/** 求解超时。交互挑战需要用户操作，给足时间但必须有界，避免请求永久卡住。 */
export const CAPTCHA_SOLVE_TIMEOUT_MS = 180_000;

/** SDK 从 CDN 加载的上限。超过即显式失败，不悬挂。 */
export const SDK_LOAD_TIMEOUT_MS = 30_000;

/** 桌面端等 SDK 就绪的轮询间隔（宿主页的 script 标签异步加载）。 */
export const SDK_READY_POLL_INTERVAL_MS = 150;

/**
 * 渲染层允许回传的运行时请求头白名单（逐字对齐官方 host 的
 * ["X-Aliyun-Captcha-Verify-Param","X-Aliyun-Captcha-Verify-Region"]，
 * 见 zcodeAgentService.ts 的 PROVIDER_RUNTIME_HEADER_ALLOWLIST 与 spec §5 不变量 2）。
 *
 * 这里是渲染层侧的镜像：host 侧会再过滤一次，两道都要有 —— host 那道是安全边界，
 * 这道让渲染层自己的契约可被单测钉住，且避免把一个注定被丢弃的头送上线。
 */
export const CAPTCHA_VERIFY_PARAM_HEADER = "X-Aliyun-Captcha-Verify-Param";
export const CAPTCHA_VERIFY_REGION_HEADER = "X-Aliyun-Captcha-Verify-Region";

/** 白名单的规范大小写形式，与 host 侧保持一致。 */
const RUNTIME_HEADER_ALLOWLIST = [
  CAPTCHA_VERIFY_PARAM_HEADER,
  CAPTCHA_VERIFY_REGION_HEADER,
] as const;

/**
 * 求解结果 → 运行时请求头。
 *
 * 匹配与写入规则与 host 一致：精确匹配（大小写不敏感 + 两侧 trim），不用 startsWith ——
 * Task B 的变异测试证明过：startsWith 会让 X-Aliyun-Captcha-Verify-Param-Evil 混进白名单。
 * 写入时统一使用白名单里的规范大小写（官方 host 同样归一化）。
 *
 * region 为空时不发 region 头：服务端按 region 校验凭据，发一个空值比不发更糟。
 */
export function buildCaptchaRuntimeHeaders(solution: {
  verifyParam: string;
  region?: string | undefined;
}): Record<string, string> {
  const canonical = new Map<string, string>(
    RUNTIME_HEADER_ALLOWLIST.map((name) => [name.toLowerCase(), name]),
  );
  const headers: Record<string, string> = {};
  const candidates: readonly (readonly [string, string | undefined])[] = [
    [CAPTCHA_VERIFY_PARAM_HEADER, solution.verifyParam],
    [CAPTCHA_VERIFY_REGION_HEADER, solution.region],
  ];
  for (const [name, rawValue] of candidates) {
    const value = rawValue?.trim();
    if (!value) continue;
    // 精确匹配：只有名字与白名单逐字（忽略大小写）相同才写入。
    const normalized = canonical.get(name.toLowerCase());
    if (normalized !== name) continue;
    headers[normalized] = value;
  }
  return headers;
}

/**
 * 本端是否具备求解能力。
 *
 * 判据是「有没有可用的浏览器 DOM」而不是 isDesktop：桌面与 Web 都能求解，只是载体不同
 * （webview vs 主世界）。真正不能求解的是没有 DOM 的宿主（纯 Node 测试环境、SSR）。
 *
 * ⚠ 这个判据与 ProviderRuntimeHeadersCaptchaAttachment 里的能力声明必须同源：
 * 声明即承诺能处理，判据宽了会让 host 转发给一个处理不了的订阅者（退回悬挂），
 * 判据窄了会让能求解的前端被 host 提前拒绝。
 */
export function canSolveCaptchaInCurrentHost(): boolean {
  return typeof document !== "undefined" && typeof document.createElement === "function";
}

/**
 * Web / 手机远控的宿主容器。
 *
 * SDK 的 initAliyunCaptcha 要求 element / button 指向真实存在于文档里的节点
 * （官方 renderer 也是先挂载容器再初始化）。这里按需创建，容器视觉隐藏：
 * 挑战以 mode:"popup" 浮层呈现，容器本身不占布局。
 *
 * 用固定的 DOM id（与 claim 平面同一组），使求解表达式无需改动即可复用 ——
 * 表达式里的选择器就是这两个 id。
 */
export function ensureAliyunCaptchaHostElements(doc: Document): { created: boolean } {
  const existingContainer = doc.getElementById(MANUAL_CLAIM_CAPTCHA_ELEMENT_ID);
  const existingButton = doc.getElementById(MANUAL_CLAIM_CAPTCHA_BUTTON_ID);
  if (existingContainer && existingButton) {
    return { created: false };
  }
  if (!existingContainer) {
    const container = doc.createElement("div");
    container.id = MANUAL_CLAIM_CAPTCHA_ELEMENT_ID;
    // 固定定位 + 零尺寸：不参与布局，不遮挡 App 界面。SDK 的 popup 浮层自建在 body 上。
    container.setAttribute(
      "style",
      "position:fixed;left:0;top:0;width:0;height:0;overflow:visible;z-index:2147483647",
    );
    doc.body.appendChild(container);
  }
  if (!existingButton) {
    const button = doc.createElement("button");
    button.id = MANUAL_CLAIM_CAPTCHA_BUTTON_ID;
    button.type = "button";
    button.setAttribute("tabindex", "-1");
    button.setAttribute("aria-hidden", "true");
    button.setAttribute("style", "position:fixed;left:50%;top:50%;width:1px;height:1px;opacity:0");
    doc.body.appendChild(button);
  }
  return { created: true };
}

/** 每个 Document 一份 SDK 加载 Promise（同一页面内的并发求解只下载一次）。 */
const sdkLoadPromises = new WeakMap<Document, Promise<void>>();

/**
 * 在 Web / 手机远控的主世界里按需加载阿里云验证码 SDK。
 *
 * 幂等：window.initAliyunCaptcha 已存在时直接返回；已插入但仍在加载的 script 会复用
 * 同一个 Promise，避免并发请求重复下载。
 *
 * 失败必须显式 reject 并带可读原因：SDK 加载失败是 Web 端最常见的失败形态
 * （CSP 收紧、网络不通、CDN 变更），静默失败会让请求悬挂到 CLI 侧 180s 超时。
 */
export function ensureAliyunCaptchaSdkLoaded(
  doc: Document,
  timeoutMs: number = SDK_LOAD_TIMEOUT_MS,
): Promise<void> {
  if (isAliyunCaptchaSdkReady(doc)) {
    return Promise.resolve();
  }
  const cached = sdkLoadPromises.get(doc);
  if (cached) {
    return cached;
  }
  const pending = new Promise<void>((resolve, reject) => {
    const script = doc.createElement("script");
    script.src = ALIYUN_CAPTCHA_SDK_URL;
    script.async = true;
    let settled = false;
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`AliyunCaptcha SDK load timeout after ${timeoutMs}ms`)));
    }, timeoutMs);
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      script.removeEventListener("load", handleLoad);
      script.removeEventListener("error", handleError);
      settle();
    };
    function handleLoad() {
      finish(() => {
        if (isAliyunCaptchaSdkReady(doc)) {
          resolve();
          return;
        }
        // 脚本加载完成但没有挂上入口：CDN 内容变更或被中间层改写。必须显式失败。
        reject(new Error("AliyunCaptcha script loaded but window.initAliyunCaptcha is missing"));
      });
    }
    function handleError() {
      finish(() => reject(new Error("Failed to load AliyunCaptcha script")));
    }
    script.addEventListener("load", handleLoad);
    script.addEventListener("error", handleError);
    doc.head.appendChild(script);
  }).catch((error: unknown) => {
    // 失败不缓存：一次网络抖动不该让本次会话永久失去求解能力。
    sdkLoadPromises.delete(doc);
    throw error;
  });
  sdkLoadPromises.set(doc, pending);
  return pending;
}

function isAliyunCaptchaSdkReady(doc: Document): boolean {
  const win = doc.defaultView as (Window & { initAliyunCaptcha?: unknown }) | null;
  return typeof win?.initAliyunCaptcha === "function";
}

/**
 * 把求解表达式包成「可在主世界直接求值」的调用。
 *
 * 与 webview 的差别只有一处：webview 走 executeJavaScript(script) 由 Electron 求值，
 * Web 端没有这个 API，只能把同一份表达式交给 new Function 求值并 await 它的返回值。
 *
 * 这里不复制求解逻辑：表达式仍来自 buildManualClaimCaptchaSolveExpression，
 * 与 claim 平面逐字同源。任何求解逻辑的修正都会同时作用于两个平面。
 * 归一化函数（RESOLVE_VERIFY_PARAM_SOURCE）与 webview 路径一样拼在同一作用域前置，
 * 使 success 分支的判空行为完全一致。
 */
export function evaluateCaptchaSolveExpression(
  expression: string,
  evaluate: (source: string) => unknown = defaultEvaluate,
): Promise<unknown> {
  // 源码是本仓库常量字符串拼装，不含任何用户输入；求值入口可注入以便单测断言形状。
  const result = evaluate(`${RESOLVE_VERIFY_PARAM_SOURCE}\nreturn (${expression});`);
  return Promise.resolve(result);
}

function defaultEvaluate(source: string): unknown {
  // eslint-disable-next-line no-new-func -- 见 evaluateCaptchaSolveExpression 的说明。
  return new Function(source)();
}

/**
 * Web / 手机远控的一次完整求解：确保容器 → 确保 SDK → 求值表达式。
 *
 * 返回值形状与 webview 路径一致（parseManualClaimCaptchaMessage 的入参），
 * 使两条路径共用同一份结果解析与失败归因。
 */
export async function solveCaptchaInBrowser(options: {
  config: ManualClaimCaptchaConfig;
  timeoutMs: number;
  doc: Document;
  evaluate?: (source: string) => unknown;
}): Promise<ManualClaimCaptchaMessage | null> {
  const { doc } = options;
  ensureAliyunCaptchaHostElements(doc);
  await ensureAliyunCaptchaSdkLoaded(doc);
  const expression = buildManualClaimCaptchaSolveExpression({
    config: options.config,
    timeoutMs: options.timeoutMs,
  });
  const raw = await evaluateCaptchaSolveExpression(expression, options.evaluate);
  return parseManualClaimCaptchaMessage(raw);
}

/**
 * 桌面端：把一个已挂载的 webview 元素跑完整求解。
 *
 * 与 claim 平面的 ManualClaimCaptchaDialog 同构（宿主页 data: URL + 等 SDK 就绪 +
 * executeJavaScript 取 Promise 返回值），差别只在结果直接交给本平面的编排器。
 *
 * 不支持的 webview（手机 Web / 普通 Web 构建没有 webviewTag，元素拿不到 executeJavaScript）
 * 显式返回 unsupported 阶段：这一档重试没有意义，调用方据此走 Web 主世界路径或快速失败。
 */
export async function solveCaptchaInWebview(options: {
  element: unknown;
  config: ManualClaimCaptchaConfig;
  timeoutMs: number;
  locale?: string;
  /** 注入点：单测据此断言宿主页与脚本的形状，无需真实 Electron。 */
  loadHostPage?: (url: string) => Promise<void>;
  /** 注入点：默认用元素的 executeJavaScript。 */
  execute?: (code: string, userGesture?: boolean) => Promise<unknown>;
}): Promise<ManualClaimCaptchaMessage | null> {
  const { element } = options;
  if (!isManualClaimCaptchaWebviewSupported(element)) {
    return { kind: "fail", stage: "unsupported", reason: "webview_unavailable" };
  }
  const target = element as ElectronWebviewTag;
  const execute =
    options.execute ??
    ((code: string, userGesture?: boolean) => target.executeJavaScript(code, userGesture));
  const loadHostPage =
    options.loadHostPage ?? ((url: string) => target.loadURL(url).then(() => undefined));
  await loadHostPage(buildManualClaimCaptchaHostPageUrl({ lang: options.locale }));
  const ready = await waitForCaptchaSdkReady(execute);
  if (!ready) {
    return { kind: "fail", stage: "sdk_load", reason: "sdk_ready_timeout" };
  }
  const raw = await execute(
    buildManualClaimCaptchaSolveScript({ config: options.config, timeoutMs: options.timeoutMs }),
    true,
  );
  return parseManualClaimCaptchaMessage(raw);
}

/**
 * 轮询等宿主页的 SDK 就绪。
 *
 * 宿主页用 script src 异步加载 SDK，dom-ready 时未必已完成，因此不能假设它已存在
 * （claim 平面同样做了这件事，见 ManualClaimCaptchaDialog 的 poll）。
 */
async function waitForCaptchaSdkReady(
  execute: (code: string, userGesture?: boolean) => Promise<unknown>,
  deadlineMs: number = SDK_LOAD_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const ready = await execute('typeof window.initAliyunCaptcha === "function"', true).catch(
      () => false,
    );
    if (ready === true) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, SDK_READY_POLL_INTERVAL_MS));
  }
}

/**
 * 求解消息 → 运行时请求头；失败时给出可读原因。
 *
 * 返回 null 表示「拿不到可用的头」，调用方必须据此回 headersApplied:false 并附原因 ——
 * 静默是唯一不被允许的形态（spec §5 失败语义）。
 */
export function resolveCaptchaHeaders(
  message: ManualClaimCaptchaMessage | null,
  config: ManualClaimCaptchaConfig,
):
  | { headers: Record<string, string> }
  | { failureStage: ManualClaimCaptchaFailureStage; reason: string } {
  if (!message) {
    // 跨边界回来的形状不认识（或空凭据被 parseManualClaimCaptchaMessage 判为无效）。
    return { failureStage: "verify", reason: "unrecognized_result" };
  }
  if (message.kind === "fail") {
    return { failureStage: message.stage, reason: message.reason };
  }
  const solution = toManualClaimCaptchaSolution(message, config);
  const headers = buildCaptchaRuntimeHeaders(solution);
  if (!headers[CAPTCHA_VERIFY_PARAM_HEADER]) {
    return { failureStage: "verify", reason: "empty_verify_param" };
  }
  return { headers };
}
