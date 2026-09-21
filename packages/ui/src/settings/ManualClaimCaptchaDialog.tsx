/**
 * 手动领取（周末 / 体验套餐）的验证码求解对话框。
 *
 * ## 状态所有者
 *
 * | 状态 | 所有者 |
 * | --- | --- |
 * | 验证码配置（sceneId/prefix/region） | host 侧 `getManualClaimCaptchaConfig()`（60s 快照） |
 * | 求解过程（加载中 / 成功 / 失败） | **本组件**（`useState`，随对话框卸载即丢弃） |
 * | verifyParam | **不落盘、不入 store**：一次性的验证凭据，只在内存里从 webview 传到 claim 请求 |
 * | 领取结果 | host 侧 `claimManualPlan()` 的返回值，由调用方（设置页卡片）持有 |
 *
 * ## 接口
 *
 * ```ts
 * <ManualClaimCaptchaDialog
 *   open                       // 由调用方控制显隐
 *   config={ManualClaimCaptchaConfig}
 *   onOpenChange(open)         // 用户关闭
 *   onSolved(solution)         // 求解成功，把 { verifyParam, region } 交给调用方去 claim
 *   onFailed(stage, reason)    // 求解失败，调用方决定提示文案
 * />
 * ```
 *
 * ## 为什么用 webview 而不是在 App 页面里加载 SDK
 *
 * 官方 renderer 是在自己的页面里直接加载 `AliyunCaptcha.js` 的。CE 的 renderer 是 App
 * 主世界，把第三方 CDN 脚本注入主世界会同时带来两个问题：脚本能访问 App 的 DOM 与
 * 全局状态；以及 App 的 CSP/打包约束要为它开口子。
 *
 * 用 Electron `<webview>` 承载则得到一个**真实但隔离**的 Chromium 环境：
 * 真实 DOM/WebGL/指纹（风控期望），同时 `sandbox: true` + `contextIsolation: true`
 * （由 `desktopWindowChrome.ts` 的 `will-attach-webview` 强制），页面拿不到 Node 与 App 状态。
 * 宿主页用 `data:` URL，`executeJavaScript` 的返回值即求解结果，
 * 因此**不需要新增 guest preload，也不需要改 main 进程**。
 *
 * ## 验收场景
 *
 * 1. 打开对话框 → webview 加载宿主页 → SDK 就绪后自动开始挑战（`auto` 档，允许交互）；
 * 2. 用户完成挑战 → `success` 回调 → 对话框把 `{verifyParam, region}` 交给调用方并自行关闭；
 * 3. SDK 加载失败 / 初始化失败 / 挑战被拒 / 超时 → 展示可读原因 + 「重新验证」按钮；
 * 4. 关闭对话框 → webview 卸载，事件监听全部解绑，不残留 guest。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCwIcon } from "lucide-react";
import type { ManualClaimCaptchaConfig, ManualClaimCaptchaSolution } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  buildManualClaimCaptchaHostPageUrl,
  buildManualClaimCaptchaSolveScript,
  isManualClaimCaptchaWebviewSupported,
  parseManualClaimCaptchaMessage,
  toManualClaimCaptchaSolution,
  type ManualClaimCaptchaFailureStage,
} from "@/settings/manualClaimCaptchaPage.js";

/** 求解超时。交互挑战需要用户操作，给足时间但必须有界，避免对话框永久卡住。 */
const SOLVE_TIMEOUT_MS = 180_000;

/** SDK 脚本从 CDN 加载，首次可能要几秒；这个上限只用于「等 SDK 就绪」。 */
const SDK_READY_TIMEOUT_MS = 30_000;

const SDK_READY_POLL_INTERVAL_MS = 150;

export interface ManualClaimCaptchaDialogProps {
  open: boolean;
  config: ManualClaimCaptchaConfig;
  /** 当前 locale，用于 SDK 自己的界面文案（SDK 的语言白名单与 BCP-47 不同）。 */
  locale?: string;
  onOpenChange: (open: boolean) => void;
  onSolved: (solution: ManualClaimCaptchaSolution) => void;
  onFailed?: (stage: ManualClaimCaptchaFailureStage, reason: string) => void;
}

export function ManualClaimCaptchaDialog({
  open,
  config,
  locale,
  onOpenChange,
  onSolved,
  onFailed,
}: ManualClaimCaptchaDialogProps) {
  const { intl } = useZCodeIntl();
  const webviewRef = useRef<ElectronWebviewTag | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  // 求解在 dom-ready 之后启动；用 ref 承接，避免把回调塞进 ref callback 的依赖里。
  const startSolveRef = useRef<(webview: ElectronWebviewTag) => void>(() => {});
  const onSolvedRef = useRef(onSolved);
  const onFailedRef = useRef(onFailed);
  useEffect(() => {
    onSolvedRef.current = onSolved;
  }, [onSolved]);
  useEffect(() => {
    onFailedRef.current = onFailed;
  }, [onFailed]);
  const [stage, setStage] = useState<"idle" | "loading" | "solving" | "failed">("idle");
  const [failureReason, setFailureReason] = useState<string | null>(null);
  // 每次打开/重试都换一个 key 强制重建 webview：SDK 的实例状态与已消耗的挑战不可复用。
  const [attempt, setAttempt] = useState(0);

  const hostUrl = buildManualClaimCaptchaHostPageUrl({ lang: locale });

  const handleFailure = useCallback(
    (failureStage: ManualClaimCaptchaFailureStage, reason: string) => {
      setStage("failed");
      setFailureReason(reason);
      onFailedRef.current?.(failureStage, reason);
      logger.warn("[ManualClaimCaptchaDialog] 验证码求解失败", { stage: failureStage, reason });
    },
    [],
  );

  const startSolve = useCallback(
    (webview: ElectronWebviewTag) => {
      setStage("solving");
      // executeJavaScript 会 await 注入脚本返回的 Promise，因此这里直接拿求解结果。
      void webview
        .executeJavaScript(
          buildManualClaimCaptchaSolveScript({ config, timeoutMs: SOLVE_TIMEOUT_MS }),
          true,
        )
        .then((raw) => {
          const message = parseManualClaimCaptchaMessage(raw);
          if (!message) {
            handleFailure("verify", "unrecognized_result");
            return;
          }
          if (message.kind === "fail") {
            handleFailure(message.stage, message.reason);
            return;
          }
          const solution = toManualClaimCaptchaSolution(message, config);
          setStage("idle");
          onSolvedRef.current(solution);
        })
        .catch((error: unknown) => {
          // webview 在求解过程中被销毁（用户关闭对话框）会 reject，这是正常路径。
          handleFailure("verify", error instanceof Error ? error.message : String(error));
        });
    },
    [config, handleFailure],
  );

  useEffect(() => {
    startSolveRef.current = startSolve;
  }, [startSolve]);

  useEffect(() => {
    if (!open) {
      return;
    }
    setStage("loading");
    setFailureReason(null);
  }, [open, attempt]);

  const handleWebviewRef = useCallback(
    (element: ElectronWebviewTag | null) => {
      cleanupRef.current?.();
      cleanupRef.current = null;
      webviewRef.current = element;
      if (!element) {
        return;
      }
      // 手机 Web / 普通 Web 没有 Electron webviewTag：元素永远拿不到 executeJavaScript。
      // 在这里（节点已插入）判定，避免走一遍必然失败的 SDK 加载流程。
      if (!isManualClaimCaptchaWebviewSupported(element)) {
        handleFailure("unsupported", "webview_unavailable");
        return;
      }
      const handleDomReady = () => {
        // SDK 由宿主页的 <script src> 加载；dom-ready 时未必已完成，
        // 因此轮询 window.initAliyunCaptcha 而不是假设它已存在。
        const deadline = Date.now() + SDK_READY_TIMEOUT_MS;
        const poll = () => {
          if (webviewRef.current !== element) {
            return;
          }
          void element
            .executeJavaScript('typeof window.initAliyunCaptcha === "function"', true)
            .then((ready) => {
              if (webviewRef.current !== element) {
                return;
              }
              if (ready === true) {
                startSolveRef.current(element);
                return;
              }
              if (Date.now() >= deadline) {
                handleFailure("sdk_load", "sdk_ready_timeout");
                return;
              }
              setTimeout(poll, SDK_READY_POLL_INTERVAL_MS);
            })
            .catch(() => {
              // webview 已销毁时 executeJavaScript 会拒绝，静默即可。
            });
        };
        poll();
      };
      // did-fail-load 只对主 frame 报错：宿主页是 data: URL，子资源失败不影响求解。
      const handleDidFailLoad = (event: ElectronWebviewDidFailLoadEvent) => {
        if (!event.isMainFrame) {
          return;
        }
        handleFailure("sdk_load", event.errorDescription || String(event.errorCode));
      };
      const handleRenderProcessGone = (event: ElectronWebviewRenderProcessGoneEvent) => {
        handleFailure("sdk_load", event.details.reason);
      };
      element.addEventListener("dom-ready", handleDomReady);
      element.addEventListener("did-fail-load", handleDidFailLoad);
      element.addEventListener("render-process-gone", handleRenderProcessGone);
      cleanupRef.current = () => {
        element.removeEventListener("dom-ready", handleDomReady);
        element.removeEventListener("did-fail-load", handleDidFailLoad);
        element.removeEventListener("render-process-gone", handleRenderProcessGone);
      };
    },
    [handleFailure],
  );

  useEffect(() => {
    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, []);

  const handleRetry = useCallback(() => {
    setAttempt((value) => value + 1);
  }, []);

  if (!open) {
    return null;
  }

  const failed = stage === "failed";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="manual-claim-captcha-dialog">
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({ id: "settings.modelProvider.manualClaim.captcha.title" })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "settings.modelProvider.manualClaim.captcha.description" })}
          </DialogDescription>
        </DialogHeader>
        <div className="min-w-0">
          {failed ? (
            <div
              className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 text-ui-base text-foreground-subtle"
              data-testid="manual-claim-captcha-failure"
            >
              <span className="font-medium text-foreground">
                {intl.formatMessage({ id: "settings.modelProvider.manualClaim.captcha.failed" })}
              </span>
              {failureReason ? (
                <span className="break-all text-ui-sm text-foreground-subtle">{failureReason}</span>
              ) : null}
              <div>
                <Button type="button" size="sm" variant="outline" onClick={handleRetry}>
                  <RefreshCwIcon className="size-3.5" />
                  {intl.formatMessage({ id: "settings.modelProvider.manualClaim.captcha.retry" })}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <span className="text-ui-sm text-foreground-subtle">
                {intl.formatMessage({
                  id:
                    stage === "solving"
                      ? "settings.modelProvider.manualClaim.captcha.solving"
                      : "settings.modelProvider.manualClaim.captcha.loading",
                })}
              </span>
              <webview
                key={attempt}
                ref={handleWebviewRef}
                // data: 宿主页 origin 是 opaque 的，不需要持久分区；
                // 但显式给一个内存分区，避免与其它 webview 共享会话。
                partition="zcode-manual-claim-captcha"
                src={hostUrl}
                className="h-[420px] w-full rounded-lg border border-border bg-background"
                data-testid="manual-claim-captcha-webview"
              />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
