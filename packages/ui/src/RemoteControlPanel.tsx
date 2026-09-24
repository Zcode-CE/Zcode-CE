import { useCallback, useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { AlertTriangleIcon, CheckIcon, CopyIcon, RefreshCwIcon, SquareIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { cn } from "@/components/lib/utils.js";
import { writeTextToClipboard } from "@/lib/clipboardText.js";
import { logger } from "@/logger.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  REMOTE_CONTROL_FIRST_RUN_CONFIRM_TEST_ID,
  REMOTE_CONTROL_PANEL_BADGE_TEST_ID,
  REMOTE_CONTROL_PANEL_CONNECTION_TEST_ID,
  REMOTE_CONTROL_PANEL_COPY_TEST_ID,
  REMOTE_CONTROL_PANEL_FAILURE_TEST_ID,
  REMOTE_CONTROL_PANEL_LINK_TEST_ID,
  REMOTE_CONTROL_PANEL_QR_TEST_ID,
  REMOTE_CONTROL_PANEL_SAFETY_TEST_ID,
  REMOTE_CONTROL_PANEL_SERVICE_PLANE_TEST_ID,
  REMOTE_CONTROL_PANEL_START_TEST_ID,
  REMOTE_CONTROL_PANEL_STOP_TEST_ID,
  REMOTE_CONTROL_PANEL_TEST_ID,
  DEFAULT_REMOTE_CONTROL_START_SCOPE,
  hasUsableRemoteControlLink,
  resolveRemoteControlPanelView,
  shouldConfirmBeforeStart,
  shouldRenderQrCode,
  withRemoteControlInFlight,
  type RemoteControlConnectionInfo,
  type RemoteControlPanelBranch,
  type RemoteControlPanelStatus,
  type RemoteControlStartScope,
} from "@/remoteControlPanelModel.js";

/**
 * 远程控制面板（ce.3 · 切片 3）。
 *
 * **措辞红线（用户已纠正，不得回退）**：面板说的是「在这台机器上开一个可被浏览器访问的
 * 工作台」，手机/另一台设备用浏览器操作**这台机器上的工作台**。**不得**写成
 * 「控制桌面端 / 接管桌面会话」—— 桌面端已连的远端 SSH/Docker 目标**不会**共享给浏览器
 * （那是窗口内连接注册表），承诺它是承诺一个不存在的能力。
 *
 * 三个结构性约束：
 * - **纯 props 驱动**：本组件不读任何服务、不订阅 IPC、不拼令牌。带令牌的链接只从
 *   `connection` 进来（切片 4 接 `webService:connectionInfo`），因此能在真浏览器里
 *   用注入态渲染并做 DOM 断言（切片 1 已用同一办法）。
 * - **能力缺失 ⇒ 不渲染**：由调用方用 `canRenderRemoteControlPanel` 门控整块；
 *   本组件**没有** "disabled" 分支 —— 禁用按钮会承诺一个不存在的动作。
 * - **二维码只在有链接时出现**：没拿到 `linkWithToken` 就不渲染二维码区域。
 */
export interface RemoteControlPanelProps {
  status: RemoteControlPanelStatus;
  /** 带令牌的链接；`null` = 当前没有可派发的链接（此时不渲染二维码）。 */
  connection?: RemoteControlConnectionInfo | null;
  /** 契约 §5 `webService:start`。首次确认弹窗由本组件负责（决策①）。 */
  onStart: (options: { scope: RemoteControlStartScope }) => void | Promise<void>;
  /** 契约 §5 `webService:stop`。 */
  onStop: () => void | Promise<void>;
  /** 用户已确认过「对局域网开放」的后果（决策①：只确认一次）。 */
  lanExposureConfirmed?: boolean;
  onLanExposureConfirmed?: () => void;
  /** 关闭面板；不传则不渲染关闭入口。 */
  onClose?: () => void;
  className?: string;
}

export function RemoteControlPanel({
  status,
  connection,
  onStart,
  onStop,
  lanExposureConfirmed = false,
  onLanExposureConfirmed,
  onClose,
  className,
}: RemoteControlPanelProps) {
  const { intl } = useZCodeIntl();
  const t = useCallback((id: string) => intl.formatMessage({ id }), [intl]);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [confirmOpen, setConfirmOpen] = useState(false);
  // 在途标记是**渲染进程本地**状态：start 最长可等 15s（WEB_SERVICE_READY_TIMEOUT_MS），
  // 期间必须让用户看出"正在开启"，而不是停在一个禁用的"开启"按钮上。
  const [inFlight, setInFlight] = useState<"starting" | "stopping" | null>(null);
  const view = useMemo(
    () => withRemoteControlInFlight(resolveRemoteControlPanelView(status), inFlight),
    [inFlight, status],
  );

  // 链接变化后重置复制反馈：否则用户会看到上一个链接的「已复制」留在新链接上。
  const link = connection?.linkWithToken ?? "";
  // 「有没有可用链接」只判定一次（model 的唯一所有者），链接行与二维码共用同一个结论。
  const hasLink = hasUsableRemoteControlLink(connection);
  useEffect(() => {
    setCopyState("idle");
  }, [link]);

  const startService = useCallback(async () => {
    setInFlight("starting");
    try {
      await onStart({ scope: DEFAULT_REMOTE_CONTROL_START_SCOPE });
    } finally {
      setInFlight(null);
    }
  }, [onStart]);

  const runPrimaryAction = useCallback(async () => {
    if (view.primaryAction === "stop") {
      setInFlight("stopping");
      try {
        await onStop();
      } finally {
        setInFlight(null);
      }
      return;
    }
    // start / retry 共用同一条路：先过决策①的确认门（只在**首次**对局域网开放时弹）。
    if (shouldConfirmBeforeStart(DEFAULT_REMOTE_CONTROL_START_SCOPE, lanExposureConfirmed)) {
      setConfirmOpen(true);
      return;
    }
    await startService();
  }, [lanExposureConfirmed, onStop, startService, view.primaryAction]);

  const confirmStart = useCallback(async () => {
    setConfirmOpen(false);
    onLanExposureConfirmed?.();
    await startService();
  }, [onLanExposureConfirmed, startService]);

  const copyLink = useCallback(() => {
    if (!hasLink) return;
    // 非安全上下文（局域网 http://<ip>:<port>）没有 navigator.clipboard，
    // 必须走既有 lib/clipboardText.ts（它在用户手势的同步调用栈内回退到 execCommand）。
    writeTextToClipboard(link).then(
      () => setCopyState("copied"),
      (error: unknown) => {
        logger.warn("[RemoteControlPanel] 复制链接失败", error);
        setCopyState("failed");
      },
    );
  }, [hasLink, link]);

  const showQr = shouldRenderQrCode(view, connection);

  return (
    <div
      data-testid={REMOTE_CONTROL_PANEL_TEST_ID}
      data-remote-control-branch={view.branch}
      data-remote-control-loopback={status.loopback ? "true" : "false"}
      className={cn("flex min-h-0 flex-col gap-4", className)}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-ui-lg font-semibold text-foreground">{t("remotePanel.title")}</h2>
          <p className="text-ui-base text-foreground-subtle">{t("remotePanel.subtitle")}</p>
        </div>
        {onClose ? (
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {t("common.close")}
          </Button>
        ) : null}
      </header>

      {/* 服务面：启停 + 状态徽标。 */}
      <section
        data-testid={REMOTE_CONTROL_PANEL_SERVICE_PLANE_TEST_ID}
        className="flex flex-wrap items-center gap-2"
      >
        <Badge
          data-testid={REMOTE_CONTROL_PANEL_BADGE_TEST_ID}
          data-remote-control-badge={view.branch}
          variant={badgeVariant(view.branch)}
        >
          {t(view.badgeMessageId)}
        </Badge>
        <p className="min-w-0 flex-1 text-ui-base text-foreground-subtle">
          {t(view.adviceMessageId)}
        </p>
        <PrimaryActionButton
          view={view}
          label={t(view.primaryActionMessageId)}
          onClick={() => void runPrimaryAction()}
        />
      </section>

      {/* 失败/异常分支：把原因单独成块，避免它和正常态挤在同一行被忽略。 */}
      {view.branch === "failed" || view.branch === "untrusted" ? (
        <div
          data-testid={REMOTE_CONTROL_PANEL_FAILURE_TEST_ID}
          data-remote-control-failure={view.branch}
          className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive"
        >
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0">{t(view.adviceMessageId)}</span>
        </div>
      ) : null}

      {/* 连接面：地址 / 链接 / 二维码 / 复制链接。只在 running 档渲染。 */}
      {view.showConnection ? (
        <section
          data-testid={REMOTE_CONTROL_PANEL_CONNECTION_TEST_ID}
          className="flex flex-col gap-3"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-ui-base font-medium text-foreground">
              {t("remotePanel.connection.title")}
            </span>
            <span className="text-ui-caption text-foreground-subtle">
              {t("remotePanel.connection.audience")}
            </span>
          </div>

          {hasLink ? (
            <div className="flex flex-wrap items-center gap-2">
              <code
                data-testid={REMOTE_CONTROL_PANEL_LINK_TEST_ID}
                className="min-w-0 flex-1 truncate rounded-md border border-border bg-surface px-2 py-1 text-ui-base text-foreground"
              >
                {link}
              </code>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                data-testid={REMOTE_CONTROL_PANEL_COPY_TEST_ID}
                data-remote-control-copy-state={copyState}
                // 粗指针（手机/平板）命中区 ≥44：size="sm" 只有 24 高，触屏上很难点中。
                // 与切片 1 入口同一机制（只按 pointer:coarse，桌面保持紧凑）。
                className="[@media(pointer:coarse)]:min-h-11"
                onClick={copyLink}
              >
                {copyState === "copied" ? (
                  <CheckIcon className="size-3.5" />
                ) : (
                  <CopyIcon className="size-3.5" />
                )}
                {copyState === "copied"
                  ? t("remotePanel.action.copied")
                  : copyState === "failed"
                    ? t("remotePanel.action.copyFailed")
                    : t("remotePanel.action.copyLink")}
              </Button>
            </div>
          ) : (
            <p className="text-ui-base text-foreground-subtle">
              {t("remotePanel.connection.linkPending")}
            </p>
          )}

          {/*
            二维码的渲染判定**只有这一个所有者**（model 的 shouldRenderQrCode）。
            这里刻意**不**把它塞进上面 `link ?` 的分支里：那样会出现两个判定点，
            改坏其中一个时另一个仍然兜住，反向验证就会"怎么改都不变红"——
            等于这条断言没打在它声称的面上（实测踩过：只改 shouldRenderQrCode 时 0 条变红）。
          */}
          {showQr ? <RemoteControlQrCode value={link} alt={t("remotePanel.qr.alt")} /> : null}
          <p className="text-ui-caption text-foreground-subtle">{t("remotePanel.qr.fallback")}</p>
        </section>
      ) : null}

      {/* 常驻安全提示：不可关闭（spec §3.6 / §3.5 危险品口径）。 */}
      <section
        data-testid={REMOTE_CONTROL_PANEL_SAFETY_TEST_ID}
        className="flex flex-col gap-1 rounded-lg border border-border bg-surface px-3 py-2"
      >
        <span className="text-ui-base font-medium text-foreground">
          {t("remotePanel.safety.title")}
        </span>
        {/* 非回环运行时把「同网段可尝试连接」提到最前并加重 —— 这是本面板最要紧的后果。 */}
        {view.emphasizeLanExposure ? (
          <p data-remote-control-lan-warning="true" className="text-ui-base text-foreground-subtle">
            {t("remotePanel.safety.lanExposure")}
          </p>
        ) : null}
        <p className="text-ui-base text-foreground-subtle">
          {t("remotePanel.safety.tokenIsTheOnlyBarrier")}
        </p>
        <p className="text-ui-base text-foreground-subtle">
          {t("remotePanel.safety.linkIsCredential")}
        </p>
      </section>

      <FirstRunConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onConfirm={() => void confirmStart()}
      />
    </div>
  );
}

function badgeVariant(branch: RemoteControlPanelBranch) {
  switch (branch) {
    case "running":
      return "secondary" as const;
    case "failed":
    case "untrusted":
      return "destructive" as const;
    default:
      return "outline" as const;
  }
}

function PrimaryActionButton({
  view,
  label,
  onClick,
}: {
  view: ReturnType<typeof resolveRemoteControlPanelView>;
  label: string;
  onClick: () => void;
}) {
  if (view.primaryAction === "none") return null;
  const isStop = view.primaryAction === "stop";
  return (
    <Button
      type="button"
      variant={isStop ? "outline" : "default"}
      size="lg"
      data-testid={isStop ? REMOTE_CONTROL_PANEL_STOP_TEST_ID : REMOTE_CONTROL_PANEL_START_TEST_ID}
      data-remote-control-primary-action={view.primaryAction}
      // 在途期间禁用：避免连点触发第二次 start/stop（阶段一不做取消）。
      disabled={view.inFlight !== null}
      // 粗指针（手机/平板）命中区 ≥44：与切片 1 入口同一机制。
      className="[@media(pointer:coarse)]:min-h-11"
      onClick={onClick}
    >
      {isStop ? <SquareIcon className="size-3.5" /> : <RefreshCwIcon className="size-3.5" />}
      {label}
    </Button>
  );
}

/**
 * 二维码：复用既有 `qrcode` 依赖（`packages/ui` 的 dependencies 里已有，**不新增依赖**）。
 *
 * 用 SVG 渲染而不是 canvas：`qrcode/lib/browser.js` 的 `toString({type:"svg"})` 不碰
 * `document.createElement("canvas")`，因此**可断言**（SVG 直接进 DOM，浏览器脚本能读到
 * `<path d>`），而 canvas 只能靠像素比对。
 */
function RemoteControlQrCode({ value, alt }: { value: string; alt: string }) {
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    QRCode.toString(value, { type: "svg", margin: 1, width: 160, errorCorrectionLevel: "M" }).then(
      (markup: string) => {
        if (!disposed) setSvg(markup);
      },
      (error: unknown) => {
        // 生成失败就当作没有二维码（不渲染半张图）；链接本身仍可复制。
        logger.warn("[RemoteControlPanel] 二维码生成失败", error);
        if (!disposed) setSvg(null);
      },
    );
    return () => {
      disposed = true;
    };
  }, [value]);

  if (!svg) return null;
  return (
    <div
      data-testid={REMOTE_CONTROL_PANEL_QR_TEST_ID}
      // 二维码**本身就是凭据**：不给它加 title/可复制文本，避免被顺手截图外发时的额外提示。
      role="img"
      aria-label={alt}
      className="size-40 shrink-0 rounded-md bg-white p-1 [&>svg]:size-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/**
 * 首次启动确认弹窗（决策①）。
 *
 * 复用既有 `Dialog` 原语（与 `ConfirmDialog` 同一套），但**不走 `confirmDialogStore`**：
 * 那个 store 是全局单例、同时只允许一个待决请求，而面板自己需要持有"确认后要做什么"的
 * 局部状态。两者混用会让面板的确认在别处弹窗打开时被静默 dismiss。
 */
function FirstRunConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid={REMOTE_CONTROL_FIRST_RUN_CONFIRM_TEST_ID}
        showCloseButton={false}
        className="sm:max-w-md"
      >
        <DialogHeader className="gap-2">
          <DialogTitle className="text-ui-lg font-semibold text-foreground">
            {t("remotePanel.confirm.startLan.title")}
          </DialogTitle>
          <DialogDescription className="whitespace-pre-line pt-0.5 text-ui-base leading-6 text-foreground-subtle">
            {t("remotePanel.confirm.startLan.body")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:justify-end">
          <Button type="button" variant="secondary" size="lg" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="button" size="lg" onClick={onConfirm}>
            {t("remotePanel.confirm.startLan.continue")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
