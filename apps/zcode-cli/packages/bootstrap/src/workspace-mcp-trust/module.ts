/**
 * workspace-mcp-trust 模块清单（architecture-governance managed 模块）。
 * 位置：bootstrap。对外的唯一入口是 index.ts 的 createWorkspaceMcpTrust 与 contract.ts 的契约类型；
 * adapters / core 都不直接依赖本模块（gate 只在 bootstrap 装配层包住 MCP lease）。
 */
export const workspaceMcpTrustModule = {
  id: "workspace-mcp-trust",
  requires: ["zcode-cli", "shared"],
  provides: ["workspace-mcp-trust"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
