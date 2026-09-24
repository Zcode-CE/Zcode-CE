import type { GlobalOptions } from "@zcode/shared-types";

/**
 * headless 的动态工作流开关（`--enable-workflow` / `--no-enable-workflow`）。
 *
 * 与官方的默认值相反，这是本文件存在的主要理由（改这里之前先读
 * docs/development/official-diff.md 的对应小节）：
 *
 * - 官方 headless `-p` 默认关闭动态工作流，只有传 `--enable-workflow` 才打开
 *   （其 prompt-command 写的是 `dynamicWorkflowEnabled: options.enableWorkflow === true`）；
 * - 本仓库 headless `-p` 默认开启 —— core 的 `dynamicWorkflowEnabled` 是「缺席即开启」
 *   （见 core/src/runtime/types.ts 的字段注释），cli 侧过去从不写这个字段。
 *
 * 于是两边照抄会互相说反。这里的处理是：保留官方那个拼写（老脚本传了不该报未知参数），
 * 另加本仓库真正需要的反向开关 —— 在本仓库默认开启的前提下，能改变行为的只有关闭。
 */

export const ENABLE_WORKFLOW_FLAG = "--enable-workflow";
export const DISABLE_WORKFLOW_FLAG = "--no-enable-workflow";

/** 本仓库 headless 的动态工作流默认值。与官方相反：官方默认关闭，本仓库默认开启。 */
export const HEADLESS_WORKFLOW_DEFAULT_ENABLED = true;

export const ENABLE_WORKFLOW_SCOPE_ERROR =
  "--enable-workflow/--no-enable-workflow can only be used with -p/--prompt or --target.";

/** 命令行上显式给出的取值；缺席即 undefined（= 未指定，由默认值兜底）。 */
export type HeadlessWorkflowFlagValue = boolean | undefined;

/**
 * 从 parse 结果里读出显式取值。
 *
 * 两个拼写同时出现时以反向为准：`--no-enable-workflow` 是本仓库唯一能把门关上的写法，
 * 让一个不改变默认值的拼写把它覆盖掉，用户就再也关不掉了。
 */
export function resolveHeadlessWorkflowFlag(values: {
  "enable-workflow"?: unknown;
  "no-enable-workflow"?: unknown;
}): HeadlessWorkflowFlagValue {
  if (values["no-enable-workflow"] === true) return false;
  if (values["enable-workflow"] === true) return true;
  return undefined;
}

/**
 * 这两个开关只作用于 headless 的 `-p` 与 `--target`。
 *
 * 判据与官方的 scope 校验同一形状（位置参数为空 + 有 prompt 或 target）；超出范围时报错而不是
 * 静默忽略 —— 静默忽略会让「我在 TUI 里传了 --no-enable-workflow」变成一个看不出来的空操作。
 */
export function isHeadlessWorkflowFlagSupportedInvocation(input: {
  positionals: readonly string[];
  prompt?: string;
  targetRequest?: unknown;
}): boolean {
  return (
    input.positionals.length === 0 &&
    (typeof input.prompt === "string" || input.targetRequest !== undefined)
  );
}

/** 本次 headless 运行生效的动态工作流开关。 */
export function headlessWorkflowEnabled(flag: HeadlessWorkflowFlagValue): boolean {
  return flag ?? HEADLESS_WORKFLOW_DEFAULT_ENABLED;
}

/** GlobalOptions 上的显式取值 → 落进 runtimeConfig 的那一步（唯一消费者是 prompt-command）。 */
export function headlessWorkflowRuntimeConfig(options: Pick<GlobalOptions, "enableWorkflow">): {
  dynamicWorkflowEnabled?: boolean;
} {
  // 默认态不写这个字段：core 与 create-app 两侧的语义都是「缺席即开启」，写 true 只是把
  // 同一件事写两遍，而且会让那几处注释与实现不符。只有关闭才落成显式的 false。
  return headlessWorkflowEnabled(options.enableWorkflow) ? {} : { dynamicWorkflowEnabled: false };
}
