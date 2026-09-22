/**
 * 危险命令的 Bash 侧判定（从 bash-command-permission-policy.ts 拆出）。
 *
 * 清单本身与匹配语义在 `@zcode/shared/dangerousCommands`（UI 与 core 共用的唯一真相源）；
 * 这里只负责**把一条 Bash invocation 归一成清单判据需要的形状**，以及**把保守化落到规则上**。
 *
 * 修复的是安全审计 task-67 §7.5「债 1」：原 `HIGH_RISK_ROOT_COMMANDS` 只查
 * `unwrapped.executable`（内层可执行名），wrapper 链完全不参与判定 —— 于是 `sudo` 永远
 * 走不到保守分支，`sudo apt install foo` 会生成 `sudo apt install:*`。
 * 本模块把 wrapper 链一并暴露给清单，提权项才真正生效。
 */
import {
  isDangerousCommandAllowRuleEffective,
  isDangerousCommandSubject,
  type DangerousCommandSubject,
  type ResolvedDangerousCommandPolicy,
} from "@zcode/shared";
import type { PermissionRuleValue } from "@zcode/contracts";
import type { BashCommandInvocation } from "./bash-command-parser.js";
import { executableBasename, unwrapCommand } from "./bash-command-wrapper.js";

/**
 * 把一条 invocation 归一成清单判据需要的形状。
 *
 * `prefix` 用调用方算好的稳定前缀（带参数的自加项按前缀匹配）；
 * `wrapperNames` 来自 `unwrapCommand` 的 prefix —— 这是「债 1」的修复点。
 */
export function toDangerousCommandSubject(
  invocation: BashCommandInvocation,
  stablePrefix: string | undefined,
): DangerousCommandSubject {
  if (invocation.argv.length === 0) {
    return { executableName: "", wrapperNames: [] };
  }
  const unwrapped = unwrapCommand(invocation.argv);
  if (!unwrapped) {
    // wrapper 链解析不出（过深 / 非常规形态）⇒ 按最保守的方式看待：
    // 用第一个 token 作为可执行名，且不假设有 wrapper。
    return {
      executableName: executableBasename(invocation.argv[0] ?? ""),
      invocation: invocation.argv.join(" "),
      wrapperNames: [],
    };
  }
  return {
    executableName: executableBasename(unwrapped.executable),
    invocation: invocation.argv.join(" "),
    // wrapper token 可能带路径（/usr/bin/sudo），消费侧统一取 basename。
    wrapperNames: unwrapped.prefix.map((token) => executableBasename(token)),
    ...(stablePrefix ? { prefix: stablePrefix } : {}),
  };
}

export function isDangerousInvocation(
  dangerous: ResolvedDangerousCommandPolicy,
  invocation: BashCommandInvocation,
  stablePrefix: string | undefined,
): boolean {
  return isDangerousCommandSubject(dangerous, toDangerousCommandSubject(invocation, stablePrefix));
}

/**
 * 危险命令的 allow 规则过滤（裁决 3「评估时撤销」的落点）。
 *
 * - **严格态**：任何持久 allow 规则都不放行 —— 用户加严后，此前落盘的规则不得再静默放行。
 *   它同时把「无 ruleContent 的规则匹配一切」（task-72 P6）这条放大器从危险命令上摘掉。
 * - **放宽态**：只认**精确规则**；`:*` 前缀与 `*` 通配一律不认 ——
 *   `docker run:*` / `npm install:*` 正是实测的放大形态。
 *
 * **只作用于 allow**。deny / ask 必须继续用完整规则集，收紧方向不能被削弱。
 */
export function filterDangerousAllowRules(
  dangerous: ResolvedDangerousCommandPolicy,
  rules: readonly PermissionRuleValue[],
): readonly PermissionRuleValue[] {
  if (dangerous.allowPersistentAuthorization) {
    return rules.filter((rule) =>
      isDangerousCommandAllowRuleEffective(dangerous, rule.ruleContent),
    );
  }
  return [];
}
