// 配置文件真实链路判据（task-48）：解包发行包后按配置文件启动，验证优先级链与 fail-closed。
// 需要先构建分发包（pnpm build:zcode）；未构建时显式 skip，不静默通过。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

async function findArchive() {
  const { glob } = await import("node:fs/promises");
  try {
    const matches = [];
    for await (const entry of glob("dist/zcode/releases/*/zcode-*.tar.gz", { cwd: repoRoot })) {
      matches.push(entry);
    }
    return matches.sort().at(-1);
  } catch {
    return undefined;
  }
}

test("配置文件优先级链与 fail-closed（真实链路）", async (t) => {
  const archive = await findArchive();
  if (!archive) {
    t.skip("分发包未构建：先跑 pnpm build:zcode");
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "zcode-config-test-"));
  const env = { ...process.env, HOME: join(dir, "home") };
  try {
    await mkdir(env.HOME, { recursive: true });
    await exec("tar", ["-xzf", resolve(repoRoot, archive), "-C", dir]);
    const runner = join(dir, "zcode", "bin", "zcode.mjs");
    assert.ok(existsSync(runner), "解包后应存在 bin/zcode.mjs");
    const configPath = join(dir, "server.json");
    await writeFile(configPath, JSON.stringify({ host: "127.0.0.1", port: 32123 }));
    const base = { ...env, ZCODE_CLI_CONFIG: configPath };
    // flag 未给时用文件里的端口（真实链路：起服务后读日志里的地址）
    const started = await startAndReadAddress(runner, ["--web", "--no-open"], base);
    assert.match(started.output, /127\.0\.0\.1:32123\//u, started.output);
    // flag 压过文件
    const overridden = await startAndReadAddress(
      runner,
      ["--web", "--no-open", "--port", "32456"],
      base,
    );
    assert.match(overridden.output, /127\.0\.0\.1:32456\//u, overridden.output);
    // env 压过文件
    const envWins = await startAndReadAddress(runner, ["--web", "--no-open"], {
      ...base,
      PORT: "32789",
    });
    assert.match(envWins.output, /127\.0\.0\.1:32789\//u, envWins.output);
    // 取值非法 ⇒ 拒绝启动并指出键名
    await writeFile(configPath, JSON.stringify({ port: 99999 }));
    const bad = await runToExit(runner, ["--web", "--no-open"], base);
    assert.notEqual(bad.code, 0, "非法端口必须拒绝启动");
    assert.match(bad.output, /"port"/u, bad.output);
    // 未知键 ⇒ 告警但可启动
    await writeFile(configPath, JSON.stringify({ port: 32890, portt: 1 }));
    const unknown = await startAndReadAddress(runner, ["--web", "--no-open"], base);
    assert.match(unknown.output, /未知键/u, unknown.output);
    assert.match(unknown.output, /127\.0\.0\.1:32890\//u, unknown.output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function runToExit(runner, args, env, timeoutMs = 15_000) {
  const child = (await import("node:child_process")).spawn(process.execPath, [runner, ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => {
    output += d;
  });
  child.stderr.on("data", (d) => {
    output += d;
  });
  const timer = globalThis.setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const code = await new Promise((done) => child.once("exit", (c) => done(c)));
  globalThis.clearTimeout(timer);
  return { code, output };
}

async function startAndReadAddress(runner, args, env) {
  const child = (await import("node:child_process")).spawn(process.execPath, [runner, ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => {
    output += d;
  });
  child.stderr.on("data", (d) => {
    output += d;
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !/Local:\s+http:\/\//u.test(output)) {
    await new Promise((r) => globalThis.setTimeout(r, 200));
  }
  assert.match(output, /Local:\s+http:\/\//u, `服务未就绪：${output}`);
  child.kill("SIGTERM");
  await new Promise((done) => child.once("exit", done));
  return { output };
}
