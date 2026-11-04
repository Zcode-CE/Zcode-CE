import type { WorkspaceMcpTrustDecision, ZCodeMcpServer } from "@zcode/shared";

/**
 * 把「设置页的一次信任点击」翻成协议决定（`workspace/mcp/trust` 的服务入参）。
 *
 * 只有工作区声明、且带审核摘要（含 declarationDigest）时才可决定：
 * 摘要必须与审核时的那一份一致，Agent 侧据此拒绝「审核后被改过」的声明。
 * 返回 null 表示没有可提交的决定（用户级配置 / 没有摘要 / 没有工作区路径）。
 */
export function buildWorkspaceMcpTrustDecision(
  server: Pick<ZCodeMcpServer, "name" | "scope" | "workspaceTrust">,
  target: { workspacePath?: string | null; workspaceIdentity?: string | null },
): WorkspaceMcpTrustDecision | null {
  const review = server.workspaceTrust;
  if (server.scope !== "workspace" || !review || !target.workspacePath) return null;
  return {
    workspacePath: target.workspacePath,
    ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
    serverName: server.name,
    declarationDigest: review.declarationDigest,
    trusted: !review.trusted,
  };
}
