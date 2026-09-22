import {
  traceContextToLogContext,
  type PermissionOptionsPolicy,
  type ToolResultDisplayPayload,
  type TraceContext,
} from "@zcode/contracts";
import type { ExecutableToolCall, ToolEntry, ToolPermissionRulePolicy } from "../types.js";
import type { ToolExecutorDeps } from "./types.js";

interface ResolvedToolApproval {
  gate: "ask" | "proceed";
  display?: ToolResultDisplayPayload;
  optionsPolicy?: PermissionOptionsPolicy;
}

/**
 * 在权限服务已判定 ask 之后调用工具自报的 `prepareApproval`，并把它的答复与工具声明的
 * 选项策略折叠成"这次 ask 该携带什么"。
 *
 * 方向是单向收窄：钩子只能把 ask 放行成 proceed 或给它补上预览，永远不能把 allow 变成 ask。
 * 没有声明钩子的工具一律照旧弹窗。
 */
function resolveOptionsPolicy(
  allowAlways: false | "session" | undefined,
): PermissionOptionsPolicy | undefined {
  switch (allowAlways) {
    case false:
      return "no-always-allow";
    case "session":
      return "session-always-allow";
    default:
      return undefined;
  }
}

/**
 * 把工具的静态声明与**运行时**策略合并成这次 ask 的选项策略。
 *
 * 方向是单向收窄（与 approval-gate 的整体纪律一致）：运行时策略只能**更严**。
 * 具体地，只有 `no-always-allow` 允许在运行时引入；`session-always-allow` 不是运行时能力
 * —— 它是 entry 的静态声明，工具不得按输入内容把授权面变宽。
 */
function mergeOptionsPolicy(
  declared: PermissionOptionsPolicy | undefined,
  runtime: PermissionOptionsPolicy | undefined,
): PermissionOptionsPolicy | undefined {
  if (runtime === "no-always-allow") return "no-always-allow";
  return declared;
}

export function resolveToolApproval(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  entry: ToolEntry,
  executionInput: unknown,
  traceContext: TraceContext,
  rulePolicy?: ToolPermissionRulePolicy,
): ResolvedToolApproval {
  // `permission` 类型上是必填，但 executor 也会被只声明了一部分字段的 entry 驱动
  // （测试桩、动态注册的工具）。周边代码靠 spread 而不是读字段来容忍这一点，gate 同理。
  const optionsPolicy = mergeOptionsPolicy(
    resolveOptionsPolicy(entry.permission?.askOptions?.allowAlways),
    rulePolicy?.optionsPolicy,
  );

  if (!entry.prepareApproval) {
    return { gate: "ask", ...(optionsPolicy ? { optionsPolicy } : {}) };
  }

  try {
    // 工作目录与 handler 拿到的是同一个来源（deps 的 getWorkingDirectory 在 impl.ts 里已把
    // 静态 workingDirectory 兜进去），否则预览会去看一个目录、执行会去写另一个。
    const gate = entry.prepareApproval(executionInput);
    if (gate.gate === "proceed") return { gate: "proceed" };
    return {
      gate: "ask",
      ...(gate.display ? { display: gate.display } : {}),
      ...(optionsPolicy ? { optionsPolicy } : {}),
    };
  } catch (error) {
    // Bug 预防：负责生成预览的钩子绝不能决定"用户是否被询问"。向执行侧 fail-open 等于
    // 静默运行了一个未获批准的工具，所以这里 ask 照旧成立，只让预览降级。
    deps.logger?.warn("Tool approval preview failed; asking without a preview", {
      ...traceContextToLogContext(traceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "tool.permission.approval_preview_failed",
      module: "core.tool.executor",
      status: "failed",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    });
    return { gate: "ask", ...(optionsPolicy ? { optionsPolicy } : {}) };
  }
}
