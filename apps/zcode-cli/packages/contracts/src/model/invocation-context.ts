import { AsyncLocalStorage } from "node:async_hooks";
import type { ZCodeProviderAccountAccess } from "@zcode/shared";
import type { ModelApiCallObservation } from "../telemetry/index.js";
import type { TraceContext } from "../tracing/tracer.js";
import type {
  ModelRequestAdmission,
  ModelRequestSessionType,
  ModelRetryBudget,
  ModelStatusSink,
  ModelStreamRecoveryStatus,
} from "./index.js";

/**
 * 模型请求 attempt 发送前刷新运行时请求头（provider runtime headers）的原因。
 *
 * - `model-request`：常规模型请求，含 adapter 内部重试的每一次 attempt。
 * - `captcha-retry`：start-plan 渠道收到网关的 3007 验证码挑战后触发的单次重试；
 *   渲染层据此重新求解验证码并回传新 token（对齐官方 `CaptchaRequestRetry.takeReason()`，
 *   见 docs/development/126-start-plan-3007-root-cause.md §2.1）。
 *
 * 抽成具名类型而不是在各处散落字面量联合：该值跨 adapter / core / bootstrap / 协议四处传递，
 * 任一处的字面量漂移都会让 `captcha-retry` 在链路中静默退化成普通请求（渲染层不重新求解）。
 */
export type ProviderRuntimeHeadersRequestReason = "model-request" | "captcha-retry";

/**
 * Runtime 与 Adapter 之间的调用级执行信息。
 *
 * 它不属于业务 ModelRequest，也不允许普通调用方据此改变 Provider 或模型身份。
 * Runtime 只在统一模型调用边界设置，Adapter 在同一异步调用链内读取。
 */
export interface ModelInvocationContext {
  metadata?: Record<string, unknown>;
  modelCall?: ModelApiCallObservation;
  modelRequestSessionType?: ModelRequestSessionType;
  /** 重试预算档位；runtime 按 taskType 决定，adapter 据此放宽瞬态失败的放弃条件。 */
  modelRetryBudget?: ModelRetryBudget;
  /** 准入端口；runtime 从 deps 带入，adapter 每次尝试先 acquire。 */
  modelRequestAdmission?: ModelRequestAdmission;
  statusSink?: ModelStatusSink;
  traceContext?: TraceContext;
  streamIdleTimeoutRetryNumber?: number;
  streamRecovery?: ModelStreamRecoveryStatus;
  preserveProviderStreamBoundaries?: boolean;
  refreshRuntimeHeadersBeforeAttempt?: (input: {
    accountAccess?: ZCodeProviderAccountAccess;
    attempt: number;
    reason?: ProviderRuntimeHeadersRequestReason;
    abortSignal?: AbortSignal;
    providerId: string;
    modelId: string;
    traceContext?: TraceContext;
  }) => Promise<{
    headersApplied: boolean;
    requestAuth?: ModelRequestAuth;
  }>;
}

/** Adapter 为单个物理请求 attempt 使用的动态鉴权材料。 */
export interface ModelRequestAuth {
  apiKey?: string;
  headers?: Record<string, string>;
}

export interface ModelRequestAuthSourceInput {
  attempt: number;
  abortSignal?: AbortSignal;
  providerId: string;
  modelId: string;
  traceContext?: TraceContext;
}

/** Model 创建时绑定、在每个物理请求 attempt 前解析的执行作用域鉴权来源。 */
export interface ModelRequestAuthSource {
  resolve(input: ModelRequestAuthSourceInput): Promise<ModelRequestAuth | undefined>;
}

export interface ModelRequestDependencies {
  /** 属性存在表示当前 Model 必须取得请求级鉴权；Source 缺失同样 fail-closed。 */
  requestAuth?: {
    source?: ModelRequestAuthSource;
  };
}

const modelInvocationStorage = new AsyncLocalStorage<ModelInvocationContext>();

export function getCurrentModelInvocationContext(): ModelInvocationContext | undefined {
  return modelInvocationStorage.getStore();
}

export function runWithModelInvocationContext<T>(context: ModelInvocationContext, run: () => T): T {
  const result = modelInvocationStorage.run(context, run);
  if (!isAsyncIterable(result)) return result;

  const source = result;
  return {
    [Symbol.asyncIterator]() {
      const iterator = source[Symbol.asyncIterator]();
      return {
        next: (value?: unknown) =>
          modelInvocationStorage.run(context, () => iterator.next(value as never)),
        return: (value?: unknown) =>
          modelInvocationStorage.run(context, () =>
            iterator.return
              ? iterator.return(value as never)
              : Promise.resolve({ done: true, value }),
          ),
        throw: (error?: unknown) =>
          modelInvocationStorage.run(context, () =>
            iterator.throw ? iterator.throw(error) : Promise.reject(error),
          ),
      };
    },
  } as T;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
  );
}
