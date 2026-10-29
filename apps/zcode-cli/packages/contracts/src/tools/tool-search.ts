// ============================================================
// ToolSearch contract - deferred tool discovery (upstream 3.16.2 F14)
// ============================================================

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import type { JsonSchema } from "../model/index.js";

/** 控制入口名。工具目录过滤、DeferredToolCall 的拒绝分支与提示文案都按它判定。 */
export const TOOL_SEARCH_NAME = "ToolSearch";

/**
 * 用户可请求的四种形态；解析后的形态（ResolvedToolSearchMode）不含 auto。
 * - off：完全关闭，行为与没有本功能一致；
 * - native：provider 侧延迟加载（当前只有 Anthropic Messages 协议声明支持）；
 * - local：客户端目录搜索 + DeferredToolCall 包装执行；
 * - auto：provider 声明 defaultEnabled 时走 native，否则按工具调用能力退回 local/off。
 */
export const ToolSearchModeSchema = z.enum(["auto", "native", "local", "off"]);
export type ToolSearchMode = z.infer<typeof ToolSearchModeSchema>;
export type ResolvedToolSearchMode = Exclude<ToolSearchMode, "auto">;
export const TOOL_SEARCH_DEFAULT_RESULTS = 5;

/** provider 侧延迟加载的 beta 头取值；只在 native 模式注入。 */
export const TOOL_SEARCH_BETA = "advanced-tool-use-2025-11-20";

/**
 * 每轮只公告目录变化量：模型可见文案由它重建，避免把整份 deferred 名单反复刷进历史。
 * readdedNames 必须同时出现在 addedNames（压缩后重新出现在上下文里的工具）。
 */
export const ToolSearchAnnouncementSchema = z
  .object({
    addedNames: z.array(z.string().min(1)),
    removedNames: z.array(z.string().min(1)),
    readdedNames: z.array(z.string().min(1)),
  })
  .strict()
  .refine((delta) => delta.readdedNames.every((name) => delta.addedNames.includes(name)), {
    message: "Readded tool names must be included in addedNames",
  });

/**
 * 工具结果里的引用块：native 交给 provider 展开，local 由 core 投影成 <functions> 文本。
 * 它不是普通文本，持久化与历史恢复必须按同一 schema 校验。
 */
export const ToolReferenceContentSchema = z
  .object({
    type: z.literal("tool_reference"),
    toolName: z.string().min(1),
  })
  .strict();
export type ModelToolReferenceContentBlock = z.infer<typeof ToolReferenceContentSchema>;

export const PersistedToolSearchContentSchema = z
  .array(
    z.union([
      z.object({ type: z.literal("text"), text: z.string() }).strict(),
      ToolReferenceContentSchema,
    ]),
  )
  .min(1);

export const ToolSearchInputSchema = z.object({
  query: z
    .string()
    .describe(
      'Query to find deferred tools. Use "select:<tool_name>" for direct selection, or keywords to search.',
    ),
  max_results: z
    .number()
    .optional()
    .default(TOOL_SEARCH_DEFAULT_RESULTS)
    .describe("Maximum number of results to return (default: 5)"),
});
export const ToolSearchOutputSchema = z.object({
  matches: z.array(z.string()),
  query: z.string(),
  total_deferred_tools: z.number(),
});

export const ToolSearchInputJsonSchema = {
  ...toToolJsonSchema(ToolSearchInputSchema),
  // 转换器会把带默认值的字段视为可选；模型侧要求显式传入，执行侧仍先补默认值。
  required: ["query", "max_results"],
} satisfies JsonSchema;
export const ToolSearchOutputJsonSchema = toToolJsonSchema(ToolSearchOutputSchema);

/** provider 对延迟加载的声明；由 adapters 按 api 类型与访问方式推导，core 只读。 */
export interface ToolSearchCapability {
  readonly protocolSupported: boolean;
  readonly defaultEnabled: boolean;
}

/** 当前请求的完整工具目录项。deferred 决定它是否从模型可见工具列表里摘掉。 */
export interface ToolSearchCandidate {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly mcp?: { readonly serverName: string; readonly toolName: string };
  readonly description?: string;
  readonly searchHint?: string;
  readonly deferred: boolean;
}

/** 一次请求内生效的搜索上下文：模式、目录与已交付集合（历史投影的结果）。 */
export interface ToolSearchExecutionContext {
  readonly mode: ResolvedToolSearchMode;
  readonly enabled: boolean;
  readonly catalog: readonly ToolSearchCandidate[];
  readonly discovered: ReadonlySet<string>;
}
