import assert from "node:assert/strict";
import test from "node:test";
import {
  WORKSPACE_REGISTRY_DEFAULT_VIEW_WINDOW_DAYS,
  resolveWorkspaceRegistryKey,
  selectWorkspaceRegistryDefaultView,
  workspaceRegistryEntrySchema,
  type WorkspaceRegistryEntry,
} from "@zcode/shared";

/**
 * 工作区注册表契约的纯规则护栏（M1.1）。
 *
 * 为什么必须钉住：spec docs/development/workspace-registry.md 把「可见集合」的真相源从
 * 客户端设置搬到服务端注册表，默认视图按 30 天窗口收窄。身份键与窗口口径一旦漂移，
 * 「两个客户端看到不同集合」以及「会话看起来丢了」就会重新出现，且很难在 UI 层发现。
 */

function entry(params: {
  key: string;
  lastActivityAt: number;
  sessionCount?: number;
}): WorkspaceRegistryEntry {
  return {
    workspaceKey: params.key,
    workspacePath: params.key,
    firstSeenAt: 1,
    lastActivityAt: params.lastActivityAt,
    sessionCount: params.sessionCount ?? 1,
    sources: ["task-index"],
  };
}

const DAY = 24 * 60 * 60 * 1000;
const now = 1_800_000_000_000;

test("身份键统一为 identity?.trim() || path", () => {
  assert.equal(resolveWorkspaceRegistryKey({ workspacePath: "/a/b" }), "/a/b");
  assert.equal(
    resolveWorkspaceRegistryKey({ workspacePath: "/a/b", workspaceIdentity: "  ssh://host/a/b  " }),
    "ssh://host/a/b",
  );
  assert.equal(
    resolveWorkspaceRegistryKey({ workspacePath: "/a/b", workspaceIdentity: "   " }),
    "/a/b",
    "空白 identity 必须回落路径，不能生成空 key",
  );
});

test("默认视图 = 30 天窗口 ∪ 置顶，并按最近活动降序", () => {
  assert.equal(WORKSPACE_REGISTRY_DEFAULT_VIEW_WINDOW_DAYS, 30);
  const entries = [
    entry({ key: "/recent", lastActivityAt: now - 2 * DAY }),
    entry({ key: "/stale", lastActivityAt: now - 31 * DAY }),
    entry({ key: "/pinned", lastActivityAt: now - 400 * DAY }),
    entry({ key: "/edge", lastActivityAt: now - 30 * DAY }),
  ];
  const view = selectWorkspaceRegistryDefaultView(entries, { now, pinnedKeys: ["/pinned"] });
  assert.deepEqual(
    view.map((item) => item.workspaceKey),
    ["/recent", "/edge", "/pinned"],
    "窗口内两条 + 置顶一条；31 天前的未置顶条目不得进入默认视图",
  );
  const all = selectWorkspaceRegistryDefaultView(entries, { now });
  assert.equal(all.length, 2, "无置顶时默认视图只应包含窗口内条目（/stale 与 /pinned 都被排除）");
});

test("窗口边界可按需调整，且不修改入参", () => {
  const entries = [entry({ key: "/x", lastActivityAt: now - 5 * DAY })];
  const frozen = JSON.stringify(entries);
  assert.equal(selectWorkspaceRegistryDefaultView(entries, { now, windowDays: 1 }).length, 0);
  assert.equal(selectWorkspaceRegistryDefaultView(entries, { now, windowDays: 7 }).length, 1);
  assert.equal(JSON.stringify(entries), frozen);
});

test("条目 schema 拒绝空 key / 空来源，接受多源合并结果", () => {
  assert.equal(
    workspaceRegistryEntrySchema.safeParse(entry({ key: "/ok", lastActivityAt: now })).success,
    true,
  );
  assert.equal(
    workspaceRegistryEntrySchema.safeParse({
      ...entry({ key: "/ok", lastActivityAt: now }),
      sources: ["task-index", "session-store", "settings-migrated"],
    }).success,
    true,
  );
  assert.equal(
    workspaceRegistryEntrySchema.safeParse({
      ...entry({ key: "/ok", lastActivityAt: now }),
      sources: [],
    }).success,
    false,
  );
  assert.equal(
    workspaceRegistryEntrySchema.safeParse({ ...entry({ key: "", lastActivityAt: now }) }).success,
    false,
  );
});
