import type { AppSettings } from "@zcode/shared";
import {
  buildWorkspaceAdditionalDirectoriesPatch,
  buildWorkspaceDisplayNamePatch,
} from "@zcode/shared";
import type { WorkspaceMaintenanceSettingsPort } from "./ports.js";

/** AppSettings 里以 workspaceKey 为键的字段（枚举自 shared/protocol.ts，新增字段需在此登记）。 */
const WORKSPACE_KEYED_SETTINGS = [
  "workspaceDisplayNames",
  "workspaceAdditionalDirectories",
  "lastActiveTaskByWorkspace",
] as const;

function countWorkspaceEntries(settings: AppSettings, workspaceKey: string): number {
  let total = 0;
  for (const field of WORKSPACE_KEYED_SETTINGS) {
    const value = settings[field];
    if (value && typeof value === "object" && Object.hasOwn(value, workspaceKey)) total += 1;
  }
  return total;
}

/**
 * AppSettings 的 workspace 级配置清理（展示名 / 附加目录 / 上次活动任务）。
 *
 * 走设置服务的既有 update 通道（服务端按键合并），不直接写 setting.json：并发写入与
 * 原子替换由服务层负责，这里只提交「删这个键」的补丁（空串 / 空列表语义）。
 */
export function createSettingsMaintenancePort(params: {
  read: () => Promise<AppSettings>;
  update: (patch: AppSettings) => Promise<unknown>;
}): WorkspaceMaintenanceSettingsPort {
  return {
    async measure(workspaceKey) {
      return countWorkspaceEntries(await params.read(), workspaceKey);
    },
    async purge(workspaceKey) {
      const settings = await params.read();
      const before = countWorkspaceEntries(settings, workspaceKey);
      if (before === 0) return 0;
      await params.update({
        ...(settings.workspaceDisplayNames &&
        Object.hasOwn(settings.workspaceDisplayNames, workspaceKey)
          ? { workspaceDisplayNames: buildWorkspaceDisplayNamePatch(workspaceKey, "") }
          : {}),
        ...(settings.workspaceAdditionalDirectories &&
        Object.hasOwn(settings.workspaceAdditionalDirectories, workspaceKey)
          ? {
              workspaceAdditionalDirectories: buildWorkspaceAdditionalDirectoriesPatch(
                workspaceKey,
                [],
              ),
            }
          : {}),
        ...(settings.lastActiveTaskByWorkspace &&
        Object.hasOwn(settings.lastActiveTaskByWorkspace, workspaceKey)
          ? { lastActiveTaskByWorkspace: { [workspaceKey]: "" } }
          : {}),
      } as AppSettings);
      return before;
    },
  };
}
