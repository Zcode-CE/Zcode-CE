import { useContext, useMemo } from "react";
import { LoaderCircleIcon } from "lucide-react";
import type { BotTopicPreparation as Preparation, FeishuBotProvider } from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { DeliveryContext } from "@/v4/botGroupDeliveryContext.js";
import { ConversationUserInputBubble } from "@/v4/ConversationUserInputBubble.js";
import { pendingTopicPreparations } from "@/v4/topicPreparationRenderUnits.js";

const EMPTY_ROWS: readonly ConversationRow[] = [];
const EMPTY_PREPARATIONS: readonly Preparation[] = [];

/** 只有本任务、且是话题（threadId）的首个准备阶段才有准备态材料。 */
export function useBotTopicPreparations(): readonly Preparation[] {
  const value = useContext(DeliveryContext);
  if (!value?.context?.group?.threadId || value.context.activeTaskId !== value.taskId)
    return EMPTY_PREPARATIONS;
  return value.context.group.preparation ?? EMPTY_PREPARATIONS;
}

/**
 * 未接受的话题材料：画在最后一条 CLI 消息之后，等 CLI 落成真实 userInput row 后消失。
 *
 * 为什么不伪造 row：伪造 accepted row 会让复制/导航/分享索引把还没提交的内容算进去。
 * 这里只用 `aria-live` 的展示投影，状态由来源行（渠道 + 姓名）承担。
 */
export function BotTopicPreparationList({
  items,
  acceptedRows = EMPTY_ROWS,
  provider,
}: {
  items: readonly Preparation[];
  acceptedRows?: readonly ConversationRow[];
  provider?: FeishuBotProvider;
}) {
  const { intl } = useZCodeIntl();
  const pending = useMemo(
    () => pendingTopicPreparations(items, acceptedRows),
    [items, acceptedRows],
  );
  if (!pending.length) return null;
  return (
    <div className="flex flex-col gap-4" aria-live="polite">
      {pending.map((item) => (
        <div
          key={item.messageId}
          data-topic-preparation={item.messageId}
          className="flex min-w-0 flex-col items-end"
        >
          <div
            data-topic-preparation-source="true"
            className="mb-2 flex min-w-0 max-w-full items-center gap-1.5 text-ui-sm text-foreground-subtle"
          >
            <span className="min-w-0 truncate" title={item.senderName}>
              {provider
                ? `${provider === "lark" ? "Lark" : intl.formatMessage({ id: "bots.group.provider.feishu" })} · `
                : ""}
              {item.senderName}
            </span>
            {item.status !== "failed" ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    tabIndex={0}
                    role="img"
                    aria-label={intl.formatMessage({ id: `chat.topicPreparation.${item.status}` })}
                    data-topic-preparation-loading="true"
                    className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm focus-visible:outline focus-visible:outline-ring"
                  >
                    <LoaderCircleIcon
                      aria-hidden="true"
                      className="size-3 animate-spin motion-reduce:animate-none"
                    />
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {intl.formatMessage({ id: `chat.topicPreparation.${item.status}` })}
                </TooltipContent>
              </Tooltip>
            ) : null}
          </div>
          <ConversationUserInputBubble text={item.text} rowId={item.messageId} />
        </div>
      ))}
    </div>
  );
}

/** 连接态版本：没有群话题上下文时不渲染（普通会话、非话题群都不画准备态）。 */
export function BotTopicPreparation({ items }: { items: readonly Preparation[] }) {
  const value = useContext(DeliveryContext);
  if (!value?.context?.group?.threadId || value.context.activeTaskId !== value.taskId) return null;
  return <BotTopicPreparationList items={items} provider={value.provider} />;
}
