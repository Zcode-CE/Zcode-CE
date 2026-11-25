import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { UnreadableConversationRow } from "@zcode/shared/zcode-protocol-v4";
import {
  resolveUnreadableRowCopy,
  resolveUnreadableRowHintMessageId,
  UnreadableRowBody,
} from "../src/v4/conversationUnreadableRow.js";

/**
 * 会话行逐行降级的 UI 判据（协议：shared/zcode-protocol-v4/rows.ts 的 UnreadableConversationRow）。
 *
 * 回归的是「静默丢行」：占位行原本落到 ConversationRowView 的 default 分支返回 null，
 * 用户看不到「这条读不出来」，只会以为消息丢了。这里钉住三条性质：
 * 1. 占位行渲染出说明文案，且原始载荷与 sourceKind 不得进入 DOM；
 * 2. 未知 reason（未来协议新增的降级原因）只回退标题，不把裸键或 undefined 当正文；
 * 3. 字典缺键时正文仍有明确回退，绝不显示键名。
 */

const here = dirname(fileURLToPath(import.meta.url));
const TITLE_ZH = "这条内容无法读取（可能来自更新版本，也可能是数据已损坏）";

function unreadableRow(overrides: Record<string, unknown> = {}): UnreadableConversationRow {
  return {
    kind: "unreadable",
    rowId: 42,
    turnId: "turn-1",
    createdAt: 1_760_000_000_000,
    createdAtSeq: 7,
    sourceKind: "toolCall",
    reason: "invalidRow",
    // 占位行按协议不携带载荷；这里故意多塞字段，证明正文不会吃到它们。
    text: "RAW_PAYLOAD_MUST_NOT_RENDER",
    toolName: "leakedToolName",
    display: { kind: "leakedDisplayKind" },
    ...overrides,
  } as unknown as UnreadableConversationRow;
}

async function renderRow(
  row: UnreadableConversationRow,
  locale: "zh-CN" | "en-US" = "zh-CN",
): Promise<string> {
  const { ZCodeIntlProvider } = await import("../src/i18n/IntlProvider.js");
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(UnreadableRowBody, { row }),
    ),
  );
}

test("判据：不可读行渲染占位说明，原始载荷与 sourceKind 不进 DOM", async () => {
  const html = await renderRow(unreadableRow());
  assert.ok(html.includes('data-v4-unreadable-row="true"'), html);
  assert.ok(html.includes(TITLE_ZH), "占位行必须说明这一行读不出来：" + html);
  assert.ok(
    html.includes("这条内容的字段与当前版本不一致"),
    "invalidRow 必须给出可操作提示（更新版本）：" + html,
  );
  assert.equal(html.includes("RAW_PAYLOAD_MUST_NOT_RENDER"), false);
  assert.equal(html.includes("leakedToolName"), false);
  assert.equal(html.includes("leakedDisplayKind"), false);
  assert.equal(html.includes("toolCall"), false, "sourceKind 是原始事实，不得写进 DOM");
  assert.equal(html.includes("undefined"), false);
  // 英文界面走同一组件、同一 reason 分支；缺这一条时双语回退坏掉只会表现为界面变中文。
  const englishHtml = await renderRow(unreadableRow(), "en-US");
  assert.ok(englishHtml.includes("newer version or be corrupted"), englishHtml);
});

test("判据：未知 reason 只回退标题，不出现裸键、reason 原文或 undefined", async () => {
  assert.equal(resolveUnreadableRowHintMessageId("futureReason"), null);
  assert.equal(resolveUnreadableRowHintMessageId(undefined), null);
  const html = await renderRow(unreadableRow({ reason: "futureReason" }));
  assert.ok(html.includes(TITLE_ZH), "未知 reason 仍要说明这一行读不出来：" + html);
  assert.ok(html.includes('data-v4-unreadable-row-reason="unknown"'), html);
  assert.equal(html.includes("futureReason"), false);
  assert.equal(html.includes("conversation.row.unreadable"), false);
  assert.equal(html.includes("undefined"), false);
  assert.equal(
    html.includes("更新 ZCode 到最新版本"),
    false,
    "未知 reason 没有对应提示：不能借用其他 reason 的提示",
  );
});

test("判据：字典缺键时正文有明确回退，不显示键名或 undefined", () => {
  const keysOnly = (id: string) => id;
  const missingAll = resolveUnreadableRowCopy(
    { formatMessage: keysOnly, locale: "zh-CN" },
    "invalidRow",
  );
  assert.deepEqual(missingAll, { title: "这条内容无法读取" });

  // 只有标题键缺失：提示文案比空正文更有用。
  const titleMissing = resolveUnreadableRowCopy(
    {
      formatMessage: (id) =>
        id === "conversation.row.unreadable.invalidRow" ? "请更新到最新版本" : id,
      locale: "zh-CN",
    },
    "invalidRow",
  );
  assert.deepEqual(titleMissing, { title: "请更新到最新版本" });

  const englishFallback = resolveUnreadableRowCopy(
    { formatMessage: keysOnly, locale: "en-US" },
    undefined,
  );
  assert.deepEqual(englishFallback, { title: "This message can’t be read" });
});

test("判据：选择器不会丢掉占位行，且历史折叠默认展开（用户能直接看到）", async () => {
  const { buildConversationTurnRenderUnits } =
    await import("../src/v4/conversationTurnRenderUnits.js");
  const rows = [
    {
      kind: "turnHeader",
      rowId: 1,
      turnId: "turn-1",
      createdAt: 1,
      createdAtSeq: 1,
      origin: "userInput",
    },
    {
      kind: "userInput",
      rowId: 2,
      turnId: "turn-1",
      createdAt: 2,
      createdAtSeq: 2,
      origin: "realUser",
      text: "hi",
    },
    unreadableRow({ rowId: 3, turnId: "turn-1", createdAt: 3, createdAtSeq: 3 }),
  ] as unknown as Parameters<typeof buildConversationTurnRenderUnits>[0];
  const units = buildConversationTurnRenderUnits(rows, {});
  assert.equal(units.length, 1);
  const unit = units[0]!;
  assert.ok(
    unit.renderRows.some((row) => row.kind === "unreadable" && row.rowId === 3),
    "占位行必须留在轮的 renderRows 里，否则查找与诊断会少一行",
  );
  const flowRowIds = unit.flowItems.flatMap((item) =>
    item.kind === "userInput" || item.kind === "assistantText"
      ? [item.row.rowId]
      : item.rows.map((row) => row.rowId),
  );
  assert.ok(flowRowIds.includes(3), "占位行必须进入 flowItems，否则 TurnGroup 不会渲染它");
  assert.equal(
    unit.assistantHistoryDefaultOpen,
    true,
    "轮内只有占位行时历史组必须默认展开，否则用户仍看不到「这行读不出来」",
  );
});

test("判据：行分发覆盖 unreadable（否则占位行会被静默跳过）", () => {
  // ConversationRowView 的 import 图会拉入 svg 资源，node:test 无法直接渲染它；
  // 这里退一步钉住分发源码，代价是文件改名或重排时需要同步维护。
  const source = readFileSync(resolve(here, "../src/v4/ConversationRowView.tsx"), "utf8");
  const start = source.indexOf(`case "unreadable":`);
  assert.ok(start >= 0, "ConversationRowView 的 switch 必须覆盖 unreadable 行");
  const branch = source.slice(start, start + 400);
  assert.ok(branch.includes("<RowShell rowId={row.rowId}"), branch);
  assert.ok(branch.includes("<UnreadableRowBody row={row} />"), branch);
});
