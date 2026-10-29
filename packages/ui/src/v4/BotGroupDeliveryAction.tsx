import { useContext, useMemo, type ReactNode } from "react";
import { CircleAlertIcon } from "lucide-react";
import type { BotGroupDelivery } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useBotGroupMemberNames } from "@/hooks/useBotGroupMemberNames.js";
import { useBotGroupTask } from "@/hooks/useBotGroupTask.js";
import { BotGroupMemberNamesContext } from "@/v4/BotGroupMemberNamesContext.js";
import { DeliveryContext } from "@/v4/botGroupDeliveryContext.js";

/**
 * 群同步状态的任务级 Provider（装在 SessionPane 的会话面外层）。
 *
 * 同一任务只订阅一次群状态：历史回复各自请求全量 Bot 状态的话，一个几十轮的会话
 * 会打出几十次 getBotStates；这里订阅一次，轮次动作与准备态从 context 读。
 */
export function BotGroupDeliveryProvider({
  taskId,
  workspacePath,
  workspaceIdentity,
  children,
}: {
  taskId: string | null;
  workspacePath: string;
  workspaceIdentity?: string;
  children: ReactNode;
}) {
  const { context, provider, busyId, retry, reconcile, retryPreparation } = useBotGroupTask(
    taskId,
    workspacePath,
    workspaceIdentity,
  );
  const memberNames = useBotGroupMemberNames(context);
  const value = useMemo(
    () => ({
      context,
      provider,
      busyId,
      retry,
      reconcile,
      retryPreparation,
      taskId,
    }),
    [context, provider, busyId, retry, reconcile, retryPreparation, taskId],
  );
  return (
    <DeliveryContext.Provider value={value}>
      <BotGroupMemberNamesContext.Provider value={memberNames}>
        {children}
      </BotGroupMemberNamesContext.Provider>
    </DeliveryContext.Provider>
  );
}

/**
 * 该轮有未送达/待确认的群投递时的轮次动作。
 *
 * 只挂已关联轮次的操作栏：任务级恢复面板会与队列浮层重叠，还重复展示正文；
 * 未关联轮次的结果留给群同步面板（BoundGroupsCard / 私聊重试）呈现。
 */
export function BotGroupDeliveryAction({
  turnId,
  sourceCommandIds,
  syncing,
  results,
  busyId,
  onRetry,
  onReconcile,
}: {
  turnId: string;
  sourceCommandIds: readonly string[];
  /** 群同步是否仍指向本任务（暂停/切走后不再给重试入口，避免重发到已解绑的群）。 */
  syncing: boolean;
  results: BotGroupDelivery[];
  busyId?: string | null;
  onRetry: (id: string) => void;
  onReconcile: (id: string, received: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const unresolved = results.filter(
    (result) =>
      result.sourceCommandId &&
      sourceCommandIds.includes(result.sourceCommandId) &&
      (result.status === "failed" || result.status === "unknown"),
  );
  if (!unresolved.length) return null;
  const label = intl.formatMessage({
    id: unresolved.some((result) => result.status === "unknown")
      ? "bots.group.deliveryUnknown"
      : "bots.group.deliveryFailed",
  });
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          className="text-warning"
          aria-label={label}
          title={label}
          data-bot-group-delivery={turnId}
        >
          <CircleAlertIcon className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="max-w-[calc(100vw-2rem)] gap-2"
        data-bot-group-delivery-actions={turnId}
      >
        {unresolved.map((result, index) => (
          <div key={result.id} className="flex flex-col gap-1">
            <span className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({
                id:
                  result.status === "unknown"
                    ? "bots.group.deliveryUnknown"
                    : "bots.group.deliveryFailed",
              })}
              {unresolved.length > 1 ? ` (${index + 1}/${unresolved.length})` : null}
            </span>
            {syncing ? (
              <div className="flex flex-wrap gap-1">
                {result.status === "unknown" ? (
                  <>
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={busyId === result.id}
                      onClick={() => onReconcile(result.id, true)}
                    >
                      {intl.formatMessage({ id: "bots.group.confirmReceived" })}
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={busyId === result.id}
                      onClick={() => onReconcile(result.id, false)}
                    >
                      {intl.formatMessage({ id: "bots.group.confirmNotReceived" })}
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={busyId === result.id}
                    onClick={() => onRetry(result.id)}
                  >
                    {intl.formatMessage({ id: "bots.group.resend" })}
                  </Button>
                )}
              </div>
            ) : null}
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}

/** 动作栏用的连接态版本：没有群上下文（普通会话）时整块不渲染。 */
export function ConnectedBotGroupDeliveryAction({
  turnId,
  sourceCommandIds,
}: {
  turnId: string;
  sourceCommandIds: readonly string[];
}) {
  const value = useContext(DeliveryContext);
  const context = value?.context;
  if (!value || !context?.group) return null;
  return (
    <BotGroupDeliveryAction
      turnId={turnId}
      sourceCommandIds={sourceCommandIds}
      syncing={context.group.enabled && context.activeTaskId === value.taskId}
      results={Object.values(context.group.deliveries ?? {}).filter(
        (result) => result.taskId === value.taskId,
      )}
      busyId={value.busyId}
      onRetry={(id) => {
        void value.retry(id);
      }}
      onReconcile={(id, received) => {
        void value.reconcile(id, received);
      }}
    />
  );
}
