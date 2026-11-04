/**
 * workspace-maintenance 模块清单（architecture-governance managed 模块）。
 * 层：contract（类型/描述符） < ports（外部能力） < service（编排） < 适配器（sqlite / files / settings / hookTrust）。
 */
export const workspaceMaintenanceModule = {
  id: "workspace-maintenance",
  requires: ["shared"],
  provides: ["workspace-maintenance"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
