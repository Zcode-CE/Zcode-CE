// ============================================================
// Tool Search - provider 能力推导与 beta 头注入（upstream 3.16.2 F14）
// ============================================================

import { TOOL_SEARCH_BETA, type ToolSearchCapability } from "@zcode/contracts";

/**
 * 按 api 类型与访问方式推导 provider 侧的延迟加载能力。
 *
 * - protocolSupported：只有 Anthropic Messages 协议认 tool_reference/deferLoading；
 *   其他协议即使被请求 native 也必须明确失败，不能悄悄退化成「工具没生效」。
 * - defaultEnabled：auto 模式是否默认走 native。当前只有智谱 Coding Plan 账号
 *   （API key 形态或 individual/team coding plan）默认开启。
 */
export function resolveToolSearchCapability(
  apiType: string,
  access: { type: string; mode?: string },
): ToolSearchCapability {
  const protocolSupported = apiType === "anthropic-messages";
  const codingPlan =
    access.type === "zhipu-coding-plan-api-key" ||
    (access.type === "zhipu-account" &&
      (access.mode === "individual-coding-plan" || access.mode === "team-coding-plan"));
  return Object.freeze({ protocolSupported, defaultEnabled: protocolSupported && codingPlan });
}

/**
 * 只在 enabled 时给请求加 beta 头：关闭态必须与没有本功能时逐字节一致，
 * 否则「关掉工具搜索」会改变缓存前缀与供应商侧的准入结果。
 */
export function toolSearchHeaders(headers: Record<string, string> | undefined, enabled?: boolean) {
  if (!enabled) return headers;
  const result = { ...headers };
  const key =
    Object.keys(result).find((name) => name.toLowerCase() === "anthropic-beta") ?? "anthropic-beta";
  result[key] = [
    ...new Set([
      ...(result[key]
        ?.split(",")
        .map((value) => value.trim())
        .filter(Boolean) ?? []),
      TOOL_SEARCH_BETA,
    ]),
  ].join(",");
  return result;
}
