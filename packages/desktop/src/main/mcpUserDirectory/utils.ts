/**
 * MCP 用户目录模块 - 通用工具函数
 */

import type { McpServerConfig } from "@zcode/shared";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeServerMap(value: unknown): Record<string, McpServerConfig> {
  if (!isRecord(value)) {
    return {};
  }

  const next: Record<string, McpServerConfig> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isRecord(item)) {
      next[key] = item as McpServerConfig;
    }
  }
  return next;
}
