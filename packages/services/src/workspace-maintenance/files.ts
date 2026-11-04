import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { getAppConfigDir, getWorkspaceHash } from "#src/paths.js";
import type { WorkspaceMaintenanceFilesPort } from "./ports.js";

async function countFiles(directory: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    // 目录不存在 = 该项已删净（幂等重试的正常路径）。
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    total += entry.isDirectory() ? await countFiles(join(directory, entry.name)) : 1;
  }
  return total;
}

/**
 * 按 workspaceHash 组织的数据目录：旧版任务快照 `v2/sessions/<hash>` 与检查点 `v2/checkpoints/<hash>`。
 *
 * 两者都按 workspaceKey 的 SHA-256 前 12 位分目录（见 paths.getWorkspaceHash），因此能精确命中。
 * 只删这两个子树；`.zcode/`、`.agents/` 与工作区目录本身一律不动（spec §1）。
 */
export function createFilesMaintenancePort(params?: {
  configDir?: string;
}): WorkspaceMaintenanceFilesPort {
  const configDir = params?.configDir ?? getAppConfigDir();
  const dirs = (workspacePath: string, workspaceIdentity: string) => {
    const hash = getWorkspaceHash(workspacePath, workspaceIdentity || undefined);
    return {
      legacySnapshots: join(configDir, "sessions", hash),
      checkpoints: join(configDir, "checkpoints", hash),
    };
  };
  return {
    async measure(ref) {
      const targets = dirs(ref.workspacePath, ref.workspaceIdentity);
      return {
        legacySnapshots: await countFiles(targets.legacySnapshots),
        checkpoints: await countFiles(targets.checkpoints),
      };
    },
    async purge(ref) {
      const targets = dirs(ref.workspacePath, ref.workspaceIdentity);
      const measured = {
        legacySnapshots: await countFiles(targets.legacySnapshots),
        checkpoints: await countFiles(targets.checkpoints),
      };
      await rm(targets.legacySnapshots, { recursive: true, force: true });
      await rm(targets.checkpoints, { recursive: true, force: true });
      return measured;
    },
  };
}
