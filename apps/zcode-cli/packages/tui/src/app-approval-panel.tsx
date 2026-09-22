import React from "react";
import type { ApprovalPrompt } from "./app-model.js";
import { approvalDecisions, palette } from "./app-model.js";
import {
  approvalDecisionLabel,
  isOfficialCuaProjectApproval,
  approvalPermissionScopes,
  approvalRequestDescription,
  previewPermissionInput,
  type ApprovalPermissionScopeKind,
} from "./app-approval.js";
import { truncateDisplay, wordWrappedLineCount } from "./app-terminal-width.js";
import { QuestionPanel } from "./app-question-panel.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

/**
 * 批准范围的三档文案。`any` 是范围最大的一档（该工具的**全部调用**），
 * 必须与"仅此一条"用词区分开，否则用户看不出自己批准了多大范围。
 */
const APPROVAL_SCOPE_LABELS: Record<ApprovalPermissionScopeKind, string> = {
  any: "Any command of this tool",
  exact: "Exact command only",
  prefix: "Command prefix",
};

const APPROVAL_PANEL_CHROME_ROWS = 4;
const APPROVAL_FALLBACK_CONTENT_WIDTH = 80;
const APPROVAL_MIN_CONTENT_WIDTH = 8;
const APPROVAL_PREVIEW_MAX_CELLS = 120;

type ApprovalTextRow = {
  fg: string;
  height: number;
  key: string;
  text: string;
};

export function ApprovalPanel({
  approval,
  contentWidth,
}: {
  approval: ApprovalPrompt;
  contentWidth?: number;
}): React.ReactElement {
  if (approval.questionState) {
    return h(QuestionPanel, { state: approval.questionState });
  }

  const rowContentWidth = normalizeApprovalContentWidth(contentWidth);
  const rows = approvalRows(approval, rowContentWidth);
  const panelHeight =
    APPROVAL_PANEL_CHROME_ROWS + rows.reduce((height, row) => height + row.height, 0);

  return h(
    "box",
    {
      title: `Approval required: ${approval.request.toolName}`,
      style: {
        backgroundColor: palette.panel,
        border: true,
        borderColor: palette.warning,
        flexDirection: "column",
        height: panelHeight,
        marginBottom: 1,
        padding: 1,
        width: "100%",
      },
    },
    ...rows.map((row) =>
      h(
        "text",
        {
          key: row.key,
          style: {
            fg: row.fg,
            height: row.height,
            width: "100%",
            wrapMode: "word",
          },
        },
        row.text,
      ),
    ),
  );
}

function approvalRows(approval: ApprovalPrompt, contentWidth: number): ApprovalTextRow[] {
  const rows = [
    approvalTextRow(
      "reason",
      approvalRequestDescription(approval.request),
      palette.warning,
      contentWidth,
    ),
    approvalTextRow(
      "input",
      truncateDisplay(previewPermissionInput(approval.request.input), APPROVAL_PREVIEW_MAX_CELLS),
      palette.muted,
      contentWidth,
    ),
  ];

  for (const [index, scope] of approvalPermissionScopes(approval.request).entries()) {
    rows.push(
      approvalTextRow(
        `scope-${index}`,
        // 三种范围都要有自己的文案：无 ruleContent 的规则匹配该工具的**全部调用**，
        // 是三者里范围最大的那个，不能与"仅此一条"混为一谈（task-72 的 P1）。
        `${APPROVAL_SCOPE_LABELS[scope.kind]}: ${scope.text}`,
        scope.kind === "any" ? palette.warning : palette.muted,
        contentWidth,
      ),
    );
  }

  if (isOfficialCuaProjectApproval(approval.request)) {
    rows.push(
      approvalTextRow(
        "computer-use-scope",
        "Do not ask again for official Computer Use actions in this project",
        palette.muted,
        contentWidth,
      ),
    );
  }

  for (const decision of approvalDecisions) {
    rows.push(
      approvalTextRow(
        decision,
        `${approval.selectedDecision === decision ? ">" : " "} ${approvalDecisionLabel(decision, approval.request)}`,
        approval.selectedDecision === decision ? palette.accent : palette.text,
        contentWidth,
      ),
    );
  }

  rows.push(
    approvalTextRow(
      "help",
      "Up/Down choose, Enter confirms, Esc denies",
      palette.muted,
      contentWidth,
    ),
  );
  return rows;
}

function approvalTextRow(
  key: string,
  text: string,
  fg: string,
  contentWidth: number,
): ApprovalTextRow {
  return {
    fg,
    height: wordWrappedLineCount(text, contentWidth),
    key,
    text,
  };
}

function normalizeApprovalContentWidth(contentWidth: number | undefined): number {
  if (contentWidth === undefined || !Number.isFinite(contentWidth)) {
    return APPROVAL_FALLBACK_CONTENT_WIDTH;
  }
  return Math.max(APPROVAL_MIN_CONTENT_WIDTH, Math.floor(contentWidth));
}
