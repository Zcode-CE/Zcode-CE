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
 *  - 任务索引库（本库 tasks 表）：包含只有归档任务的 workspace，故不带 archived 过滤；
 *  - 会话库（由调用方以 extraEntries 传入）：覆盖「只有会话、没有任务行」的 workspace。
 * 回填是一次性幂等迁移；桌面端只读，客户端不得补写兜底。
 *
 * 会话数有两个口径，缺一不可：
 *  - sessionCount（全部，不过滤 archived）：保证「只有归档任务」的 workspace 也在册；
 *  - activeSessionCount（未归档）：与侧栏会话列表同一口径，供「未启动」时如实报数。
 * 只报前者会造成「说已有 N 个会话、点开是空的」（缺陷见 0005 迁移注释）。
 */

interface WorkspaceRegistryRow {
  workspace_key: string;
  workspace_path: string;
  workspace_identity: string | null;
  first_seen_at: number;
  last_activity_at: number;
  session_count: number;
  /** 0005 新增列；老库刚升级时为 0（由随后的枚举 upsert 覆盖）。 */
  active_session_count?: number;
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
          "SELECT workspace_key, workspace_path, workspace_identity, first_seen_at, last_activity_at, session_count, active_session_count, sources FROM workspace_registry ORDER BY last_activity_at DESC",
        )
        .all() as unknown as WorkspaceRegistryRow[];
      return rows.map((row) => ({
        workspaceKey: row.workspace_key,
        workspacePath: row.workspace_path,
        ...(row.workspace_identity ? { workspaceIdentity: row.workspace_identity } : {}),
        firstSeenAt: row.first_seen_at,
        lastActivityAt: row.last_activity_at,
        sessionCount: row.session_count,
        // 老库刚跑完 0005 时该列为默认值 0，这里不做兜底替换成 sessionCount ——
        // 那会把「尚未计算」伪装成「全部会话都未归档」，正是本任务要修的错位。
        activeSessionCount: Number(row.active_session_count ?? 0),
        sources: parseSources(row.sources),
      }));
    },
    /**
     * 冲突时两个计数的合并规则故意不同：
     *  - session_count 沿用既有的 MAX（只增不减，保持本能力发布以来的语义不变）；
     *  - active_session_count 取 excluded（后写覆盖）。理由是它要如实回答「点开能看到几条」：
     *    归档一个会话后该值必须下降，若也取 MAX，旧的高值会永久冻住 —— 那正是本任务要修的
     *    「说已有 N 个会话、点开是空的」，只是换成了更窄的形态。两个调用方
     *    （taskIndexRepo.listWorkspaceRegistryEntries 与 backfillWorkspaceRegistry）传入的都是
     *    当次的完整枚举，因此覆盖即当前真相；同一批次内多来源仍由 merge 取最大值。
     */
    upsertMany(entries: readonly WorkspaceRegistryEntry[]): void {
      const existing = new Map(this.list().map((known) => [known.workspaceKey, known]));
      const upsert = database.prepare(
        "INSERT INTO workspace_registry (workspace_key, workspace_path, workspace_identity, first_seen_at, last_activity_at, session_count, active_session_count, sources) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(workspace_key) DO UPDATE SET workspace_path=excluded.workspace_path, workspace_identity=COALESCE(excluded.workspace_identity, workspace_registry.workspace_identity), first_seen_at=MIN(workspace_registry.first_seen_at, excluded.first_seen_at), last_activity_at=MAX(workspace_registry.last_activity_at, excluded.last_activity_at), session_count=MAX(workspace_registry.session_count, excluded.session_count), active_session_count=excluded.active_session_count, sources=excluded.sources",
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
              merged.activeSessionCount,
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

/**
 * 未归档计数的同 key 合并规则：以知道归档状态的来源为准。
 *
 * 为什么不能像 sessionCount 那样取 MAX：该字段的用途是如实回答「点开能看到几条」，
 * 归档一个会话后它必须下降；取 MAX 会把旧的高值永久冻住，等于把本任务要修的错位
 * 换成更窄的形态（服务端确实会重新枚举，但写回时又被 MAX 挡掉 —— 已由测试复现）。
 *
 * 谁知道归档状态：只有任务索引源（sources 含 "task-index"）。会话源（extraEntries）
 * 只带会话、没有归档标记，因此它给出的值不作数。
 * 两侧同类（都知情或都不知情）时以本次传入的 entry 为准 —— upsertMany 把「库里已有的行」
 * 放在 incoming 之前，于是本次枚举的新值覆盖旧值，正是归档后数字要下降的要求。
 */
function mergeActiveSessionCount(
  previous: WorkspaceRegistryEntry,
  entry: WorkspaceRegistryEntry,
): number {
  const previousKnows = previous.sources.includes("task-index");
  const entryKnows = entry.sources.includes("task-index");
  if (previousKnows !== entryKnows) {
    return entryKnows ? entry.activeSessionCount : previous.activeSessionCount;
  }
  return entry.activeSessionCount;
}

/**
 * 同 key 合并：first_seen 取最早、session_count 取最大、来源取并集（纯函数，便于单测）。
 *
 * activeSessionCount 的规则与 sessionCount 不同，见 mergeActiveSessionCount：
 * sessionCount 只增不减是历史语义（保持本能力发布以来的行为），而 activeSessionCount
 * 必须能下降 —— 归档一个会话后数字不变，就还是「说已有 N 个会话、点开是空的」。
 */
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
      activeSessionCount: mergeActiveSessionCount(previous, entry),
      sources: [...new Set([...previous.sources, ...entry.sources])].sort(),
    });
  }
  return [...byKey.values()].sort((left, right) => right.lastActivityAt - left.lastActivityAt);
}

/**
 * 任务索引源：不带 archived 过滤，保证「只有归档任务」的 workspace 也在注册表里。
 *
 * 同一次扫描顺带算出未归档计数（active_session_count），两条计数来自同一份行集合 ——
 * 分两次查询会在两次查询之间出现归档状态变化，让 active 与 all 来自不同快照。
 *
 * 口径与侧栏一致：侧栏会话列表走 matchesTaskListMembershipKind 的 "active"
 * （!archived，置顶与否都算），因此这里也按 archived = 0 计数，不排除 pinned。
 */
export function enumerateTaskIndexWorkspaceEntries(
  database: DatabaseSync,
): WorkspaceRegistryEntry[] {
  const rows = database
    .prepare(
      "SELECT workspace_key, workspace_path, workspace_identity, MIN(created_at) AS first_seen_at, MAX(updated_at) AS last_activity_at, COUNT(*) AS session_count, SUM(CASE WHEN archived = 0 THEN 1 ELSE 0 END) AS active_session_count FROM tasks WHERE deleted = 0 GROUP BY workspace_key",
    )
    .all() as unknown as WorkspaceRegistryRow[];
  return rows.map((row) => ({
    workspaceKey: row.workspace_key,
    workspacePath: row.workspace_path,
    ...(row.workspace_identity ? { workspaceIdentity: row.workspace_identity } : {}),
    firstSeenAt: Number(row.first_seen_at ?? 0),
    lastActivityAt: Number(row.last_activity_at ?? 0),
    sessionCount: Number(row.session_count ?? 0),
    activeSessionCount: Number(row.active_session_count ?? 0),
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
