// M7：Core 输出落盘的行为判据（有界、崩溃留线索、正常路径不变）。
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CORE_LOG_FILE_NAME,
  CORE_LOG_REASON_MAX_CHARS,
  CoreLogSink,
  withCoreLogHint,
} from "../src/supervisor/coreLog.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-core-log-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 用真实 fork 起一个假 Core，验证「pipe → Supervisor 记账 → 落盘」这条真实链路。 */
async function runFakeCore(
  dir: string,
  sink: CoreLogSink,
  generation: number,
  body: string,
): Promise<void> {
  await sink.open(generation);
  const script = join(dir, `fake-core-${generation}.mjs`);
  await writeFile(script, body);
  const child = fork(script, [], {
    execPath: process.execPath,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stdout?.on("data", (chunk: Buffer) => sink.write(chunk));
  child.stderr?.on("data", (chunk: Buffer) => sink.write(chunk));
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  await sink.close();
}

test("Core 的 stderr 与 stdout 都落进 core.log，并带本次 launch 的分隔头", async () => {
  await withTempDir(async (dir) => {
    const sink = new CoreLogSink({ runDir: dir });
    await runFakeCore(
      dir,
      sink,
      7,
      [
        "process.stderr.write('core boom: missing release\\n');",
        "process.stdout.write('core ready\\n');",
        "process.exit(1);",
      ].join("\n"),
    );
    const log = await readFile(join(dir, CORE_LOG_FILE_NAME), "utf8");
    assert.match(log, /--- core generation=7 started /);
    assert.match(log, /core boom: missing release/);
    assert.match(log, /core ready/);
  });
});

test("有界：同一代内写超上限就轮转，磁盘只留 rotations+1 份", async () => {
  await withTempDir(async (dir) => {
    const sink = new CoreLogSink({ runDir: dir, maxBytes: 1024, rotations: 1 });
    await sink.open(1);
    // 8 KB 输出 = 上限的 8 倍：不轮转的话文件会远超上限。
    for (let index = 0; index < 80; index += 1) {
      sink.write(Buffer.from(`${index} ${"x".repeat(80)}\n`, "utf8"));
    }
    await sink.close();
    const files = (await readdir(dir)).filter((name) => name.startsWith(CORE_LOG_FILE_NAME)).sort();
    assert.deepEqual(files, [CORE_LOG_FILE_NAME, `${CORE_LOG_FILE_NAME}.1`]);
    for (const name of files) {
      const size = (await readFile(join(dir, name), "utf8")).length;
      // 允许单条超过上限的那一 chunk 落在边界上，但绝不能接近总输出量。
      assert.ok(size <= 1024 + 96, `${name} grew past the bound: ${size}`);
    }
  });
});

test("跨代：open 时超限先轮转；任意文件都不超过上限", async () => {
  await withTempDir(async (dir) => {
    // maxBytes 取 256：够放一代的分隔头 + 一段输出，但放不下 600 字节的历史内容。
    const sink = new CoreLogSink({ runDir: dir, maxBytes: 256, rotations: 1 });
    await runFakeCore(dir, sink, 1, "process.stdout.write('y'.repeat(600));");
    await runFakeCore(dir, sink, 2, "process.stdout.write('second generation');");
    const files = (await readdir(dir)).filter((name) => name.startsWith(CORE_LOG_FILE_NAME)).sort();
    assert.deepEqual(files, [CORE_LOG_FILE_NAME, `${CORE_LOG_FILE_NAME}.1`]);
    for (const name of files) {
      const size = (await readFile(join(dir, name), "utf8")).length;
      assert.ok(size <= 256, `${name} grew past the bound: ${size}`);
    }
    // 上一代的 600 字节被切碎轮转，绝不会整块留在某个文件里；当前代内容仍可读。
    const current = await readFile(join(dir, CORE_LOG_FILE_NAME), "utf8");
    assert.match(current, /generation=2/);
    assert.match(current, /second generation/);
    const totalCharacters = (
      await Promise.all(files.map((name) => readFile(join(dir, name), "utf8")))
    ).reduce((sum, text) => sum + text.length, 0);
    assert.ok(
      totalCharacters <= 2 * 256,
      `disk usage grew past rotations+1 windows: ${totalCharacters}`,
    );
  });
});

test("tail 只返回尾部非空行，缺失文件返回空", async () => {
  await withTempDir(async (dir) => {
    const sink = new CoreLogSink({ runDir: dir });
    await sink.open(1);
    for (let index = 0; index < 30; index += 1) sink.appendLine(`row ${index}`);
    await sink.close();
    assert.deepEqual((await sink.tail(3)).slice(-3), ["row 27", "row 28", "row 29"]);
    assert.deepEqual(await new CoreLogSink({ runDir: join(dir, "missing") }).tail(), []);
  });
});

test("退出原因带日志路径，且总长不超过 schema 上限", () => {
  const path = "/home/user/.zcode/server/run/core.log";
  assert.equal(
    withCoreLogHint("core exited code=1 signal=none", path),
    `core exited code=1 signal=none (core log: ${path})`,
  );
  // 没有日志时行为与补日志前逐字一致。
  assert.equal(
    withCoreLogHint("core exited code=1 signal=none", undefined),
    "core exited code=1 signal=none",
  );
  const long = withCoreLogHint("x".repeat(2000), path);
  assert.equal(long.length, CORE_LOG_REASON_MAX_CHARS);
  assert.ok(long.endsWith(`(core log: ${path})`), "路径必须留在尾部");
});
