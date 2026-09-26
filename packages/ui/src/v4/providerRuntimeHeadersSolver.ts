/**
 * start-plan 运行时请求头的渲染层编排（纯逻辑，无 React、无 DOM）。
 *
 * ## 为什么单独一层
 *
 * 这条链路有三段必须一起正确：订阅服务事件 → 求解验证码 → 应答 host。其中
 * 「过滤 / 去重 / 串行 / 失败归因」是纯逻辑，可以脱离 React 与浏览器直接单测；
 * 把它塞进组件会让这些断言只能靠渲染树验证，代价高且脆弱。
 *
 * ## 状态所有者
 *
 * | 状态 | 所有者 | 说明 |
 * | --- | --- | --- |
 * | 待应答请求 | host 的 pendingProviderRuntimeHeaders（键含 requestId） | 本层不持有队列 |
 * | 已处理 requestId | 本层（Set，随实例生命周期） | 同一 requestId 只求解一次 |
 * | 求解串行队列 | 本层（链式 promise） | 阿里云 SDK 挑战是全局单例，不能并发 |
 * | 凭据本身 | 只在内存里从求解器传到应答调用 | 不落盘、不入 store、不进日志（spec §5 不变量 5） |
 *
 * ## 为什么去重是必需的
 *
 * 官方 renderer 对同一 requestId 做了 coalesce（实测其 bundle 里有
 * `provider runtime headers request coalesced` 分支），因为：
 * 1. agent 侧同一 requestId 可能因传输重试而重发；
 * 2. 桌面端与手机远控可能同时订阅同一会话；
 * 3. host 的 `respondProviderRuntimeHeaders` 虽幂等，但重复求解会消耗掉一次挑战
 *    （阿里云对同一挑战重复提交会回 F008「重复提交」），第二次必然失败并覆盖第一次的成功。
 * 因此去重必须发生在求解之前，不能只依赖 host 侧幂等。
 */
import type { ZCodeProviderRuntimeHeadersRequestParams } from "@zcode/shared";

/**
 * 判定一个请求是否属于本平面。
 *
 * 只有 start-plan 的 account provider 需要渲染层求解验证码：
 * - 非 start-plan（individual / team / off-peak）走 host 自答零 UI 快路径，
 *   host 根本不会转发（spec §5 不变量 1），渲染层收到即为异常；
 * - 无 accountAccess 的请求由 host 走「无凭据解析器」快速失败分支。
 *
 * 这里再判一次是防回归的第二道闸：host 守卫若被改回「有 accountAccess 就短路」或反向放宽，
 * UI 侧不会误求解一个不该求解的请求（那会白弹一次验证码挑战）。
 */
export function isStartPlanCaptchaRequest(
  request: Pick<ZCodeProviderRuntimeHeadersRequestParams, "accountAccess">,
): boolean {
  return request.accountAccess?.mode === "start-plan";
}

/** 一次求解的结果：成功给白名单头，失败给可归因的阶段与原因。 */
export type CaptchaSolveOutcome =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; failureStage: string; reason: string };

export type ProviderRuntimeHeadersOrchestratorEvent =
  | { type: "skipped"; reason: "duplicate-request" | "disposed" }
  | { type: "solve-started"; requestId: string }
  | { type: "solve-succeeded"; requestId: string }
  | { type: "solve-failed"; requestId: string; failureStage: string; reason: string }
  | { type: "respond-failed"; requestId: string; error: string };

export interface ProviderRuntimeHeadersOrchestratorOptions {
  /**
   * 求解一次验证码。实现方负责 SDK 加载与超时；本层只保证「同一时刻只跑一个」。
   * 抛错会被收敛成带原因的失败结果，不会中断队列。
   */
  solve: (requestId: string) => Promise<CaptchaSolveOutcome>;
  /**
   * 由 requestId 计算进程级去重键。调用方把 workspaceKey / sessionId 拼进去，
   * 使「同一 requestId 经不同订阅者到达」也只求解一次。
   */
  dedupKey: (requestId: string) => string;
  /**
   * 把结果回传 host。成功与失败都必须调用（失败带 headersApplied:false + 原因），
   * 静默是唯一不被允许的形态（spec §5 失败语义）。
   */
  respond: (requestId: string, outcome: CaptchaSolveOutcome) => Promise<void>;
  /** 观测钩子，便于真机排查与单测断言。默认 no-op。 */
  onEvent?: (event: ProviderRuntimeHeadersOrchestratorEvent) => void;
}

/**
 * 编排器：串行处理同一会话上的求解请求。
 *
 * 串行是刻意的：阿里云 SDK 的挑战是全局单例（官方 bundle 用模块级变量守
 * 「Captcha verification is already in progress」），并发初始化会互相打断。
 * 后到的请求排队而不是被丢弃 —— 丢弃会让那个 requestId 的 agent 请求悬挂到 180s。
 */
export interface ProviderRuntimeHeadersOrchestrator {
  /** 处理一个已过滤的 start-plan 请求。返回的 promise 在应答完成后 resolve。 */
  handle(requestId: string): Promise<void>;
  /** 停止接受新请求。 */
  dispose(): void;
}

/**
 * 进程级已处理 requestId 集合（有界）。
 *
 * 为什么不能只用组件实例级的 Set：同一个会话可能同时被多个组件订阅 —— 分屏的两个 pane
 * 显示同一会话、或主 pane 与侧栏同时挂载。实例级去重会让两边各求解一次，而阿里云对同一
 * 挑战的第二次提交会回 F008「重复提交」，后一次失败会覆盖前一次的成功。
 * 因此去重必须落在进程级，键为 `workspaceKey\u0000sessionId\u0000requestId`。
 *
 * 有界（LRU 式淘汰最旧）是必要的：requestId 是每次请求新生成的 UUID，不设上限会随
 * 长时间运行无界增长。256 远超同一时刻的可能并发量，且被淘汰的都是早已应答完的旧请求。
 */
const handledRequestIds = new Set<string>();
const handledRequestIdOrder: string[] = [];
const MAX_TRACKED_REQUEST_IDS = 256;

/** 记录一次处理；返回 false 表示该 requestId 已被处理过（调用方必须跳过）。 */
function rememberHandledRequestId(key: string): boolean {
  if (handledRequestIds.has(key)) {
    return false;
  }
  handledRequestIds.add(key);
  handledRequestIdOrder.push(key);
  while (handledRequestIdOrder.length > MAX_TRACKED_REQUEST_IDS) {
    const removed = handledRequestIdOrder.shift();
    if (removed) handledRequestIds.delete(removed);
  }
  return true;
}

/** 组装去重键。sessionId 与 requestId 都参与：requestId 本身全局唯一，加 session 便于诊断。 */
export function providerRuntimeHeadersDedupKey(params: {
  workspaceKey: string;
  sessionId: string;
  requestId: string;
}): string {
  return `${params.workspaceKey}\u0000${params.sessionId}\u0000${params.requestId}`;
}

export function createProviderRuntimeHeadersOrchestrator(
  options: ProviderRuntimeHeadersOrchestratorOptions,
): ProviderRuntimeHeadersOrchestrator {
  let disposed = false;
  // 串行队列：用链式 promise 保证「同一时刻只有一个求解」且不丢请求。
  let chain: Promise<void> = Promise.resolve();

  const emit = (event: ProviderRuntimeHeadersOrchestratorEvent): void => {
    options.onEvent?.(event);
  };

  async function runOne(requestId: string): Promise<void> {
    let outcome: CaptchaSolveOutcome;
    try {
      emit({ type: "solve-started", requestId });
      outcome = await options.solve(requestId);
    } catch (error) {
      // 求解器抛错也必须回一个可读原因，不能静默（spec §5 失败语义）。
      outcome = {
        ok: false,
        failureStage: "verify",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (outcome.ok) {
      emit({ type: "solve-succeeded", requestId });
    } else {
      emit({
        type: "solve-failed",
        requestId,
        failureStage: outcome.failureStage,
        reason: outcome.reason,
      });
    }
    try {
      await options.respond(requestId, outcome);
    } catch (error) {
      // 应答失败无法再补救（host 侧幂等，重复应答是 no-op），但必须可观测。
      emit({
        type: "respond-failed",
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    handle(requestId: string): Promise<void> {
      if (disposed) {
        emit({ type: "skipped", reason: "disposed" });
        return Promise.resolve();
      }
      // 去重必须在求解之前：重复求解会消耗掉一次挑战，第二次必然回 F008 重复提交，
      // 且失败结果会覆盖第一次的成功。判据落在进程级（见 handledRequestIds 的说明），
      // 因为同一会话可能同时被多个 pane / 多个订阅者持有。
      if (!rememberHandledRequestId(options.dedupKey(requestId))) {
        emit({ type: "skipped", reason: "duplicate-request" });
        return Promise.resolve();
      }
      // 排队而不是并发：后到的请求必须被处理，否则它的 agent 请求会悬挂到 180s。
      chain = chain.then(
        () => runOne(requestId),
        () => runOne(requestId),
      );
      return chain;
    },
    dispose(): void {
      disposed = true;
    },
  };
}

/**
 * 判定请求是否应当由本平面处理。
 *
 * 非 start-plan 显式返回 false 而不是「当作要处理」：这条路径上任何误判都会让用户
 * 白看一次验证码挑战，属于可感知的体验缺陷。
 */
export function shouldHandleProviderRuntimeHeadersRequest(
  request: Pick<ZCodeProviderRuntimeHeadersRequestParams, "accountAccess">,
): boolean {
  return isStartPlanCaptchaRequest(request);
}
