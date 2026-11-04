// 桌面探测判据：`status --json` 在未运行 / 未安装时仍返回结构化结果且退出码为 0。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runServerCli } from "../src/cli.js";
import { serverStatusSchema, type ServerStatus } from "../src/contracts.js";
import { resolveServerLayout } from "../src/runtime/paths.js";

async function withServerRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "zcode-server-root-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function readStatusJson(root: string): Promise<{ code: number; status: ServerStatus }> {
  let written = "";
  const code = await runServerCli(["status", "--json", "--server-root", root], {
    stdout: {
      write: (value: string) => {
        written += value;
      },
    },
  });
  // 桌面直接 JSON.parse 这一行：解析失败就是探测失败，所以这里按同样的方式断言。
  const status = serverStatusSchema.parse(JSON.parse(written));
  return { code, status };
}

test("未安装且未运行：结构化 stopped + installed:false + 退出码 0", async () => {
  await withServerRoot(async (root) => {
    const { code, status } = await readStatusJson(root);
    assert.equal(code, 0, "探测不能因为没装/没跑就非零退出");
    assert.equal(status.state, "stopped");
    assert.equal(status.installed, false);
    assert.equal(status.port, null);
    assert.equal(status.host, null);
    assert.equal(status.pid, null);
    assert.equal(status.lastExitReason, null);
    // 桌面靠这几个字段判版本兼容与「是否同一代」，缺一个就只能降级。
    for (const key of [
      "state",
      "host",
      "port",
      "version",
      "protocolVersion",
      "generation",
      "pid",
      "lastExitReason",
      "installed",
    ] as const) {
      assert.ok(key in status, `status --json 缺字段 ${key}`);
    }
    assert.deepEqual(await readdirSafe(root), []);
  });
});

test("已安装未运行：installed 由 install.json 事实给出（不依赖快照）", async () => {
  await withServerRoot(async (root) => {
    await writeFile(join(root, "install.json"), "{}\n", "utf8");
    const { code, status } = await readStatusJson(root);
    assert.equal(code, 0);
    assert.equal(status.state, "stopped");
    assert.equal(status.installed, true);
  });
});

test("旧快照没有 installed 字段时，输出仍以文件系统为准", async () => {
  await withServerRoot(async (root) => {
    const layout = resolveServerLayout(root);
    await mkdir(layout.runDir, { recursive: true });
    // 模拟升级前落盘的快照：没有 installed 字段，但声明自己 ready。
    await writeFile(
      layout.statusFile,
      `${JSON.stringify(
        {
          protocolVersion: 1,
          state: "ready",
          pid: 4321,
          port: 51000,
          host: "127.0.0.1",
          version: "3.16.3-ce.1",
          generation: 2,
          startedAt: 1,
          lastExitReason: "core exited code=1 signal=none (core log: /tmp/run/core.log)",
          serviceRegistered: false,
          runningTaskCount: 0,
          crashBudget: { crashCount: 1, nextRestartDelayMs: 1000, exhausted: false },
          updatedAt: 1,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(join(root, "install.json"), "{}\n", "utf8");
    const { code, status } = await readStatusJson(root);
    assert.equal(code, 0);
    // 控制面不可用时读快照：状态与崩溃线索都保留下来，installed 由安装标记覆盖。
    assert.equal(status.state, "ready");
    assert.equal(status.port, 51000);
    assert.match(status.lastExitReason ?? "", /core log: \/tmp\/run\/core\.log/);
    assert.equal(status.installed, true);
  });
});

async function readdirSafe(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  return readdir(dir).catch(() => []);
}

test("status --json 的 stdout 是单行 JSON（便于桌面按行解析）", async () => {
  await withServerRoot(async (root) => {
    let written = "";
    await runServerCli(["status", "--json", "--server-root", root], {
      stdout: {
        write: (value: string) => {
          written += value;
        },
      },
    });
    assert.equal(written.trimEnd().split("\n").length, 1);
  });
});
