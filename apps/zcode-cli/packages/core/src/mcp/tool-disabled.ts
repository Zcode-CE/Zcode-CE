import { normalizeMcpDisabledTools } from "@zcode/contracts";
import type { McpServerConfig, McpToolDescriptor } from "@zcode/contracts";

/**
 * MCP 工具级启停（`mcp.servers[<server>].disabledTools`）的唯一判定点。
 *
 * 产品规则、状态所有者与验收场景见 `docs/development/tool-policy.md`。
 *
 * 为什么收在这里、而不是调用点各写一遍：`disabledTools` 的判定必须与
 * `registerMcpTools` 的注册循环**同源**——两个判定点必然漂移成「注册了但以为关了」。
 * 归一化本身只调契约里的 `normalizeMcpDisabledTools`（配置 schema / 插件 MCP / 协议 DTO
 * 共用同一份），本模块只负责「按 server 取清单 + 判定单个 descriptor」。
 */

/**
 * 服务器名 → 该 server 被关闭的原始工具名集合。
 *
 * 入参是 **session 冻结的** `runtimeConfig.mcp.servers`：工具面在会话创建时确定
 * （`registerMcpTools` 每会话只跑一次），所以这里不做任何增量刷新。
 */
export function buildDisabledMcpToolsByServer(
  servers: Record<string, McpServerConfig> | undefined,
): ReadonlyMap<string, ReadonlySet<string>> {
  const byServer = new Map<string, ReadonlySet<string>>();
  for (const [serverName, config] of Object.entries(servers ?? {})) {
    if (config.enabled === false) {
      // 整包已关：它的工具根本不会被列出，再记一份工具级清单只会在日志里制造噪声。
      continue;
    }
    const normalized = normalizeMcpDisabledTools(config.disabledTools);
    if (normalized.disabledTools.length === 0) continue;
    byServer.set(serverName, new Set(normalized.disabledTools));
  }
  return byServer;
}

/**
 * 该 descriptor 是否被工具级启停关掉。
 *
 * 匹配的是 **MCP server 自己 `tools/list` 返回的原始工具名**（`descriptor.toolName`），
 * 不是模型可见名（`descriptor.name`，形如 `mcp__<server>__<tool>`）：原始名在 server 内唯一，
 * 模型可见名会随 server 名变化（含插件命名空间），拿它当持久化键会在改名后静默失效。
 *
 * `descriptor.serverName` 与配置里的 server key 是同一个值（含插件的
 * `plugin:<plugin>:<server>` 命名空间），所以不需要额外的名称映射层。
 */
export function isMcpToolDisabled(
  descriptor: Pick<McpToolDescriptor, "serverName" | "toolName">,
  disabledByServer: ReadonlyMap<string, ReadonlySet<string>> | undefined,
): boolean {
  return disabledByServer?.get(descriptor.serverName)?.has(descriptor.toolName) === true;
}
