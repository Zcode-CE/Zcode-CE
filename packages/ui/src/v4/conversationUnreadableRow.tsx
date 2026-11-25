// 会话行逐行降级的 UI 侧（协议见 packages/shared/src/zcode-protocol-v4/rows.ts 的
// UnreadableConversationRow）。这一行的信息量只有「读不懂这一行」这一件事：不渲染任何原始载荷，
// 也不把 sourceKind 之类原始事实写进 DOM，只保留归一化后的 reason 供诊断与测试。
//
// 视觉沿用分享只读时间线的「部分内容需要更新 ZCode 查看」：中性信息语义而不是警告色 ——
// 会话本身没有出错，只是这个 build 认不出其中一行。
import { InfoIcon } from "lucide-react";
import { memo } from "react";
import { DEFAULT_LOCALE, type Locale } from "@zcode/shared";
import type {
  UnreadableConversationRow,
  UnreadableRowReason,
} from "@zcode/shared/zcode-protocol-v4";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** 占位行标题：说明这一行读不出来，并给出两种可能（更新的版本 / 数据已损坏）。 */
const UNREADABLE_ROW_TITLE_MESSAGE_ID = "conversation.row.unreadable";

/** reason 到可操作提示键的封闭映射。禁用模板拼接：未知 reason 会拼出一个裸键。 */
const UNREADABLE_ROW_HINT_MESSAGE_IDS: Readonly<Record<UnreadableRowReason, string>> = {
  unknownKind: "conversation.row.unreadable.unknownKind",
  invalidRow: "conversation.row.unreadable.invalidRow",
};

/**
 * 字典整条缺失时的最后回退。IntlProvider 的 formatMessage 在缺键时原样返回 id，
 * 直接渲染就会出现「conversation.row.unreadable」这样的裸键；这里保证正文始终是一句人话。
 */
const UNREADABLE_ROW_LAST_RESORT: Readonly<Record<Locale, string>> = {
  "zh-CN": "这条内容无法读取",
  "en-US": "This message can’t be read",
};

export interface UnreadableRowCopySource {
  formatMessage: (id: string) => string;
  locale: Locale;
}

export interface UnreadableRowCopy {
  title: string;
  /** 未知 reason、或提示键缺失时没有提示：只有标题，不出现裸键或 undefined。 */
  hint?: string;
}

/** 已知 reason 才有提示；未知值（协议今后新增的降级原因）只回退标题。 */
export function resolveUnreadableRowHintMessageId(reason: unknown): string | null {
  if (typeof reason !== "string" || !Object.hasOwn(UNREADABLE_ROW_HINT_MESSAGE_IDS, reason)) {
    return null;
  }
  return UNREADABLE_ROW_HINT_MESSAGE_IDS[reason as UnreadableRowReason] ?? null;
}

function readMessage(formatMessage: (id: string) => string, id: string): string | null {
  const text = formatMessage(id).trim();
  // 缺键时 formatMessage 原样返回 id；空串同样不能当作正文。
  return text.length === 0 || text === id ? null : text;
}

export function resolveUnreadableRowCopy(
  source: UnreadableRowCopySource,
  reason: unknown,
): UnreadableRowCopy {
  const hintId = resolveUnreadableRowHintMessageId(reason);
  const hint = hintId === null ? null : readMessage(source.formatMessage, hintId);
  const title = readMessage(source.formatMessage, UNREADABLE_ROW_TITLE_MESSAGE_ID);
  if (title !== null && hint !== null) return { title, hint };
  if (title !== null) return { title };
  // 标题键缺失时提示文案比空正文更有用；两者都缺失才用最后回退。
  if (hint !== null) return { title: hint };
  return {
    title: UNREADABLE_ROW_LAST_RESORT[source.locale] ?? UNREADABLE_ROW_LAST_RESORT[DEFAULT_LOCALE]!,
  };
}

/** DOM 只回显归一化后的 reason；原始 reason 值（可能来自更新的版本）不进属性。 */
function resolveUnreadableRowReasonAttribute(reason: unknown): UnreadableRowReason | "unknown" {
  return reason === "unknownKind" || reason === "invalidRow" ? reason : "unknown";
}

/**
 * 占位行正文。不带外壳：行身份（rowId 与行测试 id）只由 ConversationRowView 的 RowShell 维护，
 * 这里只负责画「读不懂」这一条说明，避免出现第二条行身份写入路径。
 */
export const UnreadableRowBody = memo(function UnreadableRowBody({
  row,
}: {
  row: UnreadableConversationRow;
}) {
  const { intl, locale } = useZCodeIntl();
  const copy = resolveUnreadableRowCopy(
    { formatMessage: (id) => intl.formatMessage({ id }), locale },
    row.reason,
  );
  return (
    <div
      data-v4-unreadable-row="true"
      data-v4-unreadable-row-reason={resolveUnreadableRowReasonAttribute(row.reason)}
      className="flex items-start gap-2 rounded-lg border border-border/60 px-3 py-2 text-ui-xs text-foreground-subtle"
    >
      <InfoIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <div className="flex min-w-0 flex-col gap-1">
        <span className="break-words">{copy.title}</span>
        {copy.hint === undefined ? null : <span className="break-words">{copy.hint}</span>}
      </div>
    </div>
  );
});
