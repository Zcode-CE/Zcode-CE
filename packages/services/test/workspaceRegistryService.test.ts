import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ServiceCollection } from "../src/collection.js";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import {
  createWorkspaceRegistryService,
  IWorkspaceRegistryService,
} from "../src/session/workspaceRegistry.js";
import { createWorkspaceRegistryRepo } from "../src/session/workspaceRegistryRepo.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";

/**
 * 工作区注册表服务（M1.3）的护栏：默认视图口径 + 「列出工作区不产生子进程」。
 *
 * 为什么必须钉住：注册表是侧栏枚举的唯一真相源，而且是**被动订阅**的入口。
 * 一旦这条路径顺带拉起 Agent runtime，「能全看」的成本就会从 ≈14 KB/workspace
 * 变成每个 +20 MB 与一个子进程（50 个外推 ≈1 GB + 50 进程）——
 * 见 docs/development/workspace-registry.md §3.1 与
 * .reverse/40-remote-control/PUBLISHER-SCALE-MEASUREMENT.md §2。
 */

const DAY = 24 * 60 * 60 * 1000;

/**
 * 本进程直接子进程数。Linux 上读 /proc（node:test 里没有更可靠的跨平台等价物）；
 * 其它平台返回 null，调用方跳过该断言而不是假装通过。
 */
async function countChildProcesses(): Promise<number | null> {
  try {
    const path = `/proc/self/task/${process.pid}/children`;
    const raw = await readdir("/proc/self/task");
    assert.ok(raw.length > 0, "自我检查：必须能枚举线程目录");
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(path, "utf8");
    return text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;
  } catch {
    return null;
  }
}

function withTempDb(run: (db: DatabaseSync, path: string) => void | Promise<void>) {
  return (async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-registry-service-"));
    const path = join(dir, "tasks-index.sqlite");
    const db = new DatabaseSync(path);
    try {
      await run(db, path);
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  })();
}

function insertTask(
  db: DatabaseSync,
  row: { key: string; taskId: string; updatedAt: number; archived?: number },
) {
  db.prepare(
    "INSERT INTO tasks (workspace_key, workspace_path, workspace_identity, task_id, title, created_at, updated_at, pinned, archived, deleted) VALUES (?,?,?,?,?,?,?,0,?,0)",
  ).run(
    row.key,
    row.key,
    null,
    row.taskId,
    row.taskId,
    row.updatedAt,
    row.updatedAt,
    row.archived ?? 0,
  );
}

test("默认视图 = 最近活跃窗口 ∪ 置顶；窗口外的条目只在全集里", async () => {
  const now = 1_800_000_000_000;
  const service = createWorkspaceRegistryService({
    now: () => now,
    listEntries: async () => [
      {
        workspaceKey: "/proj/recent",
        workspacePath: "/proj/recent",
        firstSeenAt: now - 2 * DAY,
        lastActivityAt: now - DAY,
        sessionCount: 3,
        sources: ["task-index"],
      },
      {
        workspaceKey: "/proj/stale",
        workspacePath: "/proj/stale",
        firstSeenAt: now - 400 * DAY,
        lastActivityAt: now - 200 * DAY,
        sessionCount: 9,
        sources: ["task-index"],
      },
      {
        workspaceKey: "/proj/pinned-stale",
        workspacePath: "/proj/pinned-stale",
        firstSeenAt: now - 400 * DAY,
        lastActivityAt: now - 300 * DAY,
        sessionCount: 1,
        sources: ["task-index"],
      },
    ],
  });

  const result = await service.listWorkspaceRegistry({ pinnedKeys: ["/proj/pinned-stale"] });
  assert.equal(result.windowDays, 30, "默认窗口必须是产品决定的 30 天");
  assert.deepEqual(
    result.entries.map((entry) => entry.workspaceKey).sort(),
    ["/proj/pinned-stale", "/proj/recent", "/proj/stale"],
    "全集必须包含窗口外的条目（「能全看」）",
  );
  assert.deepEqual(
    result.defaultView.map((entry) => entry.workspaceKey),
    ["/proj/recent", "/proj/pinned-stale"],
    "默认视图 = 窗口内 ∪ 置顶，且按最近活动降序",
  );

  // 反向验证锚点：去掉「置顶」这一路后，defaultView 里必须出现 /proj/stale 之外的差异 ——
  // 即 pinned-stale 会掉出默认视图（此断言随之变红）。
  const withoutPinned = await service.listWorkspaceRegistry();
  assert.ok(
    !withoutPinned.defaultView.some((entry) => entry.workspaceKey === "/proj/pinned-stale"),
    "没有置顶偏好时，窗口外条目不得进入默认视图",
  );
});

test("坏行被丢弃，且不抛错（一个坏行不得让整个侧栏变空）", async () => {
  const now = 1_800_000_000_000;
  const service = createWorkspaceRegistryService({
    now: () => now,
    listEntries: async () => [
      {
        workspaceKey: "",
        workspacePath: "",
        firstSeenAt: 0,
        lastActivityAt: 0,
        sessionCount: 0,
        sources: [],
      } as never,
      {
        workspaceKey: "/proj/ok",
        workspacePath: "/proj/ok",
        firstSeenAt: now,
        lastActivityAt: now,
        sessionCount: 1,
        sources: ["task-index"],
      },
    ],
  });
  const result = await service.listWorkspaceRegistry();
  assert.deepEqual(
    result.entries.map((entry) => entry.workspaceKey),
    ["/proj/ok"],
  );
});

test("列出 50 个工作区不产生任何子进程，且不改动任务行", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ws-registry-50-"));
  const path = join(dir, "tasks-index.sqlite");
  {
    const db = new DatabaseSync(path);
    try {
      runTasksDatabaseMigrations(db, {});
      const now = Date.now();
      for (let index = 0; index < 50; index += 1) {
        insertTask(db, {
          key: `/proj/ws-${index}`,
          taskId: `t${index}`,
          updatedAt: now - index * 1_000,
        });
      }
    } finally {
      db.close();
    }
  }
  {
    const repo = new TaskIndexRepo(path);
    try {
      const before = await countChildProcesses();
      const entries = await repo.listWorkspaceRegistryEntries();
      const after = await countChildProcesses();
      if (before !== null && after !== null) {
        assert.equal(after, before, "列出工作区不得产生任何子进程（架构不变式 §3.1）");
      } else {
        t.diagnostic("非 Linux：跳过子进程计数断言（未做，不等于通过）");
      }
      assert.equal(entries.length, 50, "50 个 workspace 必须全部在册");
      assert.ok(
        entries.every((entry) => entry.sessionCount === 1),
        "持久层会话数必须来自任务行，不依赖 runtime",
      );

      // 回填幂等：再来一次不得改变行数，也不得改动 tasks 表。
      const again = await repo.listWorkspaceRegistryEntries();
      assert.deepEqual(
        again.map((entry) => entry.workspaceKey),
        entries.map((entry) => entry.workspaceKey),
        "重复列出不得改变注册表内容",
      );
      const verify = new DatabaseSync(path);
      try {
        const taskRows = verify.prepare("SELECT count(*) AS c FROM tasks").get() as {
          c: number;
        };
        assert.equal(taskRows.c, 50, "注册表枚举/回填不得改动 tasks 表");
        const registryRows = verify
          .prepare("SELECT count(*) AS c FROM workspace_registry")
          .get() as { c: number };
        assert.equal(registryRows.c, 50, "注册表应被一次性幂等回填");
      } finally {
        verify.close();
      }
    } finally {
      repo.close();
    }
  }
  await rm(dir, { recursive: true, force: true });
});

test("注册表服务是只读面：ServiceCollection 里缺服务时 getOptional 返回 undefined（客户端必须回落到显式列出）", () => {
  const services = new ServiceCollection();
  assert.equal(services.getOptional(IWorkspaceRegistryService), undefined);
});

test("注册表仓储与任务索引共用同一份枚举语义（归档-only 的 workspace 也在册）", async () => {
  await withTempDb(async (db, path) => {
    runTasksDatabaseMigrations(db, {});
    const now = Date.now();
    insertTask(db, {
      key: "/proj/only-archived",
      taskId: "t-archived",
      updatedAt: now,
      archived: 1,
    });
    const repo = new TaskIndexRepo(path);
    try {
      const entries = await repo.listWorkspaceRegistryEntries();
      assert.deepEqual(
        entries.map((entry) => entry.workspaceKey),
        ["/proj/only-archived"],
      );
    } finally {
      repo.close();
    }
    // 对照：仓储层与「直接读库」口径一致（持久层必须留下该行，
    // 否则「会话看起来丢了」会以另一种形式回归）。
    const verify = new DatabaseSync(path);
    try {
      const direct = createWorkspaceRegistryRepo({ database: verify });
      assert.ok(
        direct.list().some((entry) => entry.workspaceKey === "/proj/only-archived"),
        "持久层必须留下归档-only 的 workspace",
      );
    } finally {
      verify.close();
    }
  });
});
