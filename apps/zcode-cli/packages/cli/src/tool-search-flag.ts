import { ToolSearchModeSchema, type ToolSearchMode } from "@zcode/contracts";

/**
 * `--toolsearch-mode` 的取值解析与作用域校验（上游 3.16.2 F14）。
 *
 * 四态语义在 core 侧解析（tool/search/exposure.ts 的 resolveToolSearchMode）：
 * - off：默认值，行为与没有本功能时完全一致；
 * - auto：provider 声明 defaultEnabled 时用 native，否则按工具调用能力退回 local/off；
 * - native：provider 侧延迟加载，需要 Anthropic Messages 协议；
 * - local：客户端目录搜索 + DeferredToolCall 包装执行，需要 provider 支持工具调用。
 *
 * 非法值必须报错而不是退回 off：脚本传错拼写时，静默关闭会让它以为功能已经生效。
 */

export const TOOL_SEARCH_MODE_FLAG = "--toolsearch-mode";
export const TOOL_SEARCH_MODE_DEFAULT: ToolSearchMode = "off";
export const TOOL_SEARCH_MODE_INVALID_ERROR =
  "--toolsearch-mode must be one of auto, native, local, off.";
export const TOOL_SEARCH_SCOPE_ERROR =
  "--toolsearch-mode can only be used with --prompt, --target, or tui.";

/** 解析命令行取值；缺席即默认值 off，非法值抛出带完整提示的错误。 */
export function parseToolSearchModeFlag(value: unknown): ToolSearchMode {
  if (value === undefined) return TOOL_SEARCH_MODE_DEFAULT;
  const parsed = ToolSearchModeSchema.safeParse(value);
  if (!parsed.success) throw new Error(TOOL_SEARCH_MODE_INVALID_ERROR);
  return parsed.data;
}

/**
 * 落进 runtimeConfig 的那一步（消费者是 prompt-command 与 TUI prompt handler）。
 *
 * 即使取值是 off 也显式下发：core 侧「缺席」与「off」等价，显式写出只是让下游读到一个
 * 确定值，不必再区分「flag 没传」与「flag 传了 off」。
 */
export function toolSearchRuntimeConfig(mode: ToolSearchMode): {
  toolSearch: { mode: ToolSearchMode };
} {
  return { toolSearch: { mode } };
}
