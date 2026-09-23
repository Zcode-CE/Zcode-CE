import { AlertTriangle, Info, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { WorkspaceRuntimeState } from "@/hooks/useWorkspaceRuntimeStates.js";

/**
 * §3.2「诚实未启动态」的唯一渲染落点。
 *
 * 为什么必须单独收口：M1 把可见工作区从「本客户端设置」扩到「服务端注册表」后，被列出的
 * 未启动工作区会明显变多。如果这些行点开是死路、或者把「未启动」画成「暂无任务」，用户会
 * 以为会话丢了 —— 那比 M1 之前更糟。三种状态必须各自有明确的画面与动作：
 *
 *  - not-started：如实说「已有哪些会话、最近什么时候用过」，并给出「打开并启动」动作；
 *  - starting   ：加载态（不得落到「暂无任务」）；
 *  - failed     ：原因 + 重试入口（不得只留空白）。
 */
export function WorkspaceRuntimeNotice({
  state,
  workspaceName,
  persistedSessionCount,
  lastActivityAt,
  failureReason,
  onStart,
  onRetry,
}: {
  state: WorkspaceRuntimeState;
  workspaceName: string;
  persistedSessionCount?: number | null;
  lastActivityAt?: number | null;
  failureReason?: string | null;
  onStart?: () => void;
  onRetry?: () => void;
}) {
  const { intl } = useZCodeIntl();

  if (state === "starting") {
    return (
      <div
        data-testid="workspace-runtime-starting"
        className="flex items-center gap-2 px-8.5 py-2 text-ui-base text-foreground-subtlest"
      >
        <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
        <span>{intl.formatMessage({ id: "workspaceRuntime.starting.title" })}</span>
      </div>
    );
  }

  if (state === "failed") {
    return (
      <div
        data-testid="workspace-runtime-failed"
        className="mx-2 mb-1 rounded-lg border border-destructive/30 bg-destructive/5 p-2"
      >
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-ui-base text-foreground">
              {intl.formatMessage(
                { id: "workspaceRuntime.failed.title" },
                { workspace: workspaceName },
              )}
            </p>
            <p className="mt-1 break-all text-ui-sm/relaxed text-foreground-subtle">
              {failureReason?.trim() ||
                intl.formatMessage({ id: "workspaceRuntime.failed.reasonUnavailable" })}
            </p>
          </div>
        </div>
        {onRetry ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2 w-full justify-center"
            onClick={onRetry}
            data-testid="workspace-runtime-retry"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {intl.formatMessage({ id: "workspaceRuntime.failed.retry" })}
          </Button>
        ) : null}
      </div>
    );
  }

  if (state === "not-started") {
    const hasSessions = typeof persistedSessionCount === "number" && persistedSessionCount > 0;
    return (
      <div data-testid="workspace-runtime-not-started" className="px-8.5 py-2">
        <div className="flex items-center gap-1.5 text-ui-base text-foreground-subtle">
          <Info className="size-3.5 shrink-0" aria-hidden="true" />
          <span>{intl.formatMessage({ id: "workspaceRuntime.notStarted.title" })}</span>
        </div>
        <p className="mt-1 text-ui-sm/relaxed text-foreground-subtlest">
          {hasSessions
            ? intl.formatMessage(
                { id: "workspaceRuntime.notStarted.persistedSessions" },
                {
                  count: String(persistedSessionCount),
                  activity: formatLastActivity(lastActivityAt, Date.now()),
                },
              )
            : intl.formatMessage({ id: "workspaceRuntime.notStarted.noSessions" })}
        </p>
        {onStart ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-2 w-full justify-center text-foreground-subtle hover:text-foreground"
            onClick={onStart}
            data-testid="workspace-runtime-open"
          >
            {intl.formatMessage({ id: "workspaceRuntime.notStarted.open" })}
          </Button>
        ) : null}
      </div>
    );
  }

  return null;
}

/** 相对时间只用于「最近用过」的粗粒度提示，精确值由 title 承载。 */
function formatLastActivity(lastActivityAt: number | null | undefined, now: number): string {
  if (typeof lastActivityAt !== "number" || lastActivityAt <= 0) {
    return "";
  }
  const minutes = Math.max(0, Math.round((now - lastActivityAt) / 60_000));
  if (minutes < 60) return String(minutes) + "m";
  const hours = Math.round(minutes / 60);
  if (hours < 48) return String(hours) + "h";
  return String(Math.round(hours / 24)) + "d";
}

/** 列表行上的「未启动」徽标（与远端「未连接」区分：两者原因不同、动作也不同）。 */
export function WorkspaceRuntimeBadge({ state }: { state: WorkspaceRuntimeState }) {
  const { intl } = useZCodeIntl();
  if (state !== "not-started" && state !== "starting" && state !== "failed") {
    return null;
  }
  const key =
    state === "starting"
      ? "workspaceRuntime.badge.starting"
      : state === "failed"
        ? "workspaceRuntime.badge.failed"
        : "workspaceRuntime.badge.notStarted";
  return (
    <span
      data-workspace-runtime-badge={state}
      className={
        state === "failed"
          ? "shrink-0 rounded border border-destructive/40 px-1 text-ui-xs leading-4 text-destructive"
          : "shrink-0 rounded border border-border px-1 text-ui-xs leading-4 text-foreground-subtle"
      }
    >
      {intl.formatMessage({ id: key })}
    </span>
  );
}
