import type { PermissionBrokerRequest, PermissionBrokerResult } from "@zcode/contracts";
import { OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME } from "@zcode/shared";
import type { KeyEvent } from "@mbears/opentui-core";
import type React from "react";
import type { ApprovalDecision, ApprovalPrompt } from "./app-model.js";
import { approvalDecisions } from "./app-model.js";
import { clampIndex } from "./app-input.js";
import { handleQuestionKey } from "./app-question-state.js";
import { asRecord, stringField } from "./state.js";

const COMMAND_INPUT_FIELD = "command";
const DESCRIPTION_INPUT_FIELD = "description";

export function handleApprovalKey(
  key: KeyEvent,
  approval: ApprovalPrompt,
  setApprovalQueue: React.Dispatch<React.SetStateAction<ApprovalPrompt[]>>,
  setStatus: (status: string) => void,
): void {
  if (approval.questionState) {
    handleQuestionKey(key, approval, setApprovalQueue, setStatus);
    return;
  }

  if (key.name === "up" || key.name === "down") {
    const delta = key.name === "up" ? -1 : 1;
    setApprovalQueue((current) => {
      const [first, ...rest] = current;
      if (!first) return current;
      const selectedIndex = approvalDecisions.indexOf(first.selectedDecision);
      return [
        {
          ...first,
          selectedDecision:
            approvalDecisions[clampIndex(selectedIndex + delta, approvalDecisions.length)] ??
            "deny",
        },
        ...rest,
      ];
    });
    return;
  }

  if (key.name === "return") {
    resolveApproval(approval, approval.selectedDecision, setApprovalQueue, setStatus);
    return;
  }

  if (key.name === "escape") {
    resolveApproval(approval, "deny", setApprovalQueue, setStatus);
  }
}

export function approvalDecisionLabel(
  decision: ApprovalDecision,
  request?: PermissionBrokerRequest,
): string {
  if (decision === "allow_once") return "Allow once";
  if (decision === "allow_project") {
    return request && isOfficialCuaProjectApproval(request)
      ? "Always allow Computer Use in this project"
      : "Always allow in this project";
  }
  return "Deny";
}

export function isOfficialCuaProjectApproval(request: PermissionBrokerRequest): boolean {
  return permissionUpdatesForApproval(request).some(
    (update) =>
      update.type === "addRules" &&
      update.behavior === "allow" &&
      update.rules.some((rule) => rule.toolName === OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME),
  );
}

export function approvalRequestDescription(request: PermissionBrokerRequest): string {
  return stringField(asRecord(request.input), DESCRIPTION_INPUT_FIELD) ?? request.reason;
}

export function previewPermissionInput(input: unknown): string {
  const command = stringField(asRecord(input), COMMAND_INPUT_FIELD);
  if (command) return command;
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

export type ApprovalPermissionScopeKind = "any" | "exact" | "prefix";

export interface ApprovalPermissionScope {
  kind: ApprovalPermissionScopeKind;
  /** `any` 形态下装的是**工具名**（文案由渲染侧补）；其余形态是规则内容。 */
  text: string;
}

/**
 * 抽出「这次批准会记住什么」，供 TUI 确认面板展示。
 *
 * 与 GUI 的 `readPermissionRuleScopes`（packages/ui/src/lib/permissionRuleScopes.ts）
 * **必须同构** —— 两处各写一份就会漂移，而它们服务的是同一个安全语义。
 *
 * 三种形态都必须展示，缺一种就是静默放大授权（安全审计 task-72 的 P1）：
 * - `any`：无 ruleContent ⇒ 该工具**任意命令**。core 的 bash-command-rule-evaluator
 *   第 14 行 `if (input.rules.some((rule) => !rule.ruleContent)) return true;` 让这条规则
 *   匹配一切。原实现 `if (!content) continue;` 恰好把它从可视化里剔除 ——
 *   用户在没有任何范围提示的情况下批准了整个工具的任意命令。
 * - `prefix`：`:*` 后缀 ⇒ 同前缀族全部命令。
 * - `exact`：精确规则 ⇒ 仅此一条。
 */
export function approvalPermissionScopes(
  request: PermissionBrokerRequest,
): ApprovalPermissionScope[] {
  const scopes: ApprovalPermissionScope[] = [];
  for (const update of permissionUpdatesForApproval(request)) {
    if (update.type !== "addRules" || update.behavior !== "allow") continue;
    for (const rule of update.rules) {
      const content = rule.ruleContent?.trim();
      // 无 ruleContent 的检查必须排在 Bash 过滤之前：它匹配一切，
      // 对任何工具都是「整工具授权」，不是 Bash 专属现象。
      if (!content) {
        scopes.push({ kind: "any", text: rule.toolName });
        continue;
      }
      if (rule.toolName.toLowerCase() !== "bash") continue;
      scopes.push(
        content.endsWith(":*")
          ? { kind: "prefix", text: `${content.slice(0, -2)} …` }
          : { kind: "exact", text: content },
      );
    }
  }
  return scopes.slice(0, 5);
}

function resolveApproval(
  approval: ApprovalPrompt,
  decision: ApprovalDecision,
  setApprovalQueue: React.Dispatch<React.SetStateAction<ApprovalPrompt[]>>,
  setStatus: (status: string) => void,
): void {
  approval.cleanup();
  approval.resolve(createApprovalResult(approval.request, decision));
  setApprovalQueue((current) => current.filter((item) => item !== approval));
  setStatus(`Permission ${approvalStatusLabel(decision)} for ${approval.request.toolName}.`);
}

function createApprovalResult(
  request: PermissionBrokerRequest,
  decision: ApprovalDecision,
): PermissionBrokerResult {
  if (decision === "deny") {
    return {
      decision: "deny",
      reason: "Denied in TUI",
      resolvedAt: new Date(),
    };
  }

  return {
    decision: "allow",
    permissionUpdates:
      decision === "allow_project" ? permissionUpdatesForApproval(request) : undefined,
    reason: decision === "allow_project" ? "Approved for this project in TUI" : "Approved in TUI",
    resolvedAt: new Date(),
  };
}

function permissionUpdatesForApproval(request: PermissionBrokerRequest) {
  if (request.suggestedPermissionUpdates?.length) return request.suggestedPermissionUpdates;
  const permissionRuleContent = ruleContentFromApprovalInput(request.input);
  return [
    {
      behavior: "allow" as const,
      rules: [
        {
          toolName: request.toolName,
          ...(permissionRuleContent ? { ruleContent: permissionRuleContent } : {}),
        },
      ],
      type: "addRules" as const,
    },
  ];
}

function approvalStatusLabel(decision: ApprovalDecision): string {
  if (decision === "deny") return "denied";
  return decision === "allow_project" ? "approved for this project" : "approved";
}

function ruleContentFromApprovalInput(input: unknown): string | undefined {
  if (typeof input === "string") return input;
  const record = asRecord(input);
  for (const key of [COMMAND_INPUT_FIELD, "url", "file_path", "path", "pattern"]) {
    const value = stringField(record, key);
    if (value) return value;
  }
  return undefined;
}
