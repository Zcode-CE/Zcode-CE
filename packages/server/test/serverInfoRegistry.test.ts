import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { ServiceCollection } from "@zcode/services";
import { IWorkspaceRegistryService } from "@zcode/services";
import type { WorkspaceRegistryEntry, WorkspaceRegistryListResult } from "@zcode/shared";
import { createHttpServer } from "../src/http.js";

/**
 * M1.3：/api/server-info.workspaces 由**服务端注册表**驱动。
 *
 * 为什么必须钉住：
 * ① 手机打开服务后，初始 workspace 以前只会是 ZCODE_SERVER_WORKSPACE/cwd（跟用户无关的目录），
 *    而真实数据侧有 50+ 个 workspace；改由注册表默认视图驱动后两端口径一致；
 * ② **列出工作区不得产生任何子进程**（架构不变式，见 docs/development/workspace-registry.md §3.1）：
 *    一旦 server-info 顺带拉起 Agent runtime，成本从 ≈KB/workspace 变成 +20 MB 与 1 进程/workspace；
 * ③ 注册表读失败不得让 server-info 500 —— 它同时承担 web 启动期的鉴权探测，
 *    失败必须回落到 cwd 并告警，而不是把「授权问题」和「注册表问题」混成一件事。
 */

const DAY = 24 * 60 * 60 * 1000;

async function countChildProcesses(): Promise<number | null> {
  try {
    await readdir("/proc/self/task");
    const text = await readFile(`/proc/self/task/${process.pid}/children`, "utf8");
    return text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;
  } catch {
    return null;
  }
}

function buildEntry(index: number, now: number): WorkspaceRegistryEntry {
  return {
    workspaceKey: `/proj/ws-${index}`,
    workspacePath: `/proj/ws-${index}`,
    firstSeenAt: now - DAY,
    lastActivityAt: now - index * 1_000,
    sessionCount: index + 1,
    sources: ["task-index"],
  };
}

function createStubRegistry(entries: WorkspaceRegistryEntry[]) {
  const calls: Array<readonly string[] | undefined> = [];
  const service = {
    async listWorkspaceRegistry(params?: { pinnedKeys?: readonly string[] }) {
      calls.push(params?.pinnedKeys);
      const defaultView = entries.filter((entry) => entry.lastActivityAt >= Date.now() - 30 * DAY);
      return {
        entries,
        defaultView,
        windowDays: 30,
        generatedAt: Date.now(),
      } satisfies WorkspaceRegistryListResult;
    },
  };
  return { service, calls };
}

async function listen(server: {
  listening: boolean;
  once: (event: "listening", listener: () => void) => unknown;
  address: () => unknown;
}): Promise<number> {
  if (!server.listening) {
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  }
  const address = server.address();
  return typeof address === "object" && address !== null && "port" in address
    ? Number(address.port)
    : 0;
}

async function close(server: { close: (callback: () => void) => unknown }): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("server-info.workspaces 来自注册表默认视图（含 identity），且列出 50 个不产生子进程", async (t) => {
  const now = Date.now();
  const entries = Array.from({ length: 50 }, (_, index) => buildEntry(index, now));
  const { service, calls } = createStubRegistry(entries);
  const services = new ServiceCollection();
  services.register(IWorkspaceRegistryService, service);
  const server = createHttpServer(services, 0, { host: "127.0.0.1", authToken: "m13" });
  const port = await listen(server);
  try {
    const before = await countChildProcesses();
    const response = await fetch(`http://127.0.0.1:${port}/api/server-info?token=m13`);
    assert.equal(response.status, 200);
    const info = (await response.json()) as {
      workspaces: Array<{ path: string; label?: string; workspaceIdentity?: string }>;
    };
    const after = await countChildProcesses();
    if (before !== null && after !== null) {
      assert.equal(after, before, "server-info 列出工作区不得产生任何子进程（§3.1）");
    } else {
      t.diagnostic("非 Linux：跳过子进程计数断言（未做，不等于通过）");
    }
    assert.ok(info.workspaces.length > 0, "workspaces 不得为空");
    assert.equal(
      info.workspaces[0]?.path,
      "/proj/ws-0",
      "workspaces[0] 必须是注册表里最近活跃的 workspace（web 用它做初始 workspace）",
    );
    assert.ok(
      info.workspaces.every((workspace) => workspace.label?.startsWith("ws-")),
      "label 必须由服务端按路径导出",
    );
    assert.equal(calls.length, 1, "一次 server-info 只读一次注册表");
  } finally {
    await close(server);
  }
});

test("注册表读失败时回落到 ZCODE_SERVER_WORKSPACE/cwd，并且不 500", async () => {
  const services = new ServiceCollection();
  services.register(IWorkspaceRegistryService, {
    async listWorkspaceRegistry(): Promise<WorkspaceRegistryListResult> {
      throw new Error("registry unavailable (test)");
    },
  });
  const server = createHttpServer(services, 0, { host: "127.0.0.1", authToken: "m13" });
  const port = await listen(server);
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/server-info?token=m13`);
    assert.equal(response.status, 200, "注册表故障不得让鉴权探测端点变 500");
    const info = (await response.json()) as { workspaces: unknown[] };
    assert.equal(info.workspaces.length, 1, "必须回落到单条 cwd/ZCODE_SERVER_WORKSPACE");
    assert.ok(
      warnings.some((entry) => entry.includes("读取工作区注册表失败")),
      "回落必须留下可排查的告警，实际：" + JSON.stringify(warnings),
    );
  } finally {
    console.warn = originalWarn;
    await close(server);
  }
});

test("显式传入的 workspaces 仍然优先（server-core 与测试的显式契约不得被注册表覆盖）", async () => {
  const services = new ServiceCollection();
  services.register(IWorkspaceRegistryService, {
    async listWorkspaceRegistry(): Promise<WorkspaceRegistryListResult> {
      throw new Error("不得被调用");
    },
  });
  const server = createHttpServer(services, 0, {
    host: "127.0.0.1",
    authToken: "m13",
    workspaces: [{ path: "/explicit/only", label: "only" }],
  });
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/server-info?token=m13`);
    assert.equal(response.status, 200);
    const info = (await response.json()) as { workspaces: Array<{ path: string }> };
    assert.deepEqual(
      info.workspaces.map((workspace) => workspace.path),
      ["/explicit/only"],
    );
  } finally {
    await close(server);
  }
});
