import type { ZCodePermissionOption } from "@zcode/shared";

/**
 * 从权限选项携带的 permissionUpdates 里抽出「这次批准到底授予了多大范围」。
 *
 * 三种形态**都必须展示**，缺一种就是静默放大授权（安全审计 task-72 的 P1）：
 * - `any`：无 ruleContent ⇒ 该工具**任意命令**。core 的 bash-command-rule-evaluator
 *   第 14 行 `if (input.rules.some((rule) => !rule.ruleContent)) return true;` 让这条规则
 *   匹配一切。原实现按 `endsWith(":*")` 硬过滤，恰好把这条规则从可视化里剔除 ——
 *   于是用户在**没有任何范围提示**的情况下批准了整个工具的任意命令，
 *   三层 UI 兜底（preview.command=null、scope="generic"、ruleScopes=[]）全部失效。
 * - `prefix`：`:*` 后缀 ⇒ 同前缀族全部命令（`npm install:*` 覆盖任意包）。
 * - `exact`：精确规则 ⇒ 仅此一条。
 *
 * 放在 lib 而不是 PermissionDialog 里：这是纯函数，抽出来才可测。
 * 本地化留给调用点（那里才有 intl），`any` 的 display 为空串、由调用点填文案。
 */

export const PERMISSION_RULE_SCOPE_MAX_DISPLAY_CHARS = 160;
export const PERMISSION_RULE_SCOPE_MAX_COUNT = 5;

export interface PermissionRuleScope {
  display: string;
  truncated: boolean;
  /** `any` = 无 ruleContent（匹配一切）；`prefix` = `:*` 前缀；`exact` = 精确一条命令。 */
  kind: "any" | "prefix" | "exact";
  /** `any` 形态需要它来把文案写成「<工具> 的任意命令」。 */
  toolName: string;
}

export function formatPermissionRuleScope(
  content: string,
  kind: "prefix" | "exact",
  toolName: string,
): PermissionRuleScope {
  const lineBreakIndex = content.search(/\r?\n/);
  const firstLine = lineBreakIndex === -1 ? content : content.slice(0, lineBreakIndex);
  const truncated =
    lineBreakIndex !== -1 || firstLine.length > PERMISSION_RULE_SCOPE_MAX_DISPLAY_CHARS;

  const suffix = " …";
  const visible = firstLine
    .slice(0, PERMISSION_RULE_SCOPE_MAX_DISPLAY_CHARS - suffix.length)
    .trimEnd();
  return { display: `${visible}${suffix}`, kind, toolName, truncated };
}

export function readPermissionRuleScopes(
  option: Pick<ZCodePermissionOption, "response">,
): PermissionRuleScope[] {
  const scopes: PermissionRuleScope[] = [];
  for (const update of option.response?.permissionUpdates ?? []) {
    if (update.type !== "addRules" || update.behavior !== "allow") continue;
    for (const rule of update.rules) {
      const content = rule.ruleContent?.trim();
      // 无 ruleContent 的检查**必须排在 Bash 过滤之前**：它匹配一切，
      // 对任何工具都是"整工具授权"，不是 Bash 专属现象。
      if (!content) {
        scopes.push({ display: "", kind: "any", toolName: rule.toolName, truncated: false });
        continue;
      }
      if (rule.toolName.toLowerCase() !== "bash") continue;
      if (content.endsWith(":*")) {
        scopes.push(formatPermissionRuleScope(content.slice(0, -2), "prefix", rule.toolName));
        continue;
      }
      scopes.push(formatPermissionRuleScope(content, "exact", rule.toolName));
    }
  }
  return scopes.slice(0, PERMISSION_RULE_SCOPE_MAX_COUNT);
}
