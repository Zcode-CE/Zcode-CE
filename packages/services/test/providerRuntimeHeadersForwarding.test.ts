import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { collectServiceMemoryDiagnostics } from "../src/memoryDiagnostics.js";
import { createZCodeAgentService } from "../src/zcode-agent/zcodeAgentService.js";

/**
 * start-plan 验证码挑战链路：host 转发守卫 + 渲染层应答入口 + 头合并
 * （docs/development/130-start-plan-captcha-spec.md §4.2/§4.3，验收场景 A/B/F）。
 *
 * ## 为什么走真实链路，而不是只测合并函数
 *
 * 本批缺陷（126 报告 §2.3 / 129 报告 D1）是分支被简化：CE 把官方
 * `if (mr && Ze && Ze.mode !== "start-plan")` 写成了 `if (mr && Ze)`。
 * 这类缺陷的共同形态是「接线断了」——守卫、转发、应答入口、头合并四者缺一不可，
 * 而只测纯函数会全绿：
 *   · 只测 `mergeProviderRuntimeHeaders` ⇒ 测不到守卫写反（渲染层永远收不到请求）；
 *   · 只测守卫 ⇒ 测不到「应答入口不存在」（start-plan 变成必然立即失败，比 3007 更差）。
 *
 * 所以这里让 host 真的 spawn 一个假 app-server（LF 分帧 stdio，与
 * zcodeStdioTransport 同口径），走完
 *   host 收到反向请求 → 入 pending map → 广播给渲染层 → 渲染层应答 → 合并 → 回传 agent
 * 的完整路径，并从最终消费点（假 agent 收到的 result）断言。
 *
 * ## 假 agent 的能力边界（如实声明）
 *
 * 它只实现 `session/subscribe` 与主动发起 provider-runtime-headers 请求，
 * 其余方法回 -32601（host 有既有降级路径）。它不模拟真实模型请求，
 * 因此本测试证明的是「host 侧链路正确」，不证明「真实网关不再回 3007」。
 *
 * 运行：cd packages/services && node --import tsx --test test/providerRuntimeHeadersForwarding.test.ts
 */

const FAKE_AGENT = fileURLToPath(
  new URL("./support/fakeProviderRuntimeHeadersAgent.mjs", import.meta.url),
);

const START_PLAN_HEADERS = {
  "X-Aliyun-Captcha-Verify-Param": "verify-param-from-renderer",
  "X-Aliyun-Captcha-Verify-Region": "cn",
};

interface Harness {
  service: ReturnType<typeof createZCodeAgentService>;
  workspacePath: string;
  outPath: string;
  sessionId: string;
  requestId: string;
  /**
   * 写触发文件让假 agent 发一个请求（第二行可覆盖 accountAccess.mode）。
   * 用于需要精确控制「何时发」的用例（无订阅者 / 订阅者已 dispose）。
   */
  trigger(requestId: string, mode?: "start-plan" | "individual"): Promise<void>;
  /**
   * 启动 agent runtime 但不建立任何会话事件订阅。
   *
   * 为什么需要它：不启动 runtime 就根本收不到假 agent 的反向请求（没有 client/wire），
   * 那样测的是「进程没起来」而不是「无订阅者」。真实的无订阅者场景（Bot / 无 pane 会话）
   * 同样有活着的 runtime，只是没人订阅会话事件。
   */
  startRuntimeWithoutSubscription(): Promise<void>;
  /**
   * 声明本会话具备渲染验证码能力；返回句柄的 dispose 撤销。
   * 对应 spec §4.4 的第二道判据（有订阅者但无声明 ⇒ 仍快速失败）。
   */
  declareCaptchaCapability(): { dispose(): void };
  dispose(): Promise<void>;
}

/** 假 agent 落盘的应答记录（见 support/fakeProviderRuntimeHeadersAgent.mjs 的 record）。 */
type AgentRecord =
  | { kind: "result"; result: unknown }
  | { kind: "error"; error: unknown }
  | { kind: "unhandled-method"; method: string }
  | { kind: "parse-error"; message: string };

async function readRecords(outPath: string): Promise<AgentRecord[]> {
  try {
    const raw = await readFile(outPath, "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as AgentRecord);
  } catch {
    return [];
  }
}

/**
 * 等待某个条件成立（轮询 + 超时）。不 sleep 固定时长：host 侧链路是
 * spawn → 握手 → 订阅 → 反向请求，各步耗时随机器变化，固定 sleep 会变成 flaky。
 */
async function waitFor<T>(
  probe: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) {
      throw new Error(`waitFor 超时（${timeoutMs}ms）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * 装配一个真实 zcodeAgentService：假 app-server 经 commandResolver 注入，
 * accountRequestAuthService 用内存桩（不读真实凭据、不联网）。
 */
async function withService(
  t: TestContext,
  params: {
    mode: "start-plan" | "individual";
    /** 账号鉴权材料解析器；返回 undefined 表示「解析不出材料」。 */
    resolveAuth?: () => Promise<{ apiKey?: string; headers?: Record<string, string> }>;
  },
  run: (harness: Harness) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-provider-headers-"));
  const workspacePath = join(dir, "workspace");
  // spawn 的 cwd 必须真实存在：否则 spawn 直接 ENOENT，测试会以
  // "transport closed" 失败，看起来像协议问题而非夹具问题。
  await mkdir(workspacePath, { recursive: true });
  const outPath = join(dir, "agent-records.jsonl");
  const triggerPath = join(dir, "agent-trigger.txt");
  const sessionId = "session-captcha";
  const requestId = "request-captcha-1";

  const service = createZCodeAgentService({
    // 假 agent 的能力声明：supportsStorageStartup 缺省 false ⇒ client 不会等启动帧。
    commandResolver: () => ({
      command: process.execPath,
      args: [FAKE_AGENT],
      cwd: workspacePath,
      env: {
        FAKE_AGENT_OUT: outPath,
        FAKE_AGENT_MODE: params.mode,
        FAKE_AGENT_REQUEST_ID: requestId,
        FAKE_AGENT_SESSION_ID: sessionId,
        FAKE_AGENT_WORKSPACE: workspacePath,
        FAKE_AGENT_TRIGGER_FILE: triggerPath,
      },
    }),
    // 模型执行门禁：必须 ready，否则 getClient 抛 provider_not_ready，走不到订阅。
    modelSelectionReadinessSource: {
      getView: async () => ({
        revision: 1,
        providers: [
          {
            providerId: "zai-start-plan",
            providerName: "Z.ai Start Plan",
            templateId: "zai-start-plan",
            config: {},
            models: [{ modelId: "glm-5", config: {} }],
          },
        ],
      }),
    },
    accountRequestAuthService: {
      resolveAccessCurrent: async () => null,
      assertCurrent: async () => undefined,
      resolveCurrent: async () => {
        const material = params.resolveAuth ? await params.resolveAuth() : { apiKey: "acct-jwt" };
        if (!material) {
          throw new Error("Account request auth resolver returned no material");
        }
        return material;
      },
    },
  });

  t.after(async () => {
    await service.disposeAllAndWait().catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  await run({
    service,
    workspacePath,
    outPath,
    sessionId,
    requestId,
    async trigger(nextRequestId, mode) {
      // 内容变化才会触发（假 agent 按 token 去重），故带上 requestId 本身。
      const payload = mode ? `${nextRequestId}\n${mode}` : nextRequestId;
      await writeFile(triggerPath, `${payload}\n`, "utf8");
    },
    async startRuntimeWithoutSubscription() {
      // initialize 会经 getClient 拉起并 wire runtime，但不建立 session 订阅。
      await service.initialize({ workspacePath });
    },
    declareCaptchaCapability() {
      return service.declareSessionCaptchaCapability({ workspacePath, sessionId });
    },
    dispose: () => service.disposeAllAndWait(),
  });
}

/**
 * 建立 host → agent 的旧协议订阅面，从而让 host 真的收到假 agent 的反向请求。
 * 这是渲染层在 CE 里拿到 providerRuntimeHeaders.request 的既有通道。
 */
function subscribe(harness: Harness) {
  return harness.service.onDynamicSessionEvent({
    workspacePath: harness.workspacePath,
    sessionId: harness.sessionId,
    deliveryKind: "desktop-continuous",
  });
}

/**
 * 建立会话订阅并声明验证码能力 —— start-plan 正常转发路径的两个前提。
 *
 * 只订阅而不声明能力（Bot 链路正是这种形态）会命中 spec §4.4 的第二道判据并被
 * 快速失败，因此「期望正常转发」的用例必须用本函数，而不是裸 subscribe。
 */
function subscribeAsCaptchaCapableRenderer(harness: Harness, events: unknown[]) {
  const subscription = subscribe(harness)((event) => events.push(event));
  const capability = harness.declareCaptchaCapability();
  return {
    dispose() {
      // 先撤能力再断订阅：顺序不影响判定（两个条件都是「缺失即失败」），
      // 但先撤能力更贴近真实卸载时序（组件先注销能力，再释放订阅）。
      capability.dispose();
      subscription.dispose();
    },
  };
}

/** 从订阅事件流里等一个 providerRuntimeHeaders.request。 */
function waitForForwardedRequest(
  harness: Harness,
  events: unknown[],
): Promise<{ requestId: string; sessionId: string; workspace: { workspacePath: string } }> {
  return waitFor(() => {
    const hit = events.find(
      (event): event is { type: string; request: never } =>
        typeof event === "object" &&
        event !== null &&
        (event as { type?: unknown }).type === "providerRuntimeHeaders.request",
    );
    return hit?.request;
  });
}

// ── 验收场景 A1 / A2：start-plan 转发渲染层（不再短路自答） ──

test("start-plan：请求被转发到渲染层，而不是被 host 短路自答", async (t) => {
  await withService(t, { mode: "start-plan" }, async (harness) => {
    const events: unknown[] = [];
    const renderer = subscribeAsCaptchaCapableRenderer(harness, events);
    t.after(() => renderer.dispose());

    const request = await waitForForwardedRequest(harness, events);

    // 关键断言：渲染层真的收到了请求（守卫收紧前这里永远是空的）。
    assert.equal(request.sessionId, harness.sessionId);
    assert.equal(request.requestId, harness.requestId);
    assert.equal(request.workspace.workspacePath, harness.workspacePath);

    // 且 host 没有替它自答：假 agent 在渲染层应答前不应收到任何 result。
    const records = await readRecords(harness.outPath);
    assert.deepEqual(
      records.filter((record) => record.kind === "result" || record.kind === "error"),
      [],
      "start-plan 请求在渲染层应答前不得被 host 自答",
    );
  });
});

test("start-plan：渲染层应答后，白名单头被合并进 requestAuth.headers 回传 agent", async (t) => {
  await withService(t, { mode: "start-plan" }, async (harness) => {
    const events: unknown[] = [];
    const renderer = subscribeAsCaptchaCapableRenderer(harness, events);
    t.after(() => renderer.dispose());

    await waitForForwardedRequest(harness, events);
    await harness.service.respondProviderRuntimeHeaders({
      requestId: harness.requestId,
      sessionId: harness.sessionId,
      workspace: { workspacePath: harness.workspacePath, workspaceKey: harness.workspacePath },
      response: { headersApplied: true, runtimeProviderHeaders: START_PLAN_HEADERS },
    });

    // 打到最终消费点：假 agent 实际收到的 protocol result。
    const result = await waitFor(async () => {
      const records = await readRecords(harness.outPath);
      const hit = records.find((record) => record.kind === "result");
      return hit?.kind === "result" ? hit.result : undefined;
    });

    assert.deepEqual(result, {
      headersApplied: true,
      requestAuth: {
        // 账号材料（apiKey）与渲染层验证码头是合并关系，缺一不可：
        // 只有验证码头而没有账号 JWT 会被网关判成未鉴权。
        apiKey: "acct-jwt",
        headers: START_PLAN_HEADERS,
      },
    });
  });
});

// ── 验收场景 B3：非 start-plan 仍走 host 自答零 UI 快路径（防回归） ──

test("非 start-plan（individual）：仍由 host 自答，渲染层收不到请求", async (t) => {
  await withService(t, { mode: "individual" }, async (harness) => {
    const events: unknown[] = [];
    const renderer = subscribeAsCaptchaCapableRenderer(harness, events);
    t.after(() => renderer.dispose());

    const result = await waitFor(async () => {
      const records = await readRecords(harness.outPath);
      const hit = records.find((record) => record.kind === "result");
      return hit?.kind === "result" ? hit.result : undefined;
    });

    assert.deepEqual(result, { headersApplied: true, requestAuth: { apiKey: "acct-jwt" } });
    assert.equal(
      events.some(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          (event as { type?: unknown }).type === "providerRuntimeHeaders.request",
      ),
      false,
      "非 start-plan 必须保持「host 自答、零 UI」快路径，不得转发渲染层",
    );
  });
});

// ── 验收场景 F10：白名单外的头被忽略 ──

test("应答合并：白名单外的头被忽略，不得注入任意请求头", async (t) => {
  await withService(t, { mode: "start-plan" }, async (harness) => {
    const events: unknown[] = [];
    const renderer = subscribeAsCaptchaCapableRenderer(harness, events);
    t.after(() => renderer.dispose());

    await waitForForwardedRequest(harness, events);
    await harness.service.respondProviderRuntimeHeaders({
      requestId: harness.requestId,
      sessionId: harness.sessionId,
      workspace: { workspacePath: harness.workspacePath, workspaceKey: harness.workspacePath },
      response: {
        headersApplied: true,
        runtimeProviderHeaders: {
          ...START_PLAN_HEADERS,
          // 三个必须被丢弃的注入尝试：
          Authorization: "Bearer attacker",
          "X-Forwarded-For": "10.0.0.1",
          // 与白名单头仅「前缀相似」，不能因为 startsWith 之类的宽松匹配被放行。
          // 两个方向都要覆盖：更长的名字（Extra 后缀）与更短的名字
          // （只截白名单头的一段）。只测其中一个方向时，把精确匹配改成
          // `allowlist.startsWith(rendererName)` 会静默通过——实测过。
          "X-Aliyun-Captcha-Verify-Param-Extra": "nope",
          "X-Aliyun-Captcha-Verify": "shorter-prefix-nope",
          "x-aliyun": "even-shorter-nope",
        },
      },
    });

    const result = await waitFor(async () => {
      const records = await readRecords(harness.outPath);
      const hit = records.find((record) => record.kind === "result");
      return hit?.kind === "result" ? hit.result : undefined;
    });

    assert.deepEqual(result, {
      headersApplied: true,
      requestAuth: { apiKey: "acct-jwt", headers: START_PLAN_HEADERS },
    });
  });
});

test("应答合并：大小写不敏感匹配，且写入时归一为白名单规范大小写", async (t) => {
  await withService(t, { mode: "start-plan" }, async (harness) => {
    const events: unknown[] = [];
    const renderer = subscribeAsCaptchaCapableRenderer(harness, events);
    t.after(() => renderer.dispose());

    await waitForForwardedRequest(harness, events);
    await harness.service.respondProviderRuntimeHeaders({
      requestId: harness.requestId,
      sessionId: harness.sessionId,
      workspace: { workspacePath: harness.workspacePath, workspaceKey: harness.workspacePath },
      response: {
        headersApplied: true,
        runtimeProviderHeaders: {
          // 渲染层给的是全小写 + 两侧空白；官方用 toLowerCase 比较、写回规范名。
          "  x-aliyun-captcha-verify-param  ": "  spaced-param  ",
          "X-ALIYUN-CAPTCHA-VERIFY-REGION": "cn",
        },
      },
    });

    const result = await waitFor(async () => {
      const records = await readRecords(harness.outPath);
      const hit = records.find((record) => record.kind === "result");
      return hit?.kind === "result" ? hit.result : undefined;
    });

    assert.deepEqual(result, {
      headersApplied: true,
      requestAuth: {
        apiKey: "acct-jwt",
        headers: {
          "X-Aliyun-Captcha-Verify-Param": "spaced-param",
          "X-Aliyun-Captcha-Verify-Region": "cn",
        },
      },
    });
  });
});

// ── 验收场景 F11：重复应答同一 requestId 幂等 ──

test("应答入口：重复应答同一 requestId 幂等，不抛错且不产生第二个响应", async (t) => {
  await withService(t, { mode: "start-plan" }, async (harness) => {
    const events: unknown[] = [];
    const renderer = subscribeAsCaptchaCapableRenderer(harness, events);
    t.after(() => renderer.dispose());

    await waitForForwardedRequest(harness, events);
    const respondParams = {
      requestId: harness.requestId,
      sessionId: harness.sessionId,
      workspace: { workspacePath: harness.workspacePath, workspaceKey: harness.workspacePath },
      response: { headersApplied: true, runtimeProviderHeaders: START_PLAN_HEADERS },
    } as const;
    await harness.service.respondProviderRuntimeHeaders(respondParams);

    await waitFor(async () => {
      const records = await readRecords(harness.outPath);
      return records.some((record) => record.kind === "result") ? true : undefined;
    });

    // 第二次、第三次应答：pending 已删除 ⇒ 幂等 no-op，绝不能抛错给 UI
    // （弹窗重放 / 桌面与手机端并发应答都属正常路径）。
    await assert.doesNotReject(
      harness.service.respondProviderRuntimeHeaders(respondParams),
      "重复应答必须幂等",
    );
    await assert.doesNotReject(harness.service.respondProviderRuntimeHeaders(respondParams));

    // 且不得产生第二个 protocol 响应（同一 id 响应两次会让 agent 侧 pending 错乱）。
    const records = await readRecords(harness.outPath);
    assert.equal(
      records.filter((record) => record.kind === "result" || record.kind === "error").length,
      1,
      "同一 requestId 只允许回一个响应",
    );
  });
});

test("应答入口：对已取消（不存在）的 requestId 安静返回，不抛错", async (t) => {
  await withService(t, { mode: "start-plan" }, async (harness) => {
    await assert.doesNotReject(
      harness.service.respondProviderRuntimeHeaders({
        requestId: "never-existed",
        sessionId: harness.sessionId,
        workspace: { workspacePath: harness.workspacePath, workspaceKey: harness.workspacePath },
        response: { headersApplied: true, runtimeProviderHeaders: START_PLAN_HEADERS },
      }),
    );
  });
});

// ── 等待态护栏：转发后请求必须真的在 pending map 里（后续加「快速失败」时的回归护栏） ──

/**
 * 读 host 侧只读计数器 `agent.pendingProviderRuntimeHeaders`。
 *
 * 用既有的内存诊断 provider（services 的 registerMemoryDiagnosticsProvider，
 * 与 pendingPermissions/pendingUserInputs 同族）而不是新增测试专用接口：
 * 它是既有的纯读取观测面，且该计数本身此前就是漏记的。
 */
function pendingRuntimeHeadersCount(): number {
  return collectServiceMemoryDiagnostics()["agent.pendingProviderRuntimeHeaders"] ?? 0;
}

test("等待态：start-plan 转发后请求进入 pending（非被误删），应答后归零", async (t) => {
  await withService(t, { mode: "start-plan" }, async (harness) => {
    const events: unknown[] = [];
    const renderer = subscribeAsCaptchaCapableRenderer(harness, events);
    t.after(() => renderer.dispose());

    await waitForForwardedRequest(harness, events);

    // ★ 本用例是「无能力声明则快速失败」改动的回归护栏：
    // 正常路径（有渲染层、等待应答）必须保持在等待态。若快速失败判定写得太宽，
    // 把正常路径也一起拒掉，这里会先变红。
    assert.equal(
      pendingRuntimeHeadersCount(),
      1,
      "转发后请求必须留在 pendingProviderRuntimeHeaders 中等待应答，不能被误删",
    );

    await harness.service.respondProviderRuntimeHeaders({
      requestId: harness.requestId,
      sessionId: harness.sessionId,
      workspace: { workspacePath: harness.workspacePath, workspaceKey: harness.workspacePath },
      response: { headersApplied: true, runtimeProviderHeaders: START_PLAN_HEADERS },
    });

    // 应答后必须出清：否则 pending map 会随每次模型请求泄漏（每次 requestId 都不同，
    // 键永不复用，漏删就是无界增长）。
    await waitFor(() => (pendingRuntimeHeadersCount() === 0 ? true : undefined));
    assert.equal(pendingRuntimeHeadersCount(), 0, "应答后必须从 pending map 移除，不得泄漏");
  });
});

test("等待态：非 start-plan 自答路径不残留 pending", async (t) => {
  await withService(t, { mode: "individual" }, async (harness) => {
    // 必须先建立订阅：假 agent 只在收到 session/subscribe 后才发起取头请求
    // （与真实 agent 的时序一致——请求发生在会话订阅之后的模型请求前）。
    const events: unknown[] = [];
    const renderer = subscribeAsCaptchaCapableRenderer(harness, events);
    t.after(() => renderer.dispose());

    await waitFor(async () => {
      const records = await readRecords(harness.outPath);
      return records.some((record) => record.kind === "result") ? true : undefined;
    });
    // 自答路径同样必须出清：它是既有的 respondAccountRequestAuthWithoutInteraction 的 finally。
    assert.equal(pendingRuntimeHeadersCount(), 0, "自答路径不得残留 pending");
  });
});

// ── spec §4.4：无渲染层 ⇒ 快速失败（本组是「不得悬挂到 180s」的验收） ──

/**
 * 改写说明：本组用例的前身是「§4.4 现状：转发后无任何应答方时不会快速失败」，
 * 记录的是实现前的行为（无订阅者 ⇒ 悬挂）。§4.4 落地后它按预期变红，
 * 此处按「记录行为变更」的方式改写为断言快速失败，而不是删掉。
 */

/** 从假 agent 记录里等一个 protocol 响应。 */
function waitForAgentResponse(harness: Harness) {
  return waitFor(async () => {
    const records = await readRecords(harness.outPath);
    const hit = records.find((record) => record.kind === "result" || record.kind === "error");
    return hit;
  });
}

test("§4.4：无会话事件订阅者 ⇒ 立即快速失败，不悬挂", async (t) => {
  await withService(t, { mode: "start-plan" }, async (harness) => {
    // 拉起 runtime（真实无订阅者场景同样有活着的 runtime），但刻意不建立会话订阅：
    // 这正是 Bot / 无 pane 会话的形态。
    await harness.startRuntimeWithoutSubscription();
    await harness.trigger(harness.requestId);

    // 关键判据：必须很快拿到响应。若仍走旧的「emit 出去等应答」，这里会等到
    // waitFor 超时（15s）—— 远小于 CLI 侧 180s，足以区分两种行为。
    const record = await waitForAgentResponse(harness);
    assert.equal(record?.kind, "result", "应回 result 而不是 error");

    const result = (record as { kind: "result"; result: unknown }).result as {
      headersApplied: boolean;
      errorMessage?: string;
    };
    assert.equal(result.headersApplied, false);
    // 稳定码用于分支判定，文案用于人看：两者都必须出现。
    assert.ok(
      result.errorMessage?.startsWith("ZCODE_PROVIDER_RUNTIME_HEADERS_UNAVAILABLE"),
      `errorMessage 必须带稳定码前缀，实际：${result.errorMessage}`,
    );
    assert.match(result.errorMessage ?? "", /captcha/i, "文案要能让人看懂是验证码无法完成");

    // 且不得把请求留在 pending map 里（否则就是换了个地方泄漏）。
    assert.equal(pendingRuntimeHeadersCount(), 0, "快速失败后不得残留 pending");
  });
});

test("§4.4 反向护栏：有订阅者时正常转发、进 pending，不被误快速失败", async (t) => {
  await withService(t, { mode: "start-plan" }, async (harness) => {
    const events: unknown[] = [];
    const renderer = subscribeAsCaptchaCapableRenderer(harness, events);
    t.after(() => renderer.dispose());

    // 等订阅真正生效（onWillAddFirstListener 之后）再发请求。
    await waitFor(() => (pendingRuntimeHeadersCount() === 0 ? true : undefined));
    await harness.trigger(harness.requestId);

    await waitForForwardedRequest(harness, events);
    assert.equal(
      pendingRuntimeHeadersCount(),
      1,
      "有订阅者时必须转发并进入等待态，不能被快速失败拒掉",
    );

    // 且此刻还没有被快速失败（agent 尚未收到任何响应）。
    const records = await readRecords(harness.outPath);
    assert.deepEqual(
      records.filter((record) => record.kind === "result" || record.kind === "error"),
      [],
      "有订阅者时不得提前自答",
    );
  });
});

test("§4.4：订阅者 dispose 之后 ⇒ 再次请求快速失败（验证 last-listener 回调生效）", async (t) => {
  await withService(t, { mode: "start-plan" }, async (harness) => {
    const events: unknown[] = [];
    // 用完整渲染层（订阅 + 能力声明），这样撤销后两个条件同时缺失；
    // 断言落在「无订阅者」那个码上，证明 last-listener 回调确实把订阅计数清掉了，
    // 而不是只被能力判据兜住（那样这条用例就测不到 last-listener）。
    const renderer = subscribeAsCaptchaCapableRenderer(harness, events);

    await harness.trigger("request-before-dispose");
    await waitForForwardedRequest(harness, events);

    renderer.dispose();
    // last-listener 回调是同步的，但给它一个让步点避免依赖调用栈细节。
    await new Promise((resolve) => setTimeout(resolve, 50));

    await harness.trigger("request-after-dispose");

    const record = await waitForAgentResponse(harness);
    const result = (
      record as { kind: "result"; result: { headersApplied: boolean; errorMessage?: string } }
    ).result;
    assert.equal(result.headersApplied, false, "订阅者离开后必须快速失败");
    assert.ok(
      result.errorMessage?.startsWith("ZCODE_PROVIDER_RUNTIME_HEADERS_UNAVAILABLE"),
      `撤销订阅后应命中「无订阅者」码（证明 last-listener 生效），实际：${result.errorMessage}`,
    );
  });
});

test("§4.4 防回归：非 start-plan 不受「无订阅者」判定影响（仍走自答）", async (t) => {
  await withService(t, { mode: "individual" }, async (harness) => {
    // 同样不建立订阅：非 start-plan 必须仍然自答成功，而不是被快速失败拒掉。
    await harness.startRuntimeWithoutSubscription();
    await harness.trigger(harness.requestId, "individual");

    const record = await waitForAgentResponse(harness);
    const result = (record as { kind: "result"; result: unknown }).result as {
      headersApplied: boolean;
      requestAuth?: { apiKey?: string };
    };
    assert.equal(result.headersApplied, true, "非 start-plan 必须保持 host 自答快路径");
    assert.equal(result.requestAuth?.apiKey, "acct-jwt");
  });
});

// ── spec §4.4 第二道判据：有订阅者但无「验证码能力声明」 ⇒ 仍快速失败 ──

/**
 * 为什么需要这一组（两道判据解决不同问题）：
 * - 无订阅者 = 本端根本没有 UI（无 pane 后台会话、纯 CLI）；
 * - 有订阅者但无能力声明 = 订阅者不能求解验证码。CE 的 Bot 链路
 *   （adapter.onDynamicTaskEvent → botsService.watchTaskStream）正是后者：
 *   它订阅会话事件，但无法渲染/求解验证码。
 * 只做第一道判据会让 Bot 绕过判定、仍悬挂到 CLI 侧 180s。
 */

test("§4.4 能力判据：有订阅者但无能力声明 ⇒ 快速失败（Bot 场景回归护栏）", async (t) => {
  await withService(t, { mode: "start-plan" }, async (harness) => {
    const events: unknown[] = [];
    // 只订阅、不声明能力：逐字复刻 Bot 链路的形态。
    const subscription = subscribe(harness)((event) => events.push(event));
    t.after(() => subscription.dispose());

    await harness.trigger(harness.requestId);

    const record = await waitForAgentResponse(harness);
    const result = (
      record as { kind: "result"; result: { headersApplied: boolean; errorMessage?: string } }
    ).result;
    assert.equal(result.headersApplied, false, "不能求解验证码的订阅者不得让请求悬挂");
    // 必须命中「能力缺失」码，而不是「无订阅者」码 —— 运维定位时这是两回事。
    assert.ok(
      result.errorMessage?.startsWith("ZCODE_PROVIDER_RUNTIME_HEADERS_CAPABILITY_MISSING"),
      `应命中能力缺失码，实际：${result.errorMessage}`,
    );
    assert.equal(pendingRuntimeHeadersCount(), 0, "快速失败后不得残留 pending");
  });
});

test("§4.4 能力判据：有订阅者且有能力声明 ⇒ 正常转发进 pending", async (t) => {
  await withService(t, { mode: "start-plan" }, async (harness) => {
    const events: unknown[] = [];
    const renderer = subscribeAsCaptchaCapableRenderer(harness, events);
    t.after(() => renderer.dispose());

    await harness.trigger(harness.requestId);

    await waitForForwardedRequest(harness, events);
    assert.equal(pendingRuntimeHeadersCount(), 1, "有能力的渲染层必须正常进入等待态");
  });
});

test("§4.4 能力判据：能力声明 dispose 后 ⇒ 快速失败", async (t) => {
  await withService(t, { mode: "start-plan" }, async (harness) => {
    const events: unknown[] = [];
    const subscription = subscribe(harness)((event) => events.push(event));
    t.after(() => subscription.dispose());
    const capability = harness.declareCaptchaCapability();

    await harness.trigger("request-with-capability");
    await waitForForwardedRequest(harness, events);

    capability.dispose();
    await harness.trigger("request-after-capability-disposed");

    const record = await waitForAgentResponse(harness);
    const result = (
      record as { kind: "result"; result: { headersApplied: boolean; errorMessage?: string } }
    ).result;
    assert.equal(result.headersApplied, false, "能力撤销后必须快速失败");
    assert.ok(
      result.errorMessage?.startsWith("ZCODE_PROVIDER_RUNTIME_HEADERS_CAPABILITY_MISSING"),
      "订阅者仍在，因此应命中能力缺失码（证明是能力判据而非订阅判据生效）",
    );
  });
});

test("§4.4 计数语义：两个声明者只 dispose 一个 ⇒ 仍正常转发（防误撤）", async (t) => {
  await withService(t, { mode: "start-plan" }, async (harness) => {
    const events: unknown[] = [];
    const subscription = subscribe(harness)((event) => events.push(event));
    t.after(() => subscription.dispose());
    // 两个组件同时声明同一会话（例如会话面板与弹窗各持一份）。
    const first = harness.declareCaptchaCapability();
    const second = harness.declareCaptchaCapability();

    first.dispose();
    await harness.trigger(harness.requestId);

    // 若用 Set 而非计数，first.dispose() 会误撤，把仍在运行的 second 一起打掉，
    // 这里就会变成快速失败 —— 该断言正是钉住这个取舍。
    await waitForForwardedRequest(harness, events);
    assert.equal(pendingRuntimeHeadersCount(), 1, "仍有声明者时不得误撤能力");

    // 最后一个声明者撤销后才真正失效。
    second.dispose();
    await harness.trigger("request-after-both-disposed");
    const record = await waitForAgentResponse(harness);
    const result = (record as { kind: "result"; result: { headersApplied: boolean } }).result;
    assert.equal(result.headersApplied, false, "最后一个声明者撤销后必须快速失败");
  });
});

// ── 失败语义：渲染层报告求解失败时如实回传，不谎报 headersApplied ──

test("应答入口：渲染层报告失败时回传 headersApplied:false 与原因", async (t) => {
  await withService(t, { mode: "start-plan" }, async (harness) => {
    const events: unknown[] = [];
    const renderer = subscribeAsCaptchaCapableRenderer(harness, events);
    t.after(() => renderer.dispose());

    await waitForForwardedRequest(harness, events);
    await harness.service.respondProviderRuntimeHeaders({
      requestId: harness.requestId,
      sessionId: harness.sessionId,
      workspace: { workspacePath: harness.workspacePath, workspaceKey: harness.workspacePath },
      response: { headersApplied: false, errorMessage: "captcha challenge cancelled by user" },
    });

    const result = await waitFor(async () => {
      const records = await readRecords(harness.outPath);
      const hit = records.find((record) => record.kind === "result");
      return hit?.kind === "result" ? hit.result : undefined;
    });

    assert.deepEqual(result, {
      headersApplied: false,
      errorMessage: "captcha challenge cancelled by user",
    });
  });
});

test("应答入口：账号材料解析失败时回 headersApplied:false，不谎报成功", async (t) => {
  await withService(
    t,
    {
      mode: "start-plan",
      resolveAuth: async () => {
        throw new Error("Account request auth resolver returned no material");
      },
    },
    async (harness) => {
      const events: unknown[] = [];
      const renderer = subscribeAsCaptchaCapableRenderer(harness, events);
      t.after(() => renderer.dispose());

      await waitForForwardedRequest(harness, events);
      await harness.service.respondProviderRuntimeHeaders({
        requestId: harness.requestId,
        sessionId: harness.sessionId,
        workspace: { workspacePath: harness.workspacePath, workspaceKey: harness.workspacePath },
        response: { headersApplied: true, runtimeProviderHeaders: START_PLAN_HEADERS },
      });

      const result = await waitFor(async () => {
        const records = await readRecords(harness.outPath);
        const hit = records.find((record) => record.kind === "result");
        return hit?.kind === "result" ? hit.result : undefined;
      });

      assert.deepEqual(result, {
        headersApplied: false,
        errorMessage: "Account request auth resolver returned no material",
      });
    },
  );
});
