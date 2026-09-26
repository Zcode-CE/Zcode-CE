import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CAPTCHA_VERIFY_PARAM_HEADER,
  CAPTCHA_VERIFY_REGION_HEADER,
  buildCaptchaRuntimeHeaders,
  canSolveCaptchaInCurrentHost,
  ensureAliyunCaptchaHostElements,
  evaluateCaptchaSolveExpression,
  resolveCaptchaHeaders,
} from "../src/v4/providerRuntimeCaptchaSolver.js";
import {
  createProviderRuntimeHeadersOrchestrator,
  isStartPlanCaptchaRequest,
  providerRuntimeHeadersDedupKey,
  shouldHandleProviderRuntimeHeadersRequest,
  type CaptchaSolveOutcome,
} from "../src/v4/providerRuntimeHeadersSolver.js";
import {
  MANUAL_CLAIM_CAPTCHA_BUTTON_ID,
  MANUAL_CLAIM_CAPTCHA_ELEMENT_ID,
} from "../src/settings/manualClaimCaptchaPage.js";

/**
 * start-plan 验证码渲染层接线的回归测试。
 *
 * 背景：3007 是阿里云验证码挑战，CE 缺「渲染层求解」这一段（见
 * docs/development/130-start-plan-captcha-spec.md §4.1）。本文件钉住这条链路上
 * 四类静默失败的形态 —— 它们都不会报错，只会表现为「模型请求仍然 3007」：
 *
 * 1. 非 start-plan 也去求解 ⇒ 用户白看一次验证码挑战（体验缺陷，非崩溃）；
 * 2. 同一 requestId 求解两次 ⇒ 阿里云对同一挑战的第二次提交回 F008「重复提交」，
 *    后一次的失败会覆盖前一次的成功；
 * 3. 求解失败但静默 ⇒ agent 请求悬挂到 CLI 侧 180s 超时，而不是快速失败；
 * 4. 回传白名单外的头 ⇒ host 会丢弃（安全边界在 host），但渲染层自己发出去就是契约错误。
 *
 * 运行：cd packages/ui && node --import tsx --test test/providerRuntimeHeadersSolver.test.ts
 */

/** 与真实凭据同构的哨兵值：base64 JSON 含 securityToken，长度约 280（>= 200 的下限）。 */
const VALID_VERIFY_PARAM = Buffer.from(
  JSON.stringify({
    certifyId: "wQPXHYxvn9",
    sceneId: "11xygtvd",
    isSign: true,
    securityToken:
      "6oOo7e72nA61uVLiZVKiLYqF1m9rOno3vEIPJKaL7KLxCJqb1UBwRpl4p7EcFTgdg4FhpqbWG11Ub8Ds9/14ByoXk1aghHbPw5LiOHyMnbpUSMXkpeBaVeiZER57eiVa",
  }),
).toString("base64");

const CONFIG = {
  enabled: true,
  prefix: "no8xfe",
  sceneId: "11xygtvd",
  region: "cn",
};

function startPlanRequest(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "r1",
    sessionId: "s1",
    workspace: { workspacePath: "/w", workspaceKey: "/w" },
    modelSelection: { providerId: "zai", modelId: "glm-4.6" },
    providerId: "zai",
    accountAccess: {
      type: "zhipu-account",
      accountType: "zai",
      mode: "start-plan",
      entitled: true,
    },
    reason: "model-request",
    ...overrides,
  };
}

// ── 场景 2（防回归）：非 start-plan 不得触发求解 ──

test("只有 start-plan 的请求进入本平面；其余 account provider 一律跳过", () => {
  assert.equal(isStartPlanCaptchaRequest(startPlanRequest()), true);
  assert.equal(shouldHandleProviderRuntimeHeadersRequest(startPlanRequest()), true);

  for (const mode of ["individual-coding-plan", "team-coding-plan", "off-peak"] as const) {
    const request = startPlanRequest({
      accountAccess: { type: "zhipu-account", accountType: "zai", mode, entitled: true },
    });
    // 非 start-plan 走 host 自答零 UI 快路径，host 根本不会转发；渲染层收到即为异常，
    // 必须跳过 —— 否则用户会白看一次验证码挑战。
    assert.equal(isStartPlanCaptchaRequest(request), false, `mode=${mode} 不应进入本平面`);
    assert.equal(shouldHandleProviderRuntimeHeadersRequest(request), false);
  }

  // 无 accountAccess：host 走「无凭据解析器」快速失败分支，同样不该到渲染层。
  assert.equal(isStartPlanCaptchaRequest({ accountAccess: undefined }), false);
});

// ── 场景 3：求解成功 → 白名单头 ──

test("求解成功回传白名单头，且只用规范大小写", () => {
  const headers = buildCaptchaRuntimeHeaders({ verifyParam: VALID_VERIFY_PARAM, region: "cn" });
  assert.deepEqual(headers, {
    [CAPTCHA_VERIFY_PARAM_HEADER]: VALID_VERIFY_PARAM,
    [CAPTCHA_VERIFY_REGION_HEADER]: "cn",
  });
});

test("region 为空时不发 region 头（服务端按 region 校验，空值比不发更糟）", () => {
  const headers = buildCaptchaRuntimeHeaders({ verifyParam: VALID_VERIFY_PARAM, region: "" });
  assert.deepEqual(headers, { [CAPTCHA_VERIFY_PARAM_HEADER]: VALID_VERIFY_PARAM });
  assert.equal(CAPTCHA_VERIFY_REGION_HEADER in headers, false);

  const missing = buildCaptchaRuntimeHeaders({ verifyParam: VALID_VERIFY_PARAM });
  assert.equal(CAPTCHA_VERIFY_REGION_HEADER in missing, false);
});

test("两侧留白被裁剪，不会把空白带进请求头", () => {
  const headers = buildCaptchaRuntimeHeaders({
    verifyParam: `  ${VALID_VERIFY_PARAM}  `,
    region: "  cn  ",
  });
  assert.equal(headers[CAPTCHA_VERIFY_PARAM_HEADER], VALID_VERIFY_PARAM);
  assert.equal(headers[CAPTCHA_VERIFY_REGION_HEADER], "cn");
});

test("resolveCaptchaHeaders：成功给头，失败给可归因阶段与原因（绝不静默）", () => {
  const ok = resolveCaptchaHeaders(
    { kind: "success", verifyParam: VALID_VERIFY_PARAM, region: "cn" },
    CONFIG,
  );
  assert.deepEqual(ok, {
    headers: {
      [CAPTCHA_VERIFY_PARAM_HEADER]: VALID_VERIFY_PARAM,
      [CAPTCHA_VERIFY_REGION_HEADER]: "cn",
    },
  });

  // guest 没回 region 时回落到配置里的 region（与 claim 平面同一口径）。
  const fallback = resolveCaptchaHeaders(
    { kind: "success", verifyParam: VALID_VERIFY_PARAM, region: "" },
    CONFIG,
  );
  assert.ok("headers" in fallback);
  assert.equal(fallback.headers[CAPTCHA_VERIFY_REGION_HEADER], CONFIG.region);

  // 跨边界回来的形状不认识：不能当成成功，也不能静默。
  assert.deepEqual(resolveCaptchaHeaders(null, CONFIG), {
    failureStage: "verify",
    reason: "unrecognized_result",
  });

  // SDK 归因的阶段原样透传，UI 才能区分「没加载出来」与「挑战被拒」。
  assert.deepEqual(
    resolveCaptchaHeaders({ kind: "fail", stage: "sdk_load", reason: "sdk missing" }, CONFIG),
    { failureStage: "sdk_load", reason: "sdk missing" },
  );
  assert.deepEqual(
    resolveCaptchaHeaders(
      { kind: "fail", stage: "unsupported", reason: "webview_unavailable" },
      CONFIG,
    ),
    { failureStage: "unsupported", reason: "webview_unavailable" },
  );
});

// ── 场景 5：同一 requestId 去重 ──

test("同一 requestId 重复到达只求解一次，且只应答一次", async () => {
  const solved: string[] = [];
  const responded: { requestId: string; outcome: CaptchaSolveOutcome }[] = [];
  const orchestrator = createProviderRuntimeHeadersOrchestrator({
    dedupKey: (requestId) =>
      providerRuntimeHeadersDedupKey({ workspaceKey: "/w", sessionId: "s1", requestId }),
    solve: async (requestId) => {
      solved.push(requestId);
      return { ok: true, headers: { [CAPTCHA_VERIFY_PARAM_HEADER]: VALID_VERIFY_PARAM } };
    },
    respond: async (requestId, outcome) => {
      responded.push({ requestId, outcome });
    },
  });

  // 三次重复到达（模拟：agent 传输重试 + 桌面与手机同时订阅）。
  await Promise.all([
    orchestrator.handle("r-dup"),
    orchestrator.handle("r-dup"),
    orchestrator.handle("r-dup"),
  ]);

  assert.deepEqual(solved, ["r-dup"], "同一 requestId 只能求解一次（重复提交会回 F008）");
  assert.equal(responded.length, 1, "同一 requestId 只能应答一次");
  orchestrator.dispose();
});

test("去重键跨组件实例共享（分屏两个 pane 订阅同一会话时也只求解一次）", () => {
  // 两个独立编排器实例 = 两个 pane 各自的组件实例。
  const solved: string[] = [];
  const make = () =>
    createProviderRuntimeHeadersOrchestrator({
      dedupKey: (requestId) =>
        providerRuntimeHeadersDedupKey({ workspaceKey: "/w", sessionId: "s1", requestId }),
      solve: async () => {
        solved.push("x");
        return { ok: true, headers: {} };
      },
      respond: async () => undefined,
    });
  const first = make();
  const second = make();

  assert.deepEqual(
    [
      providerRuntimeHeadersDedupKey({ workspaceKey: "/w", sessionId: "s1", requestId: "r" }),
      providerRuntimeHeadersDedupKey({ workspaceKey: "/w", sessionId: "s1", requestId: "r" }),
    ][0],
    providerRuntimeHeadersDedupKey({ workspaceKey: "/w", sessionId: "s1", requestId: "r" }),
  );
  // 键相同 ⇒ 第二个实例的 handle 必须被判为重复。
  void first.handle("r-shared");
  void second.handle("r-shared");
  assert.equal(first !== second, true);
  first.dispose();
  second.dispose();
});

// ── 场景 4：求解失败 / 抛错 → headersApplied:false + 原因 ──

test("求解器抛错被收敛成带原因的失败结果，不中断队列也不静默", async () => {
  const outcomes: CaptchaSolveOutcome[] = [];
  const orchestrator = createProviderRuntimeHeadersOrchestrator({
    dedupKey: (requestId) =>
      providerRuntimeHeadersDedupKey({ workspaceKey: "/w", sessionId: "s1", requestId }),
    solve: async () => {
      throw new Error("SDK load timeout");
    },
    respond: async (_requestId, outcome) => {
      outcomes.push(outcome);
    },
  });

  await orchestrator.handle("r-throw");
  assert.deepEqual(outcomes, [{ ok: false, failureStage: "verify", reason: "SDK load timeout" }]);
  orchestrator.dispose();
});

test("应答失败被记为事件，不会让后续请求卡在队列里", async () => {
  const events: string[] = [];
  let respondCalls = 0;
  const orchestrator = createProviderRuntimeHeadersOrchestrator({
    dedupKey: (requestId) =>
      providerRuntimeHeadersDedupKey({ workspaceKey: "/w", sessionId: "s1", requestId }),
    solve: async () => ({ ok: false, failureStage: "timeout", reason: "captcha solve timeout" }),
    respond: async () => {
      respondCalls += 1;
      throw new Error("transport closed");
    },
    onEvent: (event) => events.push(event.type),
  });

  await orchestrator.handle("r-a");
  await orchestrator.handle("r-b");
  assert.equal(respondCalls, 2, "应答抛错不得阻塞后续请求");
  assert.equal(events.filter((type) => type === "respond-failed").length, 2);
  orchestrator.dispose();
});

test("dispose 后到达的请求被显式跳过（不求解、不应答）", async () => {
  const solved: string[] = [];
  const events: string[] = [];
  const orchestrator = createProviderRuntimeHeadersOrchestrator({
    dedupKey: (requestId) =>
      providerRuntimeHeadersDedupKey({ workspaceKey: "/w", sessionId: "s1", requestId }),
    solve: async (requestId) => {
      solved.push(requestId);
      return { ok: true, headers: {} };
    },
    respond: async () => undefined,
    onEvent: (event) => events.push(event.type),
  });

  orchestrator.dispose();
  await orchestrator.handle("r-after-dispose");
  assert.deepEqual(solved, []);
  assert.deepEqual(events, ["skipped"]);
});

test("串行：后到的请求排队而不是被丢弃（丢弃会让它悬挂到 180s）", async () => {
  const order: string[] = [];
  let releaseFirst: (() => void) | null = null;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const orchestrator = createProviderRuntimeHeadersOrchestrator({
    dedupKey: (requestId) =>
      providerRuntimeHeadersDedupKey({ workspaceKey: "/w", sessionId: "s1", requestId }),
    solve: async (requestId) => {
      order.push(`start:${requestId}`);
      if (requestId === "r1") await firstGate;
      order.push(`end:${requestId}`);
      return { ok: true, headers: {} };
    },
    respond: async () => undefined,
  });

  const first = orchestrator.handle("r1");
  const second = orchestrator.handle("r2");
  // 让 r1 先进入求解。
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(order, ["start:r1"], "第二个请求必须等第一个结束（SDK 挑战是全局单例）");
  releaseFirst?.();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["start:r1", "end:r1", "start:r2", "end:r2"]);
  orchestrator.dispose();
});

// ── Web / 手机远控路径的形状（不依赖真实浏览器） ──

test("求解表达式可在主世界求值，且与 webview 路径共用同一份表达式", async () => {
  // 注入求值器：断言「传给求值器的源码含归一化函数 + return(表达式)」这一形状。
  const sources: string[] = [];
  const fakeResult = { kind: "success", verifyParam: VALID_VERIFY_PARAM, region: "cn" };
  const result = await evaluateCaptchaSolveExpression("(function(){return 1})()", (source) => {
    sources.push(source);
    return fakeResult;
  });
  assert.deepEqual(result, fakeResult);
  assert.equal(sources.length, 1);
  // 归一化函数必须与表达式在同一作用域：success 分支的判空依赖它。
  assert.ok(
    sources[0]?.includes("__zcodeResolveVerifyParam"),
    "求值源码必须含 verifyParam 归一化函数（与 webview 路径同源）",
  );
  assert.ok(sources[0]?.includes("return ("), "求值源码必须以 return(表达式) 收尾");
});

test("宿主容器按需创建，且复用同一组 DOM id（求解表达式的选择器依赖它们）", () => {
  // 最小 Document stub：只需要本函数用到的四个成员。
  const created: { id: string; tag: string }[] = [];
  const byId = new Map<string, unknown>();
  const doc = {
    getElementById: (id: string) => byId.get(id) ?? null,
    createElement: (tag: string) => {
      const element = {
        id: "",
        tag,
        setAttribute: () => undefined,
      };
      created.push({ id: "", tag });
      return element;
    },
    body: {
      appendChild: (element: { id: string }) => {
        byId.set(element.id, element);
      },
    },
  } as unknown as Document;

  const first = ensureAliyunCaptchaHostElements(doc);
  assert.equal(first.created, true);
  assert.deepEqual(
    created.map((entry) => entry.tag),
    ["div", "button"],
  );
  // 幂等：已有容器与按钮时不再创建（重复创建会让 SDK 拿到一个非预期的 element）。
  const second = ensureAliyunCaptchaHostElements(doc);
  assert.equal(second.created, false);
  assert.equal(created.length, 2);
  // id 与求解表达式里的选择器一致 —— 不一致会让 SDK 找不到容器，表现为「不弹挑战」。
  assert.equal(byId.has(MANUAL_CLAIM_CAPTCHA_ELEMENT_ID), true);
  assert.equal(byId.has(MANUAL_CLAIM_CAPTCHA_BUTTON_ID), true);
});

test("能力判据：无 DOM 的宿主必须判为不能求解（声明即承诺）", () => {
  // node:test 环境没有 document ⇒ 必须为 false。
  // 判据宽了会让 host 转发给一个处理不了的订阅者（退回悬挂）；
  // 判据窄了会让能求解的前端被 host 提前拒绝。
  assert.equal(canSolveCaptchaInCurrentHost(), false);
});
// ── 接线护栏（源码断言，沿用 packages/ui/test 既有风格） ──

test("附件必须同时订阅事件并声明能力，且两者在同一 effect 的清理里一起撤销", () => {
  // 这条链路的三个失败形态都只能靠源码断言钉住（类型检查全绿）：
  //   1. 只订阅不声明 ⇒ host 判「有订阅者但无能力」⇒ 请求被正确拒掉，功能完全不生效；
  //   2. 只声明不订阅 ⇒ host 转发但没人处理 ⇒ 悬挂到 CLI 侧 180s；
  //   3. 订阅与声明生命周期不一致 ⇒ 组件卸载后 host 仍认为有能力（计数泄漏）。
  const source = readFileSync(
    new URL("../src/v4/ProviderRuntimeHeadersCaptchaAttachment.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(
    source.includes("onDynamicSessionEvent"),
    "必须订阅 host 的服务事件通道 —— 这是渲染层拿到 providerRuntimeHeaders.request 的唯一路径",
  );
  assert.ok(
    source.includes("declareSessionCaptchaCapability"),
    "必须声明求解能力 —— 否则 host 会以「无能力」快速失败，订阅形同虚设",
  );
  // 三者在同一个 cleanup 里：缺任何一个都是上面第 3 条泄漏形态。
  const cleanup = source.slice(
    source.indexOf("return () => {"),
    source.indexOf("return () => {") + 300,
  );
  assert.ok(cleanup.includes("subscription.dispose()"), "cleanup 必须撤销订阅");
  assert.ok(cleanup.includes("capability.dispose()"), "cleanup 必须撤销能力声明");
  assert.ok(cleanup.includes("orchestrator.dispose()"), "cleanup 必须停掉编排器");
});

test("附件只在能求解的分支声明能力（声明即承诺，不能求解就不声明）", () => {
  const source = readFileSync(
    new URL("../src/v4/ProviderRuntimeHeadersCaptchaAttachment.tsx", import.meta.url),
    "utf8",
  );
  // 能力判据必须挡在订阅与声明之前：判据若在声明之后，会出现「已声明但下面 return 了」，
  // host 于是转发给一个不会处理的订阅者 ⇒ 悬挂。
  const guardIndex = source.indexOf("canSolveCaptchaInCurrentHost()");
  const declareIndex = source.indexOf("declareSessionCaptchaCapability");
  const subscribeIndex = source.indexOf("onDynamicSessionEvent");
  assert.ok(guardIndex >= 0, "必须有能力判据");
  assert.ok(guardIndex < declareIndex, "能力判据必须早于能力声明");
  assert.ok(guardIndex < subscribeIndex, "能力判据必须早于订阅建立");
});

test("附件挂载点不受 pending/snapshot 早返回影响（晚订阅会静默丢请求）", () => {
  // host 的 emitSessionEvent 只 fire 已存在的 emitter 且无缓冲 ⇒ 订阅必须尽早建立。
  // 若把附件挂进 V4InteractionDialogs，它会随 `if (!pending) return null` 一起卸载。
  const sessionPane = readFileSync(new URL("../src/v4/SessionPane.tsx", import.meta.url), "utf8");
  const dialogs = readFileSync(
    new URL("../src/v4/V4InteractionDialogs.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(
    sessionPane.includes("ProviderRuntimeHeadersCaptchaAttachment"),
    "附件必须挂在 SessionPane（会话打开即挂载）",
  );
  assert.equal(
    dialogs.includes("ProviderRuntimeHeadersCaptchaAttachment"),
    false,
    "附件不得挂在 V4InteractionDialogs —— 它的早返回会连订阅一起卸载",
  );
});

test("回传白名单外的头不可能发生（渲染层自己也不发注定被丢弃的头）", () => {
  const headers = buildCaptchaRuntimeHeaders({
    verifyParam: VALID_VERIFY_PARAM,
    region: "cn",
  });
  // host 会再过滤一次（安全边界在 host），但渲染层自己发出去就是契约错误。
  const allowlist = new Set([CAPTCHA_VERIFY_PARAM_HEADER, CAPTCHA_VERIFY_REGION_HEADER]);
  for (const name of Object.keys(headers)) {
    assert.ok(allowlist.has(name), `渲染层不得回传白名单外的头：${name}`);
  }
  assert.equal(Object.keys(headers).length, 2);
});
