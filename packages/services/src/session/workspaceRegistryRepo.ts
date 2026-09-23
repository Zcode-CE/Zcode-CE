import type { DatabaseSync } from "node:sqlite";
import {
  resolveWorkspaceRegistryKey,
  type WorkspaceRegistryEntry,
  type WorkspaceRegistrySource,
} from "@zcode/shared";

/**
 * 工作区注册表读写（M1.2）—— 服务端是唯一写者（见 docs/development/workspace-registry.md §2、§9）。
 *
 * 两源合并：
 *  - 任务索引库（本库 tasks 表）：包含**只有归档任务**的 workspace，故不带 archived 过滤；
 *  - 会话库（由调用方以 extraEntries 传入）：覆盖「只有会话、没有任务行」的 workspace。
 * 回填是一次性幂等迁移；桌面端只读，客户端不得补写兜底。
 */

interface WorkspaceRegistryRow {
  workspace_key: string;
  workspace_path: string;
  workspace_identity: string | null;
  first_seen_at: number;
  last_activity_at: number;
  session_count: number;
  sources: string;
}

export interface WorkspaceRegistryRepo {
  list(): WorkspaceRegistryEntry[];
  /** 幂等 upsert：已存在的 key 保留 first_seen_at，取并集来源与最大计数/活动时间。 */
  upsertMany(entries: readonly WorkspaceRegistryEntry[]): void;
}

function parseSources(raw: string): WorkspaceRegistrySource[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as WorkspaceRegistrySource[]) : [];
  } catch {
    return [];
  }
}

export function createWorkspaceRegistryRepo(params: {
  database: DatabaseSync;
}): WorkspaceRegistryRepo {
  const { database } = params;
  return {
    list(): WorkspaceRegistryEntry[] {
      const rows = database
        .prepare(
          "SELECT workspace_key, workspace_path, workspace_identity, first_seen_at, last_activity_at, session_count, sources FROM workspace_registry ORDER BY last_activity_at DESC",
        )
        .all() as unknown as WorkspaceRegistryRow[];
      return rows.map((row) => ({
        workspaceKey: row.workspace_key,
        workspacePath: row.workspace_path,
        ...(row.workspace_identity ? { workspaceIdentity: row.workspace_identity } : {}),
        firstSeenAt: row.first_seen_at,
        lastActivityAt: row.last_activity_at,
        sessionCount: row.session_count,
        sources: parseSources(row.sources),
      }));
    },
    upsertMany(entries: readonly WorkspaceRegistryEntry[]): void {
      const existing = new Map(this.list().map((known) => [known.workspaceKey, known]));
      const upsert = database.prepare(
        "INSERT INTO workspace_registry (workspace_key, workspace_path, workspace_identity, first_seen_at, last_activity_at, session_count, sources) VALUES (?,?,?,?,?,?,?) ON CONFLICT(workspace_key) DO UPDATE SET workspace_path=excluded.workspace_path, workspace_identity=COALESCE(excluded.workspace_identity, workspace_registry.workspace_identity), first_seen_at=MIN(workspace_registry.first_seen_at, excluded.first_seen_at), last_activity_at=MAX(workspace_registry.last_activity_at, excluded.last_activity_at), session_count=MAX(workspace_registry.session_count, excluded.session_count), sources=excluded.sources",
      );
      database.exec("BEGIN IMMEDIATE");
      try {
        for (const incoming of entries) {
          const known = existing.get(incoming.workspaceKey);
          for (const merged of mergeWorkspaceRegistryEntries(
            known ? [known, incoming] : [incoming],
          )) {
            upsert.run(
              merged.workspaceKey,
              merged.workspacePath,
              merged.workspaceIdentity ?? null,
              merged.firstSeenAt,
              merged.lastActivityAt,
              merged.sessionCount,
              JSON.stringify([...merged.sources].sort()),
            );
          }
        }
        database.exec("COMMIT");
      } catch (error) {
        if (database.isTransaction) database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

/** 同 key 合并：first_seen 取最早、活动与计数取最大、来源取并集（纯函数，便于单测）。 */
export function mergeWorkspaceRegistryEntries(
  entries: readonly WorkspaceRegistryEntry[],
): WorkspaceRegistryEntry[] {
  const byKey = new Map<string, WorkspaceRegistryEntry>();
  for (const entry of entries) {
    const key =
      entry.workspaceKey.trim() ||
      resolveWorkspaceRegistryKey({ workspacePath: entry.workspacePath });
    const previous = byKey.get(key);
    if (!previous) {
      byKey.set(key, { ...entry, workspaceKey: key, sources: [...new Set(entry.sources)].sort() });
      continue;
    }
    byKey.set(key, {
      workspaceKey: key,
      workspacePath: previous.workspacePath || entry.workspacePath,
      ...(previous.workspaceIdentity || entry.workspaceIdentity
        ? { workspaceIdentity: previous.workspaceIdentity ?? entry.workspaceIdentity }
        : {}),
      firstSeenAt: Math.min(previous.firstSeenAt, entry.firstSeenAt),
      lastActivityAt: Math.max(previous.lastActivityAt, entry.lastActivityAt),
      sessionCount: Math.max(previous.sessionCount, entry.sessionCount),
      sources: [...new Set([...previous.sources, ...entry.sources])].sort(),
    });
  }
  return [...byKey.values()].sort((left, right) => right.lastActivityAt - left.lastActivityAt);
}

/** 任务索引源：不带 archived 过滤，保证「只有归档任务」的 workspace 也在注册表里。 */
export function enumerateTaskIndexWorkspaceEntries(
  database: DatabaseSync,
): WorkspaceRegistryEntry[] {
  const rows = database
    .prepare(
      "SELECT workspace_key, workspace_path, workspace_identity, MIN(created_at) AS first_seen_at, MAX(updated_at) AS last_activity_at, COUNT(*) AS session_count FROM tasks WHERE deleted = 0 GROUP BY workspace_key",
    )
    .all() as unknown as WorkspaceRegistryRow[];
  return rows.map((row) => ({
    workspaceKey: row.workspace_key,
    workspacePath: row.workspace_path,
    ...(row.workspace_identity ? { workspaceIdentity: row.workspace_identity } : {}),
    firstSeenAt: Number(row.first_seen_at ?? 0),
    lastActivityAt: Number(row.last_activity_at ?? 0),
    sessionCount: Number(row.session_count ?? 0),
    sources: ["task-index"],
  }));
}

/** 一次性幂等回填：索引源 ∪ 会话源（调用方传入）。重复执行不产生重复行。 */
export function backfillWorkspaceRegistry(params: {
  repo: WorkspaceRegistryRepo;
  database: DatabaseSync;
  extraEntries?: readonly WorkspaceRegistryEntry[];
  now: () => number;
}): { written: number; total: number } {
  const timestamp = params.now();
  const entries = mergeWorkspaceRegistryEntries([
    ...enumerateTaskIndexWorkspaceEntries(params.database),
    ...(params.extraEntries ?? []),
  ]).map((entry) => ({
    ...entry,
    firstSeenAt: entry.firstSeenAt > 0 ? entry.firstSeenAt : timestamp,
    lastActivityAt: entry.lastActivityAt > 0 ? entry.lastActivityAt : timestamp,
  }));
  params.repo.upsertMany(entries);
  return { written: entries.length, total: params.repo.list().length };
}
