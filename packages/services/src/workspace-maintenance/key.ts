import type { WorkspaceRef } from "./contract.js";

/** 全仓统一身份口径：workspaceIdentity 优先，回退 workspacePath。 */
export function resolveWorkspaceMaintenanceKey(ref: WorkspaceRef): string {
  return ref.workspaceIdentity?.trim() || ref.workspacePath;
}
