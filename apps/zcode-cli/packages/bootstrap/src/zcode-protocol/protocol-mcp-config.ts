import { normalizeMcpDisabledTools } from "@zcode/contracts";
import type { McpServerConfig } from "@zcode/contracts";
import type { ZCodeProtocolMcpServer } from "@zcode/shared";

export function protocolMcpServersToRuntimeMcpConfig(
  servers: ZCodeProtocolMcpServer[] | undefined,
): { enabled: true; servers: Record<string, McpServerConfig> } | undefined {
  if (!servers || servers.length === 0) {
    return undefined;
  }

  const runtimeServers: Record<string, McpServerConfig> = {};
  for (const server of servers) {
    if ("command" in server) {
      runtimeServers[server.name] = {
        type: "stdio",
        command: server.command,
        args: server.args,
        env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])),
        // ZCode Protocol 的 mcpServers 是 session/runtime 和状态查询的完整覆盖配置。
        // 这里如果不还原 timeoutMs，UI 保存的超时会在真实工具初始化或 mcp/list 探测前丢失。
        ...(server.timeoutMs !== undefined ? { timeoutMs: server.timeoutMs } : {}),
        // 工具级启停同理：这是唯一会让「UI 关掉的工具」真正生效的那条路，
        // 漏还原它等于 UI 上关了、模型照旧能调。归一化复用契约里唯一一份实现。
        ...toDisabledToolsPatch(server.disabledTools),
        ...(server.isolation !== undefined ? { isolation: server.isolation } : {}),
        ...(server.protocolVersion !== undefined
          ? { protocolVersion: server.protocolVersion }
          : {}),
      };
      continue;
    }
    runtimeServers[server.name] = {
      type: server.type,
      url: server.url,
      headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])),
      ...(server.oauth !== undefined ? { oauth: server.oauth } : {}),
      // HTTP/SSE MCP 也复用同一条 protocol 覆盖链路，需和 stdio 一样保留超时。
      ...(server.timeoutMs !== undefined ? { timeoutMs: server.timeoutMs } : {}),
      ...toDisabledToolsPatch(server.disabledTools),
      ...(server.isolation !== undefined ? { isolation: server.isolation } : {}),
      ...(server.protocolVersion !== undefined ? { protocolVersion: server.protocolVersion } : {}),
    };
  }

  return { enabled: true, servers: runtimeServers };
}

/** 协议 DTO 的 `disabledTools` → runtime 配置；空数组等于未配置，不落多余字段。 */
function toDisabledToolsPatch(value: unknown): { disabledTools?: string[] } {
  const normalized = normalizeMcpDisabledTools(value);
  return normalized.disabledTools.length > 0 ? { disabledTools: normalized.disabledTools } : {};
}
