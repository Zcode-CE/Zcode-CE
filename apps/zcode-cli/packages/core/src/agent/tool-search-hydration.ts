import {
  PersistedToolSearchContentSchema,
  ToolSearchAnnouncementSchema,
  compactBoundaryPayloadSchema,
  type Logger,
} from "@zcode/contracts";
import { compactDiscoveryMetadata } from "../tool/search/history.js";

// 冷恢复只看持久化形状：解析失败说明是旧 session 的普通字符串内容，静默回退，
// 不能把整条 tool result 丢掉，也不能把非法引用块塞进 provider 请求。
export function hydrateToolSearchContent(value: unknown, logger?: Logger) {
  if (value === undefined) return undefined;
  const parsed = PersistedToolSearchContentSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  logger?.warn("Invalid persisted ToolSearch content; using legacy tool result", {
    event: "session.tool_search.invalid_content",
    module: "core.session",
  });
  return undefined;
}

export function hydrateCompactDiscovery(value: unknown) {
  const parsed = compactBoundaryPayloadSchema.safeParse(value);
  return parsed.success ? compactDiscoveryMetadata(parsed.data) : undefined;
}

export function hydrateToolSearchAnnouncement(value: unknown) {
  if (value === undefined) return undefined;
  const parsed = ToolSearchAnnouncementSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
