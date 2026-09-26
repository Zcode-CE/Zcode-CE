/**
 * start-plan 验证码求解的渲染层接线（订阅 host 服务事件 → 求解 → 应答）。
 *
 * ## 为什么需要这个组件（本文件是本轮修复的关键路径）
 *
 * host 侧把 start-plan 的运行时请求头请求经 CE 既有的 host→UI 服务事件通道
 * （ZCodeAgentServiceEvent 的 providerRuntimeHeaders.request 分支）转发给渲染层。
 * 该通道在本次修复前没有任何 UI 订阅者（全仓唯一订阅者是 zcodeTaskServiceAdapter
 * 到 botsService，而 Bot 不能求解验证码），因此 start-plan 请求会悬挂到 CLI 侧 180s 超时。
 *
 * 本组件补上这个订阅者，并声明「本端能求解」的能力。
 *
 * ## 为什么订阅必须尽早建立（本链路的硬约束）
 *
 * host 的 emitSessionEvent 是 sessionEmitters.get(key)?.fire(event) —— 只 fire 已存在的
 * emitter，且没有任何缓冲（zcodeAgentService.ts:1901）。permission / userInput 没这个问题，
 * 因为它们走 v4 投影的 pendingInteractions，有快照回放兜底；本事件刻意不进投影
 * （一次性凭据不入 store，见 zcodeTaskServiceAdapter.ts:1641 的 early-return）。
 *
 * 所以组件必须挂在「会话打开即挂载」的位置，订阅在首个 effect 里同步建立。
 * 本组件挂在 SessionPane 的 V4InteractionDialogs 旁（会话一打开就渲染），满足该约束。
 *
 * ## 能力声明（spec §4.4 的第二道判据）
 *
 * host 在转发前做三路判定：无订阅者则快速失败；有订阅者但无能力声明则快速失败；
 * 两者都有才转发。判据是「声明」而不是「订阅」的原因：Bot 链路也会订阅，
 * 但它不能求解验证码，只靠订阅探测会让 Bot 场景悬挂到 180s。
 *
 * 所以声明即承诺：只有真的能求解的宿主才声明。桌面（webview）与 Web / 手机远控（主世界
 * 加载 SDK）都能求解，因此两者都声明；判据是 canSolveCaptchaInCurrentHost()，
 * 与求解实现同源，避免「声明了却处理不了」的悬挂形态。
 *
 * ## 两个平台的载体差异
 *
 * - 桌面：Electron webview 加载 data: 宿主页（与 claim 平面同一形态）。webview 必须在
 *   求解期间可见 —— SDK 的 popup 浮层渲染在 guest 页面里，隐藏的 webview 里用户看不到挑战。
 *   因此桌面路径渲染一个对话框承载 webview，仅在求解进行中打开。
 * - Web / 手机远控：主世界动态插入 script 加载 SDK，挑战以 popup 浮层呈现在当前页面。
 *
 * ## 状态所有者
 *
 * | 状态 | 所有者 |
 * | --- | --- |
 * | 待应答请求 | host 的 pendingProviderRuntimeHeaders（键含 requestId） |
 * | 已处理 requestId / 串行队列 | 本组件持有的编排器实例（随挂载生命周期） |
 * | 求解对话框开合 | 本组件（useState，求解结束即关闭） |
 * | 验证码凭据 | 只在内存里从求解器传到应答调用，不落盘、不入 store、不进日志（spec §5 不变量 5） |
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ManualClaimCaptchaConfig,
  ZCodeProviderRuntimeHeadersRequestParams,
  ZCodeWorkspaceRef,
} from "@zcode/shared";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  CAPTCHA_SOLVE_TIMEOUT_MS,
  canSolveCaptchaInCurrentHost,
  resolveCaptchaHeaders,
  solveCaptchaInBrowser,
  solveCaptchaInWebview,
} from "@/v4/providerRuntimeCaptchaSolver.js";
import {
  createProviderRuntimeHeadersOrchestrator,
  providerRuntimeHeadersDedupKey,
  shouldHandleProviderRuntimeHeadersRequest,
  type CaptchaSolveOutcome,
} from "@/v4/providerRuntimeHeadersSolver.js";

export interface ProviderRuntimeHeadersCaptchaAttachmentProps {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string | undefined;
  remoteSessionId?: string | undefined;
  /** 平台判据：桌面走 webview 宿主，Web / 手机远控走主世界加载 SDK。 */
  isDesktop?: boolean | undefined;
}

export function ProviderRuntimeHeadersCaptchaAttachment({
  sessionId,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  isDesktop,
}: ProviderRuntimeHeadersCaptchaAttachmentProps) {
  const services = useServices();
  const { intl, locale } = useZCodeIntl();
  const webviewRef = useRef<ElectronWebviewTag | null>(null);
  // 求解闭包读 ref，避免 effect 因 locale / isDesktop 变化重建而丢掉去重集合
  // （重建会让同一个 requestId 被求解两次，第二次必然命中阿里云 F008 重复提交）。
  const solveContextRef = useRef({ isDesktop, locale, services });
  solveContextRef.current = { isDesktop, locale, services };
  // requestId 到该请求的应答闭包（绑定 sessionId / workspace）。
  const pendingRepliesRef = useRef(
    new Map<string, (outcome: CaptchaSolveOutcome) => Promise<void>>(),
  );
  // 去重键与订阅身份都读 ref：编排器只建一次（重建会丢进程级集合以外的队列状态），
  // 而这些值随 scope 变化，不能进 useMemo 依赖。
  const workspaceKeyRef = useRef(workspaceIdentity?.trim() || workspacePath);
  workspaceKeyRef.current = workspaceIdentity?.trim() || workspacePath;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  // 桌面端求解期间打开承载 webview 的对话框；null 表示当前无求解。
  const [solveDialogOpen, setSolveDialogOpen] = useState(false);

  const orchestrator = useMemo(
    () =>
      createProviderRuntimeHeadersOrchestrator({
        // 进程级去重键：同一 requestId 经不同 pane / 订阅者到达时只求解一次。
        dedupKey: (requestId) =>
          providerRuntimeHeadersDedupKey({
            workspaceKey: workspaceKeyRef.current,
            sessionId: sessionIdRef.current,
            requestId,
          }),
        solve: () => solveOnceRef.current(),
        respond: async (requestId, outcome) => {
          const reply = pendingRepliesRef.current.get(requestId);
          pendingRepliesRef.current.delete(requestId);
          if (!reply) {
            logger.warn("[provider-runtime-captcha] 找不到该 requestId 的应答目标", { requestId });
            return;
          }
          await reply(outcome);
        },
        onEvent: (event) => {
          if (event.type === "solve-failed") {
            logger.warn("[provider-runtime-captcha] 求解失败", {
              requestId: event.requestId,
              failureStage: event.failureStage,
              reason: event.reason,
            });
            return;
          }
          logger.debug("[provider-runtime-captcha] 求解事件", { type: event.type });
        },
      }),
    [],
  );

  const solveOnce = useCallback(async (): Promise<CaptchaSolveOutcome> => {
    const {
      isDesktop: desktop,
      locale: currentLocale,
      services: currentServices,
    } = solveContextRef.current;
    const config = await resolveCaptchaConfig(currentServices.codingPlanSubscriptionService);
    if (!config) {
      // 拿不到配置就没有可求解的挑战参数：显式失败并给可读原因，不静默。
      return { ok: false, failureStage: "sdk_load", reason: "captcha_config_unavailable" };
    }
    if (!config.enabled) {
      // 活动未开验证码：服务端不会校验验证码头，但也不能发空凭据（会拿 3007）。
      return { ok: false, failureStage: "unsupported", reason: "captcha_disabled" };
    }
    // 桌面端必须先把承载 webview 的对话框打开（隐藏的 webview 里用户看不到挑战浮层）。
    if (desktop) {
      setSolveDialogOpen(true);
      await waitForWebviewMounted(webviewRef);
    }
    try {
      const message = desktop
        ? await solveCaptchaInWebview({
            element: webviewRef.current,
            config,
            timeoutMs: CAPTCHA_SOLVE_TIMEOUT_MS,
            ...(currentLocale ? { locale: currentLocale } : {}),
          })
        : await solveCaptchaInBrowser({
            config,
            timeoutMs: CAPTCHA_SOLVE_TIMEOUT_MS,
            doc: document,
          });
      const resolved = resolveCaptchaHeaders(message, config);
      if ("headers" in resolved) {
        return { ok: true, headers: resolved.headers };
      }
      return { ok: false, failureStage: resolved.failureStage, reason: resolved.reason };
    } finally {
      setSolveDialogOpen(false);
    }
  }, []);
  const solveOnceRef = useRef(solveOnce);
  solveOnceRef.current = solveOnce;

  useEffect(() => {
    const agentService = services.zcodeAgentService;
    // 不能求解的宿主不订阅也不声明：声明即承诺，否则 host 会转发给一个处理不了的订阅者，
    // 又变回「转发了但没人处理」的悬挂（spec §4.4）。
    if (!canSolveCaptchaInCurrentHost()) {
      logger.debug("[provider-runtime-captcha] 当前宿主无 DOM，跳过订阅与能力声明");
      return;
    }
    const replies = pendingRepliesRef.current;
    const target = {
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
      sessionId,
    };

    const subscription = agentService.onDynamicSessionEvent({
      ...target,
      deliveryKind: isDesktop ? "desktop-continuous" : "web-remote-replayable",
    })((event) => {
      if (event.type !== "providerRuntimeHeaders.request") return;
      const request = event.request as ZCodeProviderRuntimeHeadersRequestParams;
      // 非 start-plan 不该走到这里（host 会自答短路）。再判一次是防回归的第二道闸：
      // 误判会让用户白看一次验证码挑战。
      if (!shouldHandleProviderRuntimeHeadersRequest(request)) {
        logger.debug("[provider-runtime-captcha] 非 start-plan 请求，跳过", {
          mode: request.accountAccess?.mode ?? null,
        });
        return;
      }
      const workspace = toWorkspaceRef(request, workspacePath);
      // 摘除由 orchestrator 的 respond 回调统一负责（见 pendingRepliesRef 的读点），
      // 此处只登记：应答路径是「编排器 solve 完成 → respond(requestId) → 取闭包并删除」，
      // 保证每个 requestId 的闭包在应答后立即释放，不在长会话里按请求数累积。
      replies.set(request.requestId, (outcome) => respondToHost(request, workspace, outcome));
      void orchestrator.handle(request.requestId);
    });

    // 能力声明必须与订阅同生命周期建立与撤销（host 按计数管理，dispose 幂等）。
    const capability = agentService.declareSessionCaptchaCapability(target);

    // 订阅建立日志：本链路的失败形态是「UI 静默收不到事件」，真机排查需要这一条。
    logger.debug("[provider-runtime-captcha] 已订阅 providerRuntimeHeaders.request", {
      sessionId,
      workspacePath,
      isDesktop: Boolean(isDesktop),
    });

    async function respondToHost(
      request: ZCodeProviderRuntimeHeadersRequestParams,
      workspace: ZCodeWorkspaceRef,
      outcome: CaptchaSolveOutcome,
    ): Promise<void> {
      // 失败分支的协议 schema 只接受 errorMessage，且是 .strict()：不能多传字段。
      // 成功分支不带 requestAuth：账号鉴权材料由 host 自己 resolveAccountRequestAuth 解析
      // （host 只读 response.runtimeProviderHeaders），渲染层不应提供它 —— 与官方 renderer
      // 发的 {headersApplied:true, runtimeProviderHeaders} 形态一致。
      const response = outcome.ok
        ? ({ headersApplied: true, runtimeProviderHeaders: outcome.headers } as const)
        : ({
            headersApplied: false,
            errorMessage: `${outcome.failureStage}: ${outcome.reason}`,
          } as const);
      await agentService.respondProviderRuntimeHeaders({
        requestId: request.requestId,
        sessionId: request.sessionId,
        workspace,
        response,
      });
      logger.debug("[provider-runtime-captcha] 已应答 host", {
        requestId: request.requestId,
        sessionId: request.sessionId,
        headersApplied: outcome.ok,
      });
    }

    return () => {
      subscription.dispose();
      capability.dispose();
      orchestrator.dispose();
      replies.clear();
    };
  }, [
    services.zcodeAgentService,
    sessionId,
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    isDesktop,
    orchestrator,
  ]);

  // Web / 手机远控：挑战浮层由 SDK 自建在当前页面，组件本身不渲染任何可见内容。
  if (!isDesktop) {
    return null;
  }

  return (
    <Dialog open={solveDialogOpen} onOpenChange={() => undefined}>
      <DialogContent className="max-w-lg" data-testid="provider-runtime-captcha-dialog">
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({ id: "settings.modelProvider.manualClaim.captcha.title" })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "settings.modelProvider.manualClaim.captcha.description" })}
          </DialogDescription>
        </DialogHeader>
        {/* webview 必须可见：SDK 的 popup 挑战渲染在 guest 页面内，隐藏容器里用户看不到它。
            宿主页是 data: URL，与 claim 平面同一形态（已被 will-attach-webview 白名单放行）。 */}
        <webview
          ref={webviewRef}
          partition="zcode-provider-runtime-captcha"
          className="h-[420px] w-full rounded-lg border border-border bg-background"
          data-testid="provider-runtime-captcha-webview"
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * 等承载 webview 的对话框完成挂载。
 *
 * Electron 只在节点插入文档之后才把 loadURL / executeJavaScript 挂到 webview 元素上
 * （claim 平面实测：detached 时 typeof el.loadURL === "undefined"）。setState 到 DOM 提交
 * 之间隔着至少一帧，因此必须轮询而不是立即取 ref。
 */
async function waitForWebviewMounted(
  ref: { current: ElectronWebviewTag | null },
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ref.current) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** 事件里的 workspace 是 host 广播的权威引用；缺路径时回落到本组件的 scope。 */
function toWorkspaceRef(
  request: ZCodeProviderRuntimeHeadersRequestParams,
  fallbackWorkspacePath: string,
): ZCodeWorkspaceRef {
  return {
    workspacePath: request.workspace.workspacePath || fallbackWorkspacePath,
    workspaceKey: request.workspace.workspaceKey,
    ...(request.workspace.workspaceIdentity
      ? { workspaceIdentity: request.workspace.workspaceIdentity }
      : {}),
    ...(request.workspace.remoteSessionId
      ? { remoteSessionId: request.workspace.remoteSessionId }
      : {}),
  };
}

/**
 * 求解配置（sceneId / prefix / region）。
 *
 * 与 claim 平面同源：走 codingPlanSubscriptionService.getManualClaimCaptchaConfig()
 * （服务层 60s 快照，配置来自 /api/v1/client/configs 的 configs.captcha）。
 * 不新建第二份配置来源 —— 验证码活动是同一个，两个平面读同一份配置。
 */
async function resolveCaptchaConfig(
  service: { getManualClaimCaptchaConfig(): Promise<ManualClaimCaptchaConfig | null> } | undefined,
): Promise<ManualClaimCaptchaConfig | null> {
  if (!service) return null;
  try {
    const config = await service.getManualClaimCaptchaConfig();
    if (!config?.prefix || !config.sceneId || !config.region) {
      return null;
    }
    return config;
  } catch (error) {
    logger.warn("[provider-runtime-captcha] 读取验证码配置失败", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
