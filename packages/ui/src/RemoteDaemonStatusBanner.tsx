import { AlertTriangle, CheckCircle2, LoaderCircle, XCircle } from "lucide-react";
import type { ReactElement } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import {
  describeRemoteDaemonBanner,
  type RemoteDaemonBannerModel,
} from "@/remoteDaemonStatusBannerModel.js";
import { useRemoteDaemonStatusStore } from "@/store/remoteDaemonStatusStore.js";

/**
 * 远程工作区连接横幅（最小 UI）。
 *
 * 四态：重连中 / 已恢复 / daemon 已重启（需重开会话）/ 已断开（可查看日志）。
 * 正常连接不渲染（横幅只在需要用户知情或操作时出现），不新增设置项、不做设备管理。
 *
 * 为什么用 store 而不是 props：状态由 host 的连接事件驱动（经连接日志通道送达），
 * 与组件树无父子关系；props 传递会把远程连接状态耦合进 workspace 布局。
 */
export function RemoteDaemonStatusBanner({
  onReopenSession,
  onRetry,
  onOpenLog,
  className,
}: {
  onReopenSession?: () => void;
  onRetry?: () => void;
  onOpenLog?: (coreLogPath: string) => void;
  className?: string;
}): ReactElement | null {
  const { intl } = useZCodeIntl();
  const state = useRemoteDaemonStatusStore((store) => store.state);
  const dismissed = useRemoteDaemonStatusStore((store) => store.dismissed);
  const dismiss = useRemoteDaemonStatusStore((store) => store.dismiss);
  if (!state || dismissed) return null;
  const model = describeRemoteDaemonBanner(state);
  if (!model) return null;

  const Icon = toneIcon(model.tone);
  return (
    <div
      role="status"
      className={cn(
        "flex w-full items-start gap-2 rounded-md border px-3 py-2 text-ui-base",
        toneClassName(model.tone),
        className,
      )}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{intl.formatMessage({ id: model.titleKey })}</div>
        {model.descriptionKey ? (
          <div className="text-muted-foreground">
            {intl.formatMessage({ id: model.descriptionKey }, model.descriptionParams ?? {})}
          </div>
        ) : null}
      </div>
      {model.action === "retry" && onRetry ? (
        <button type="button" className="shrink-0 underline" onClick={onRetry}>
          {intl.formatMessage({ id: "common.retry" })}
        </button>
      ) : null}
      {model.action === "open-log" && model.coreLogPath && onOpenLog ? (
        <button
          type="button"
          className="shrink-0 underline"
          onClick={() => onOpenLog(model.coreLogPath!)}
        >
          {intl.formatMessage({ id: "remote.daemon.action.openLog" })}
        </button>
      ) : null}
      {model.action === "reopen-session" && onReopenSession ? (
        <button type="button" className="shrink-0 underline" onClick={onReopenSession}>
          {intl.formatMessage({ id: "remote.daemon.action.reopenSession" })}
        </button>
      ) : null}
      <button
        type="button"
        className="shrink-0 text-muted-foreground"
        aria-label={intl.formatMessage({ id: "common.close" })}
        onClick={dismiss}
      >
        ×
      </button>
    </div>
  );
}

function toneIcon(tone: RemoteDaemonBannerModel["tone"]) {
  if (tone === "progress") return LoaderCircle;
  if (tone === "success") return CheckCircle2;
  if (tone === "warning") return AlertTriangle;
  return XCircle;
}

function toneClassName(tone: RemoteDaemonBannerModel["tone"]): string {
  if (tone === "progress") return "border-border bg-muted text-foreground";
  if (tone === "success") return "border-border bg-muted text-foreground";
  if (tone === "warning") return "border-amber-500/40 bg-amber-500/10 text-foreground";
  return "border-destructive/40 bg-destructive/10 text-foreground";
}
