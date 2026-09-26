import assert from "node:assert/strict";
import test from "node:test";
import type { LanguageModel } from "ai";
import { ModelRetryReason } from "@zcode/contracts";
import { ProviderBusinessError } from "../src/model/model-execution.js";
import {
  CAPTCHA_REJECTION_PROVIDER_CODE,
  CaptchaRequestRetry,
  isCaptchaRejection,
} from "../src/model/captcha-retry.js";
import { runGenerateText } from "../src/model/runner-generate.js";
import { runStreamText } from "../src/model/runner-stream.js";
import type { AiSdkModelTextRequest, ResolvedAiSdkModel } from "../src/model/runner-runtime.js";

/**
 * start-plan 3007 验证码挑战的 agent 侧重试（spec §4.5 / 验收场景 C5、C6）。
 *
 * 为什么测在 runner 这一层而不是只测 `CaptchaRequestRetry`：本机制的全部风险在接线——
 * 3007 在码表里是 `AuthFailed + retryable:false`（与官方逐字一致，不得改），策略表对
 * AuthFailed 直接 stop。所以只有把「命中 3007 后确实发生了一次以 captcha-retry 取头的重试」
 * 打在真实的 runner 循环上，才能证明拦截点确实在分类器之前。
 *
 * 运行：
 *   cd apps/zcode-cli/packages/adapters && node --import tsx \
 *     --import ../../../../packages/services/test/support/zcodeSourceResolver.mjs \
 *     --test test/captchaRetry.test.ts
 */

/** 测试态不写 model-io 落盘（runner-debug 按 ZCODE_RUNTIME_ENV=test 短路）。 */
const TEST_ENV = { ZCODE_RUNTIME_ENV: "test" };

const TEST_PROPERTIES: ResolvedAiSdkModel["properties"] = {
  contextWindow: 200_000,
  inputFormat: {
    supportsAudio: false,
    supportsImage: false,
    supportsPdf: false,
    supportsText: true,
    supportsVideo: false,
  },
  outputFormat: { supportsText: true },
  requiresMfjsToolSchema: false,
  supportsJsonSchemaOutput: false,
  supportsMidConversationSystem: false,
  supportsNativeToolCall: false,
  supportsNativeWebSearch: false,
  supportsToolCall: false,
};

function startPlanAccess(mode: string): ResolvedAiSdkModel["accountAccess"] {
  return {
    accountType: "zai",
    entitled: true,
    mode: mode as NonNullable<ResolvedAiSdkModel["accountAccess"]>["mode"],
    type: "zhipu-account",
  };
}

function createResolved(mode: string): ResolvedAiSdkModel {
  return {
    accountAccess: startPlanAccess(mode),
    model: {} as unknown as LanguageModel,
    modelId: "test-model" as ResolvedAiSdkModel["modelId"],
    properties: TEST_PROPERTIES,
    providerId: "account:zai-start-plan" as ResolvedAiSdkModel["providerId"],
    // start-plan 的账号 provider 走 openai-compatible 方言（见 runner-options.ts 的
    // shouldIncludeStreamResponseBody 同款判定）。
    providerKind: "openai-compatible",
  };
}

function providerBusinessError(providerCode: string): ProviderBusinessError {
  return new ProviderBusinessError({
    providerCode,
    providerId: "account:zai-start-plan",
    providerKind: "openai-compatible",
    providerMessage: "Captcha verification failed or the verify token was rejected.",
    responseStatus: 200,
    statusCode: 403,
  });
}

interface HeaderRequest {
  attempt: number;
  reason: string | undefined;
}

/** 记录每次 attempt 刷新运行时请求头时的 reason —— 本测试的核心观测量。 */
function createHeaderRecorder(): {
  calls: HeaderRequest[];
  refresh: NonNullable<AiSdkModelTextRequest["refreshRuntimeHeadersBeforeAttempt"]>;
} {
  const calls: HeaderRequest[] = [];
  return {
    calls,
    refresh: async (input) => {
      calls.push({ attempt: input.attempt, reason: input.reason });
      return { headersApplied: true, requestAuth: { apiKey: "runtime-key" } };
    },
  };
}

const RETRY_OPTIONS = {
  backoffFactor: 2,
  baseDelayMs: 0,
  jitter: false,
  // 只留 1 次预算：3007 的重试必须靠它自己的额外额度发生，不能靠普通预算兜底。
  maxAttempts: 1,
  maxDelayMs: 0,
};

function generateRequest(
  refresh: NonNullable<AiSdkModelTextRequest["refreshRuntimeHeadersBeforeAttempt"]>,
  abortSignal?: AbortSignal,
): AiSdkModelTextRequest {
  return {
    maxOutputTokens: 64,
    messages: [{ content: "hi", role: "user" }],
    refreshRuntimeHeadersBeforeAttempt: refresh,
    ...(abortSignal ? { abortSignal } : {}),
  };
}

function okGenerateResult(text: string) {
  return {
    finishReason: "stop",
    text,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  } as never;
}

async function runGenerate(
  resolved: ResolvedAiSdkModel,
  request: AiSdkModelTextRequest,
  generateText: (options: unknown) => Promise<never>,
) {
  return runGenerateText({
    env: TEST_ENV,
    modelIoFullRetentionEnabled: false,
    request,
    resolved,
    resolveModel: () => resolved,
    retry: RETRY_OPTIONS,
    runtime: {
      generateText: generateText as never,
      streamText: (() => {
        throw new Error("streamText must not be called by runGenerateText");
      }) as never,
    },
  });
}

// ── isCaptchaRejection：判据本身 ────────────────────────────────────────────

test("isCaptchaRejection 只认 provider 业务码 3007", () => {
  assert.equal(CAPTCHA_REJECTION_PROVIDER_CODE, "3007");
  assert.equal(isCaptchaRejection(providerBusinessError("3007")), true);
  assert.equal(isCaptchaRejection(providerBusinessError("3008")), false);
  assert.equal(isCaptchaRejection(new Error("3007")), false);
  // 业务码藏在 cause 里（AI SDK 的包装形态）也必须认出来。
  assert.equal(
    isCaptchaRejection(new Error("wrapped", { cause: providerBusinessError("3007") })),
    true,
  );
});

// ── CaptchaRequestRetry：额度语义 ───────────────────────────────────────────

test("CaptchaRequestRetry：命中一次后 extraAttempts 并入预算，且 reason 只换一次", () => {
  const resolved = createResolved("start-plan");
  const retry = new CaptchaRequestRetry(
    generateRequest(async () => ({ headersApplied: true })),
    resolved,
  );

  assert.equal(retry.takeReason(), "model-request");
  assert.equal(retry.extraAttempts, 0);
  assert.equal(retry.claim(providerBusinessError("3007")), true);
  assert.equal(retry.extraAttempts, 1);
  // 认领后立刻取 reason：这一次 attempt 才是重新求解验证码的那一次。
  assert.equal(retry.takeReason(), "captcha-retry");
  // pending 已被消费：同一次请求不会再发出第二个 captcha-retry。
  assert.equal(retry.takeReason(), "model-request");
  // used 已置：第二次 3007 不再认领（「只重试一次」的不变量）。
  assert.equal(retry.claim(providerBusinessError("3007")), false);
  assert.equal(retry.extraAttempts, 1);
});

test("CaptchaRequestRetry：非 start-plan / 非 3007 / 无刷新端口 / 已取消 一律不认领", () => {
  const request = generateRequest(async () => ({ headersApplied: true }));

  assert.equal(
    new CaptchaRequestRetry(request, createResolved("individual-coding-plan")).claim(
      providerBusinessError("3007"),
    ),
    false,
  );
  assert.equal(
    new CaptchaRequestRetry(request, createResolved("team-coding-plan")).claim(
      providerBusinessError("3007"),
    ),
    false,
  );
  assert.equal(
    new CaptchaRequestRetry(request, createResolved("off-peak")).claim(
      providerBusinessError("3007"),
    ),
    false,
  );
  assert.equal(
    new CaptchaRequestRetry(request, createResolved("start-plan")).claim(
      providerBusinessError("3008"),
    ),
    false,
  );

  // 没有刷新端口：重试也拿不到新 token，认领只会白费一次物理请求。
  const noRefresh: AiSdkModelTextRequest = {
    maxOutputTokens: 64,
    messages: [{ content: "hi", role: "user" }],
  };
  assert.equal(
    new CaptchaRequestRetry(noRefresh, createResolved("start-plan")).claim(
      providerBusinessError("3007"),
    ),
    false,
  );

  // 用户已取消：不得再发一次请求。
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(
    new CaptchaRequestRetry(
      generateRequest(async () => ({ headersApplied: true }), aborted.signal),
      createResolved("start-plan"),
    ).claim(providerBusinessError("3007")),
    false,
  );
});

// ── runner 接线：generate 路径 ──────────────────────────────────────────────

test("3007 → 触发一次重试，且重试 attempt 的 reason 是 captcha-retry", async () => {
  const recorder = createHeaderRecorder();
  const seen: number[] = [];
  const result = await runGenerate(
    createResolved("start-plan"),
    generateRequest(recorder.refresh),
    async () => {
      seen.push(seen.length + 1);
      if (seen.length === 1) throw providerBusinessError("3007");
      return okGenerateResult("recovered");
    },
  );

  assert.equal(result.text, "recovered");
  assert.equal(seen.length, 2, "必须恰好发生 2 次物理请求（首次 + 一次重试）");
  assert.deepEqual(
    recorder.calls.map((call) => call.reason),
    ["model-request", "captcha-retry"],
  );
  assert.deepEqual(
    recorder.calls.map((call) => call.attempt),
    [1, 2],
  );
});

test("第二次仍是 3007 → 不再重试，按既有业务错误（AuthFailed）上报", async () => {
  const recorder = createHeaderRecorder();
  let calls = 0;
  const error = await runGenerate(
    createResolved("start-plan"),
    generateRequest(recorder.refresh),
    async () => {
      calls += 1;
      throw providerBusinessError("3007");
    },
  ).then(
    () => undefined,
    (failure: unknown) => failure,
  );

  assert.ok(error instanceof Error, "第二次 3007 必须抛出（不得静默成功）");
  assert.equal(calls, 2, "只允许重试一次 —— 第三次物理请求绝不能发生");
  assert.deepEqual(
    recorder.calls.map((call) => call.reason),
    ["model-request", "captcha-retry"],
  );
  const context = (error as { context?: Record<string, unknown> }).context;
  // 分类结果不被本机制修改：3007 仍是 AuthFailed + retryable:false（官方同款）。
  assert.equal(context?.reason, "auth_failed");
  assert.equal(context?.retryable, false);
});

test("非 3007 的业务码不触发该重试（3008 仍按原分类直接终态）", async () => {
  const recorder = createHeaderRecorder();
  let calls = 0;
  const error = await runGenerate(
    createResolved("start-plan"),
    generateRequest(recorder.refresh),
    async () => {
      calls += 1;
      throw providerBusinessError("3008");
    },
  ).then(
    () => undefined,
    (failure: unknown) => failure,
  );

  assert.ok(error instanceof Error);
  assert.equal(calls, 1);
  assert.deepEqual(
    recorder.calls.map((call) => call.reason),
    ["model-request"],
  );
});

test("非 start-plan（individual-coding-plan）即使回 3007 也不触发该重试", async () => {
  const recorder = createHeaderRecorder();
  let calls = 0;
  const error = await runGenerate(
    createResolved("individual-coding-plan"),
    generateRequest(recorder.refresh),
    async () => {
      calls += 1;
      throw providerBusinessError("3007");
    },
  ).then(
    () => undefined,
    (failure: unknown) => failure,
  );

  assert.ok(error instanceof Error);
  assert.equal(calls, 1);
  assert.deepEqual(
    recorder.calls.map((call) => call.reason),
    ["model-request"],
  );
});

// ── runner 接线：stream 路径（自然 EOF 合成的 3007 变体） ───────────────────

function createErroringStream(error: unknown, text?: string) {
  return function streamText(): never {
    const chunks =
      text === undefined
        ? [{ error, type: "error" }]
        : [
            { id: "t1", text, type: "text-delta" },
            { finishReason: "stop", type: "finish", usage: { totalTokens: 2 } },
          ];
    return {
      fullStream: (async function* generate() {
        for (const chunk of chunks) yield chunk;
      })(),
    } as never;
  };
}

async function runStream(
  resolved: ResolvedAiSdkModel,
  request: AiSdkModelTextRequest,
  streamText: () => never,
) {
  const events: unknown[] = [];
  const consume = async () => {
    for await (const event of runStreamText({
      env: TEST_ENV,
      modelIoFullRetentionEnabled: false,
      request,
      resolved,
      resolveModel: () => resolved,
      retry: RETRY_OPTIONS,
      runtime: {
        generateText: (() => {
          throw new Error("generateText must not be called by runStreamText");
        }) as never,
        streamText: streamText as never,
      },
      streamIdleTimeoutMs: 5_000,
    })) {
      events.push(event);
    }
  };
  return { consume, events };
}

test("stream：3007 走外层重试闸门，重试以 captcha-retry 重新取头", async () => {
  const recorder = createHeaderRecorder();
  const outcomes: string[] = [];
  const streamText = () => {
    outcomes.push("attempt");
    return createErroringStream(providerBusinessError("3007"))();
  };
  const { consume } = await runStream(
    createResolved("start-plan"),
    generateRequest(recorder.refresh),
    streamText as never,
  );

  const error = await consume().then(
    () => undefined,
    (failure: unknown) => failure,
  );

  // 第二次仍 3007：只重试一次后按既有分类终态上报。
  assert.ok(error instanceof Error);
  assert.equal(outcomes.length, 2, "必须恰好 2 次物理请求");
  assert.deepEqual(
    recorder.calls.map((call) => call.reason),
    ["model-request", "captcha-retry"],
  );
  assert.equal((error as { context?: Record<string, unknown> }).context?.reason, "auth_failed");
});

test("stream：非 start-plan 的 3007 只发一次请求（不进入验证码重试）", async () => {
  const recorder = createHeaderRecorder();
  let attempts = 0;
  const streamText = () => {
    attempts += 1;
    return createErroringStream(providerBusinessError("3007"))();
  };
  const { consume } = await runStream(
    createResolved("team-coding-plan"),
    generateRequest(recorder.refresh),
    streamText as never,
  );

  const error = await consume().then(
    () => undefined,
    (failure: unknown) => failure,
  );

  assert.ok(error instanceof Error);
  assert.equal(attempts, 1);
  assert.deepEqual(
    recorder.calls.map((call) => call.reason),
    ["model-request"],
  );
});

test("ModelRetryReason.AuthRefresh 仍是 3007 重试的对外 retryReason（不新增枚举值）", () => {
  // 重试事件复用既有的 auth_refresh（官方 CaptchaRequestRetry 分支亦传 Qc.AuthRefresh），
  // 因此不新增 ModelRetryReason 取值 —— 该断言钉住这一决定。
  assert.equal(ModelRetryReason.AuthRefresh, "auth_refresh");
});
