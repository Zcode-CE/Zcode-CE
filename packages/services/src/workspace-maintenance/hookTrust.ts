import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION,
  parseWorkspaceHookTrustStoreContent,
} from "@zcode/shared/workspace-hook-trust-store-file";
import type { WorkspaceMaintenanceTrustPort } from "./ports.js";

/**
 * 工作区 Hook 信任记录（`<storageRoot>/security/workspace-hook-trust-v1.json`，按 workspaceIdentity 记录）。
 *
 * 只按 workspaceIdentity 精确匹配：记录里没有 workspacePath，本地工作区若以路径当 identity 写入，
 * 键值一致也会命中；不猜、不做前缀匹配。文件不存在或结构非法时不改写（宁可不删也不误删）。
 */
export function createHookTrustMaintenancePort(params: {
  storageRoot: string;
}): WorkspaceMaintenanceTrustPort {
  const filePath = join(params.storageRoot, "security", "workspace-hook-trust-v1.json");
  const readFileContent = async () => {
    try {
      const parsed = parseWorkspaceHookTrustStoreContent(await readFile(filePath, "utf8"));
      return parsed.status === "ok" ? parsed.file.records : null;
    } catch {
      // 文件不存在 / 不可读：视为无记录，且绝不写回一个空文件。
      return null;
    }
  };
  return {
    async measure(workspaceIdentity) {
      const records = await readFileContent();
      if (!records) return 0;
      return records.filter((record) => record.workspaceIdentity === workspaceIdentity).length;
    },
    async purge(workspaceIdentity) {
      const records = await readFileContent();
      if (!records) return 0;
      const kept = records.filter((record) => record.workspaceIdentity !== workspaceIdentity);
      const removed = records.length - kept.length;
      if (removed === 0) return 0;
      await writeFile(
        filePath,
        `${JSON.stringify({ schemaVersion: WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION, records: kept }, null, 2)}\n`,
        "utf8",
      );
      return removed;
    },
  };
}
