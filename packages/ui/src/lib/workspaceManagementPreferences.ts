import type { BrowserStorageLike } from "@/lib/browserEnvironment.js";
import { getSafeLocalStorage } from "@/lib/browserEnvironment.js";

/**
 * 设置页「工作区」分区的排序偏好（仅本机展示，不改身份/路径）。
 *
 * 为什么不写 AppSettings：AppSettings 是跨进程协议面（含服务端写入白名单），
 * 加一个键要同时改 shared 的 schema 与 services 的写入路径；排序只是本机展示偏好，
 * 与侧栏 organizeBy 同一档，落在本地偏好里即可。
 */
export type WorkspaceManagementSortBy = "lastActivity" | "name" | "sessions";

const WORKSPACE_MANAGEMENT_PREFERENCES_STORAGE_KEY = "zcode-workspace-management-preferences";
const DEFAULT_SORT_BY: WorkspaceManagementSortBy = "lastActivity";

function isSortBy(value: unknown): value is WorkspaceManagementSortBy {
  return value === "lastActivity" || value === "name" || value === "sessions";
}

export function readWorkspaceManagementSortBy(
  storage: BrowserStorageLike | null = getSafeLocalStorage(),
): WorkspaceManagementSortBy {
  let rawValue: string | null = null;
  try {
    rawValue = storage?.getItem(WORKSPACE_MANAGEMENT_PREFERENCES_STORAGE_KEY) ?? null;
  } catch {
    rawValue = null;
  }
  if (!rawValue) return DEFAULT_SORT_BY;
  try {
    const parsed = JSON.parse(rawValue) as { sortBy?: unknown };
    return isSortBy(parsed.sortBy) ? parsed.sortBy : DEFAULT_SORT_BY;
  } catch {
    return DEFAULT_SORT_BY;
  }
}

export function persistWorkspaceManagementSortBy(
  sortBy: WorkspaceManagementSortBy,
  storage: BrowserStorageLike | null = getSafeLocalStorage(),
): void {
  try {
    storage?.setItem(WORKSPACE_MANAGEMENT_PREFERENCES_STORAGE_KEY, JSON.stringify({ sortBy }));
  } catch {
    // 受限浏览器或 SSR 里 storage 不可写，偏好写入失败不能阻断页面。
  }
}

/** 排序用的字段投影：展示名覆盖优先，空名回落到路径。 */
export interface WorkspaceManagementSortFields {
  key: string;
  label: string;
  lastActivityAt: number;
  sessionCount: number;
}

/** 排序是纯函数：条目 + 展示名覆盖 → 稳定顺序（并列时按展示名、再按 key 兜底）。 */
export function sortWorkspaceRegistryEntries<T>(
  entries: readonly T[],
  sortBy: WorkspaceManagementSortBy,
  fieldsOf: (entry: T) => WorkspaceManagementSortFields,
): T[] {
  const labelOf = (entry: T) => fieldsOf(entry).label.trim() || fieldsOf(entry).key;
  return [...entries].sort((left, right) => {
    const a = fieldsOf(left);
    const b = fieldsOf(right);
    const byLabel = () => labelOf(left).localeCompare(labelOf(right)) || a.key.localeCompare(b.key);
    if (sortBy === "sessions") {
      return b.sessionCount - a.sessionCount || b.lastActivityAt - a.lastActivityAt || byLabel();
    }
    if (sortBy === "name") {
      return byLabel();
    }
    return b.lastActivityAt - a.lastActivityAt || byLabel();
  });
}
