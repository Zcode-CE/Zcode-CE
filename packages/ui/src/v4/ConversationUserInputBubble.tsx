import { ConversationUserInputBody } from "@/v4/ConversationUserInputBody.js";
import { ConversationUserInputContent } from "@/v4/ConversationUserInputContent.js";
import { ConversationUserInputEpilogue } from "@/v4/ConversationUserInputEpilogue.js";

/**
 * 正式用户消息与群话题准备态共用同一套气泡渲染（上游 3.16.2 的同一拆分）。
 *
 * CE 形态差异：上游这里还分叉 ChannelMentionContent（@提及渲染）；CE 的 X6 只落到
 * shared 的解析层，UI 侧没有提及渲染器，正式用户行同样只渲染纯文本 ⇒ 这里不接
 * contentParts，两条路径保持同一呈现，不引入半集成的分支。
 */
export function ConversationUserInputBubble({
  text,
  rowId,
  attachments,
  contextAttachmentCount,
  epilogue,
}: {
  text: string;
  /** 只用于展开态复位：正式行是 rowId，准备态是群消息 messageId。 */
  rowId: string | number;
  attachments?: readonly unknown[];
  contextAttachmentCount?: number;
  epilogue?: string;
}) {
  if (!text.trim() && epilogue === undefined) return null;
  return (
    <div
      data-v4-user-input-bubble="true"
      className="flex max-w-full flex-col gap-2 rounded-xl rounded-tr-xs border border-border bg-surface px-4 py-3 text-ui-base text-foreground @min-[624px]/conversation:max-w-xl"
    >
      {text.trim() ? (
        <ConversationUserInputBody contentText={text} rowId={rowId}>
          <ConversationUserInputContent
            text={text}
            attachments={attachments}
            contextAttachmentCount={contextAttachmentCount}
          />
        </ConversationUserInputBody>
      ) : null}
      {epilogue === undefined ? null : <ConversationUserInputEpilogue text={epilogue} />}
    </div>
  );
}
