import { z } from "zod";

/**
 * 工具搜索模式（F14 / 上游 3.16.2）。
 *
 * 与 CLI contracts 的 `ToolSearchMode` 同词表；放在 shared 是因为它同时出现在两处持久/协议面：
 * AppSettings（用户在设置页选的值）与 runtime preferences（Host 在会话创建/恢复时下发给 CLI）。
 * 两处必须同词表，否则「设置里选的值」到 CLI 会变成不认识的字符串。
 *
 * 缺席语义：老配置/老 Host 不带该字段 ⇒ `off`（与引入本能力前的行为逐字节一致）。
 */
export const appToolSearchModeSchema = z.enum(["auto", "native", "local", "off"]);
export type AppToolSearchMode = z.infer<typeof appToolSearchModeSchema>;

export const DEFAULT_APP_TOOL_SEARCH_MODE: AppToolSearchMode = "off";
