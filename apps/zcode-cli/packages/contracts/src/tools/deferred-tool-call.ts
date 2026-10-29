// ============================================================
// DeferredToolCall contract - local 模式的包装执行入口（upstream 3.16.2 F14）
// ============================================================

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import type { JsonSchema } from "../model/index.js";

export const DEFERRED_TOOL_CALL_NAME = "DeferredToolCall";

/**
 * 目标工具名与参数原样携带：调度前由 resolveDeferredToolCall 解包成真实的 name/input，
 * 执行链只有这一处认包装身份，权限与结果归属都按目标工具判定。
 */
export const DeferredToolCallInputSchema = z
  .object({
    name: z.string().min(1),
    input: z.record(z.unknown()),
  })
  .strict();
export const DeferredToolCallInputJsonSchema = toToolJsonSchema(
  DeferredToolCallInputSchema,
) as JsonSchema;

// 原始目标名称与参数由调用本身保存；仅记录还原模型协议所需的包装标记。
export const ModelCallWrapperSchema = z.literal(DEFERRED_TOOL_CALL_NAME);
export type ModelCallWrapper = z.infer<typeof ModelCallWrapperSchema>;
