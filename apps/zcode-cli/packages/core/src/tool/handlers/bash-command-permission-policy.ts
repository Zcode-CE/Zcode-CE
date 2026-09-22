import type { PermissionRuleValue, PermissionUpdate } from "@zcode/contracts";
import { resolveDangerousCommandPolicy, type ResolvedDangerousCommandPolicy } from "@zcode/shared";
import type { ToolPermissionRulePolicy, ToolRuntimePermissionCapabilityContext } from "../types.js";
import {
  analyzeBashCommand,
  isBashCommandPermissionSafe,
  type BashCommandAnalysis,
  type BashCommandInvocation,
} from "./bash-command-parser.js";
import { evaluateBashRules } from "./bash-command-rule-evaluator.js";
import {
  filterDangerousAllowRules,
  isDangerousInvocation,
} from "./bash-command-dangerous-policy.js";
import {
  executableBasename,
  isStaticAssignmentToken,
  unwrapCommand,
} from "./bash-command-wrapper.js";
import {
  BASH_COMMAND_REGISTRY,
  type BashCommandRegistryNode,
} from "./generated/bash-command-registry.js";
import { isRuntimeReadOnlyBashCommand } from "./bash-semantics.js";

const MAX_SUGGESTED_RULES = 5;
const ARG_IS_COMMAND = 1;
const ARG_IS_MODULE = 2;
const SCRIPT_ACTIONS = new Map([
  ["bun", new Set(["run"])],
  ["deno", new Set(["task"])],
  ["npm", new Set(["run", "run-script"])],
  ["pnpm", new Set(["run"])],
  ["yarn", new Set(["run"])],
]);
const TARGET_ACTIONS = new Set(["just", "make"]);
const PYTHON_EXECUTABLES = new Set(["python", "python3", "py"]);
const FAMILY_DEPTH_OVERRIDES: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  aws: { "*": 2 },
  az: { "*": 2 },
  docker: { compose: 2 },
  gcloud: { "*": 3 },
  kubectl: { config: 2 },
};

export function resolveBashPermissionRulePolicy(
  input: unknown,
  context?: ToolRuntimePermissionCapabilityContext,
): ToolPermissionRulePolicy | undefined {
  const command = readCommand(input);
  if (command === undefined) return undefined;
  return createBashPermissionRulePolicy(command, context);
}

function createBashPermissionRulePolicy(
  command: string,
  context?: ToolRuntimePermissionCapabilityContext,
): ToolPermissionRulePolicy {
  const rawCommand = command.trim();
  const exactCommands = command === rawCommand ? [rawCommand] : [command, rawCommand];
  const analysis = analyzeBashCommand(command);
  const safe = isAnalysisSafeForPrefix(analysis);
  // 危险命令策略（工具与权限页）。**缺席即严格** —— 不要在这里加「宽松」默认分支。
  // 必须在算 subject group 之前拿到：subject group 里的稳定前缀要经过危险门控。
  const dangerous = resolveDangerousCommandPolicy(context?.dangerousCommandPolicy);
  const guard = (invocation: BashCommandInvocation) =>
    buildInvocationRuleSubjects(invocation, dangerous);
  const allSubjectGroups = safe ? analysis.commands.map(guard) : [];
  const requiredCommands = safe
    ? analysis.commands.filter(
        (invocation) => !isRuntimeReadOnlyBashCommand(invocation.commandText, context),
      )
    : [];
  const requiredSubjectGroups = requiredCommands.map(guard);
  // 逐 invocation 判危险，而不是整条命令判一次：evaluateBashRules 对 allow 的语义是
  // 「每个 required invocation 都要命中一条规则」，保守化必须按同一粒度施加，
  // 否则复合命令里的一条危险 invocation 会把整条命令的规则集过滤掉（过度收紧）。
  const hasDangerousCommand = requiredCommands.some((invocation) =>
    isDangerousInvocation(dangerous, invocation, resolveRawStableCommandPrefix(invocation)),
  );
  const suggestedPermissionUpdates = buildSuggestedUpdates(
    rawCommand,
    safe,
    requiredCommands,
    dangerous,
  );

  return {
    evaluateRules(behavior, rules) {
      // 裁决 3「评估时撤销」：加严后，此前落盘的授权规则不得再静默放行。
      // 只对含危险命令的 allow 判定生效 —— deny / ask 继续用完整规则集。
      const effectiveRules =
        behavior === "allow" && hasDangerousCommand
          ? filterDangerousAllowRules(dangerous, rules)
          : rules;
      return evaluateBashRules({
        allSubjectGroups,
        behavior,
        exactCommands,
        requiredSubjectGroups,
        rules: effectiveRules,
        safe,
      });
    },
    suggestedPermissionUpdates,
    // 严格态下危险命令不进入持久授权（任务裁决 1 的"策略开关"落点）：
    // 复用既有的 PermissionOptionsPolicy 机制（save-workflow.ts 已用 allowAlways:false），
    // 由 approval-gate 折进这次 ask 的选项集，最终由 permission-options.ts 裁掉
    // allow_project / allowSession。**只在严格态 + 命中危险命令时收窄** ——
    // 放宽态与普通命令完全不改变现有行为。
    ...(hasDangerousCommand && !dangerous.allowPersistentAuthorization
      ? { optionsPolicy: "no-always-allow" as const }
      : {}),
  };
}

function buildInvocationRuleSubjects(
  invocation: BashCommandInvocation,
  dangerous: ResolvedDangerousCommandPolicy,
): string[] {
  const rawSubject = normalizeInvocation(invocation);
  const stablePrefix = resolveStableCommandPrefix(invocation, dangerous);
  // 保存规则会移除 --dir/-C 等全局 flag，但旧 evaluator 只拿原始 invocation
  // 比较，导致 UI 明明保存了 `pnpm run lint:*`，下一轮仍无法命中。保留 raw subject
  // 兼容历史 wildcard，同时加入相同 resolver 得出的稳定 action subject。
  return stablePrefix && stablePrefix !== rawSubject ? [rawSubject, stablePrefix] : [rawSubject];
}

function buildSuggestedUpdates(
  rawCommand: string,
  safe: boolean,
  requiredCommands: readonly BashCommandInvocation[],
  dangerous: ResolvedDangerousCommandPolicy,
): PermissionUpdate[] {
  if (rawCommand.length === 0) return [];
  if (!safe || requiredCommands.length === 0 || requiredCommands.length > MAX_SUGGESTED_RULES) {
    return exactUpdate(rawCommand);
  }

  const rules: PermissionRuleValue[] = [];
  const seen = new Set<string>();
  for (const invocation of requiredCommands) {
    // 危险命令在这里天然退化为精确规则：resolveStableCommandPrefix 对它返回 undefined
    // （见那里的注释）。所以「永不生成 :*」不需要第二个判据 —— 保持单一决策点。
    const prefix = resolveStableCommandPrefix(invocation, dangerous);
    if (!prefix) return exactUpdate(rawCommand);
    const ruleContent = `${prefix}:*`;
    if (seen.has(ruleContent)) continue;
    seen.add(ruleContent);
    rules.push({ ruleContent, toolName: "Bash" });
  }
  if (rules.length === 0 || rules.length > MAX_SUGGESTED_RULES) return exactUpdate(rawCommand);
  return [{ behavior: "allow", rules, type: "addRules" }];
}

function exactUpdate(rawCommand: string): PermissionUpdate[] {
  return [
    {
      behavior: "allow",
      rules: [{ ruleContent: rawCommand, toolName: "Bash" }],
      type: "addRules",
    },
  ];
}

function isAnalysisSafeForPrefix(analysis: BashCommandAnalysis): boolean {
  return (
    isBashCommandPermissionSafe(analysis) &&
    !analysis.hasRedirects &&
    analysis.commands.length > 0 &&
    analysis.commands.every(
      (invocation) =>
        !invocation.hasRedirects &&
        !invocation.hasDynamicWords &&
        staticAssignmentTokens(invocation) !== undefined,
    )
  );
}

function normalizeInvocation(invocation: BashCommandInvocation): string {
  return [...(staticAssignmentTokens(invocation) ?? []), ...invocation.argv].join(" ");
}

/**
 * 稳定命令前缀，**带危险命令门控**。
 *
 * 危险命令返回 undefined ⇒ 上层退化为精确规则（任务裁决 2 / 安全审计 P2）。
 * 这里取代了原 `HIGH_RISK_ROOT_COMMANDS.has(executableName)` 的硬编码表：判据扩到
 * **生效清单**（默认项 − 关闭项 ∪ 用户自加项）**并含 wrapper 链** —— 原表只看内层
 * 可执行名，所以 `sudo` 永不触发保守化（task-67 §7.5「债 1」）。
 */
function resolveStableCommandPrefix(
  invocation: BashCommandInvocation,
  dangerous: ResolvedDangerousCommandPolicy,
): string | undefined {
  if (isDangerousInvocation(dangerous, invocation, resolveRawStableCommandPrefix(invocation))) {
    return undefined;
  }
  return resolveRawStableCommandPrefix(invocation);
}

/**
 * 稳定命令前缀的**纯解析**（不含危险命令门控）。
 *
 * 单独保留是因为危险判定本身需要它：用户自加项可以写成带参数的形式（`docker run`），
 * 那种项按前缀匹配，所以判定必须先拿到前缀 —— 用带门控的版本会自相矛盾
 * （危险 ⇒ 无前缀 ⇒ 带参数项永远匹配不上）。
 */
function resolveRawStableCommandPrefix(invocation: BashCommandInvocation): string | undefined {
  const assignments = staticAssignmentTokens(invocation);
  if (!assignments || invocation.argv.length === 0) return undefined;
  const unwrapped = unwrapCommand(invocation.argv);
  if (!unwrapped) return undefined;
  const executableName = executableBasename(unwrapped.executable);

  const prefix = [...assignments, ...unwrapped.prefix, unwrapped.executable];
  const remaining = invocation.argv.slice(unwrapped.nextIndex);
  const directOverride = resolveDepthOverride(executableName, remaining);
  if (directOverride) {
    prefix.push(...directOverride);
    return serializePrefix(prefix);
  }

  let node = BASH_COMMAND_REGISTRY[executableName];
  if (!node) return undefined;
  const override = resolveDepthOverride(executableName, skipLeadingKnownOptions(node, remaining));
  if (override) {
    prefix.push(...override);
    return serializePrefix(prefix);
  }

  let index = 0;
  let matchedAction = false;
  while (index < remaining.length) {
    const optionEnd = skipKnownOption(node, remaining, index);
    if (optionEnd !== undefined) {
      index = optionEnd;
      continue;
    }

    const token = remaining[index]!;
    const child = node[3].find((candidate) => candidate[0].includes(token));
    if (child) {
      prefix.push(token);
      matchedAction = true;
      node = child;
      index += 1;
      continue;
    }

    if ((node[2] & (ARG_IS_COMMAND | ARG_IS_MODULE)) !== 0 && !looksLikePathOrUrl(token)) {
      prefix.push(token);
      matchedAction = true;
    }
    break;
  }

  return matchedAction ? serializePrefix(prefix) : undefined;
}

function skipLeadingKnownOptions(
  node: BashCommandRegistryNode,
  args: readonly string[],
): readonly string[] {
  let index = 0;
  while (index < args.length) {
    const optionEnd = skipKnownOption(node, args, index);
    if (optionEnd === undefined) break;
    index = optionEnd;
  }
  return args.slice(index);
}

function resolveDepthOverride(
  executableName: string,
  args: readonly string[],
): string[] | undefined {
  if (PYTHON_EXECUTABLES.has(executableName) && args[0] === "-m" && isStableActionToken(args[1])) {
    return [args[0]!, args[1]!];
  }
  const scriptActions = SCRIPT_ACTIONS.get(executableName);
  if (scriptActions?.has(args[0] ?? "") && isStableActionToken(args[1])) {
    return [args[0]!, args[1]!];
  }
  if (TARGET_ACTIONS.has(executableName) && isStableActionToken(args[0])) {
    return [args[0]!];
  }
  const familyDepth = FAMILY_DEPTH_OVERRIDES[executableName];
  const depth = familyDepth?.[args[0] ?? ""] ?? familyDepth?.["*"];
  if (depth && args.length >= depth) {
    const action = args.slice(0, depth);
    if (action.every(isStableActionToken)) return action;
  }
  return undefined;
}

function skipKnownOption(
  node: BashCommandRegistryNode,
  args: readonly string[],
  index: number,
): number | undefined {
  const token = args[index]!;
  if (!token.startsWith("-") || token === "-") return undefined;
  if (token === "--") return index + 1;
  const optionName = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
  const option = node[1].find((candidate) => candidate[0].includes(optionName));
  if (!option) return undefined;
  return index + (option[1] === 1 && !token.includes("=") ? 2 : 1);
}

function staticAssignmentTokens(invocation: BashCommandInvocation): string[] | undefined {
  const tokens: string[] = [];
  for (const assignment of invocation.envAssignments) {
    if (!assignment.name || assignment.value === undefined) return undefined;
    const token = `${assignment.name}=${assignment.value}`;
    if (!isStaticAssignmentToken(token)) return undefined;
    tokens.push(token);
  }
  return tokens;
}

function isStableActionToken(token: string | undefined): token is string {
  return (
    Boolean(token) && !token!.startsWith("-") && !looksLikePathOrUrl(token!) && !/\s/.test(token!)
  );
}

function looksLikePathOrUrl(token: string): boolean {
  return (
    token.includes("://") ||
    token.startsWith("./") ||
    token.startsWith("../") ||
    token.startsWith("/") ||
    token.startsWith("~") ||
    /^[A-Za-z]:[\\/]/.test(token)
  );
}

function serializePrefix(tokens: readonly string[]): string | undefined {
  if (tokens.length < 2 || tokens.some((token) => token.length === 0 || /\s/.test(token))) {
    return undefined;
  }
  return tokens.join(" ");
}

function readCommand(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const command = (input as Record<string, unknown>).command;
  return typeof command === "string" ? command : undefined;
}
