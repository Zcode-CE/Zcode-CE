// 在仓库外验证发行包，避免开发机 node_modules 掩盖缺失的 TUI/native/worker 依赖。
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const exec = promisify(execFile);
const archive = process.argv[2];
assert.ok(archive, "Usage: node scripts/zcode-distribution-smoke.mjs <archive.tar.gz>");
const directory = await realpath(await mkdtemp(join(tmpdir(), "zcode-release-smoke-")));
const root = join(directory, "zcode");
const runner = join(root, "bin/zcode.mjs");
const workspace = join(directory, "workspace");
const env = {
  ...process.env,
  ZCODE_DATA_BASE_DIR: join(directory, "data"),
  NODE_PATH: "",
  NODE_OPTIONS: "",
  TERM: "xterm-256color",
};
let web;
let terminal;
try {
  await exec("tar", ["-xzf", resolve(archive), "-C", directory]);
  await mkdir(workspace);
  await exec(process.execPath, [runner, "--help"], { cwd: workspace, env });
  // --version 的首行必须是**纯版本号**且等于分发包 package.json 的版本（第二行是身份标注，不参与比较）。
  const { version: packagedVersion } = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  const versionOutput = (
    await exec(process.execPath, [runner, "--version"], { cwd: workspace, env })
  ).stdout.trim();
  const [version, ...versionIdentityLines] = versionOutput.split("\n").map((line) => line.trim());
  assert.equal(
    version,
    packagedVersion,
    `--version 首行必须是分发包版本（期望 ${packagedVersion}，实际 ${version}）`,
  );
  assert.match(
    versionIdentityLines.join("\n"),
    /zcode-agent/u,
    "--version 第二行应标注内置 agent 版本",
  );
  const require = createRequire(join(root, "package.json"));
  const pty = require("node-pty");
  const runtimeCheck = join(root, "agent/check-tui.mjs");
  await writeFile(
    runtimeCheck,
    'import { runTui } from "@zcode/tui"; if (typeof runTui !== "function") throw new Error("Missing TUI export"); console.log("tui-runtime-ok");',
  );
  const imported = await exec(process.execPath, [runtimeCheck], { cwd: workspace, env });
  assert.match(imported.stdout, /tui-runtime-ok/);

  terminal = pty.spawn(process.execPath, [runner], { cwd: workspace, env, cols: 110, rows: 32 });
  let screen = "";
  let terminalExit;
  terminal.onData((data) => {
    screen += data;
  });
  const tuiExited = new Promise((done) =>
    terminal.onExit((event) => {
      terminalExit = event;
      done(event);
    }),
  );
  await until(
    () => /ZCode/.test(screen) && /(?:登录|\/login|输入提示词|Type a prompt)/i.test(screen),
    "TUI initialized render",
    () => screen,
  );
  assert.equal(terminalExit, undefined, screen);
  assert.doesNotMatch(screen, /Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND/);
  // 保留真实键盘退出链路；不发送 prompt，不调用模型。
  terminal.write("\u0003");
  await setTimeout(200);
  if (!terminalExit) terminal.write("\u0003");
  const tuiExit = await Promise.race([
    tuiExited,
    setTimeout(8000).then(() => {
      throw new Error("TUI keyboard exit timed out");
    }),
  ]);
  assert.equal(tuiExit.exitCode, 0, screen);
  terminal = undefined;

  let webOutput = "";
  // 鉴权与非回环这两条是**安全不变式**：必须在解包产物上验，单测里验过 ≠ 分发物里成立。
  const webToken = "smoke-token-7f3a";
  web = spawn(
    process.execPath,
    [runner, "--web", "--workspace", workspace, "--no-open", "--token", webToken],
    {
      cwd: workspace,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  web.stdout.on("data", (data) => {
    webOutput += data;
  });
  web.stderr.on("data", (data) => {
    webOutput += data;
  });
  let base;
  await until(
    () => {
      base = webOutput.match(/Local:\s+(http:\/\/127\.0\.0\.1:\d+\/)/)?.[1];
      return Boolean(base);
    },
    "Web URL",
    () => webOutput,
  );
  let info;
  await until(
    async () => {
      try {
        const response = await fetch(new URL("api/server-info?token=" + webToken, base), {
          signal: AbortSignal.timeout(1000),
        });
        if (!response.ok) return false;
        info = await response.json();
        return true;
      } catch {
        return false;
      }
    },
    "Web readiness",
    () => webOutput,
  );
  assert.equal(info.workspaces[0].path, workspace);
  // 安全不变式 ①：无令牌 401、带令牌 200（面板壳本身仍可匿名取到，见下面的 `/` 200）
  const unauthenticated = await fetch(new URL("api/server-info", base));
  assert.equal(unauthenticated.status, 401, "server-info must be 401 without a token");
  const authenticated = await fetch(new URL("api/server-info?token=" + webToken, base));
  assert.equal(authenticated.status, 200, "server-info must be 200 with a token");
  const html = await fetch(base);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /<html/i);
  const { default: WebSocket } = await import(pathToFileURL(require.resolve("ws")).href);
  const webSocketBase = base.replace("http:", "ws:");
  // 安全不变式 ①（续）：/ws 也必须鉴权 —— 无令牌升级被判 401，而不是静默放行。
  const unauthenticatedSocket = new WebSocket(new URL("ws", webSocketBase));
  const upgradeRejection = await new Promise((done) => {
    unauthenticatedSocket.once("error", (error) => done(String(error)));
    unauthenticatedSocket.once("open", () => done("unexpected-open"));
  });
  assert.match(upgradeRejection, /401|Unexpected server response/u);
  const socket = new WebSocket(new URL("ws?token=" + webToken, webSocketBase));
  await once(socket, "open");
  socket.close();
  await once(socket, "close");
  const exited = once(web, "exit");
  web.kill("SIGTERM");
  assert.deepEqual(await exited, [0, null]);
  web = undefined;

  // 安全不变式 ②：非回环 + 无令牌必须**拒绝启动**（退出码非 0 的数字），且日志给出可操作原因。
  // 真起服务而被超时杀掉时 exit code 是 null（signal）⇒ 下面的 typeof 断言会把这种情况判红，不会假通过。
  const refusal = await runToExit([
    runner,
    "--web",
    "--workspace",
    workspace,
    "--no-open",
    "--host",
    "0.0.0.0",
    "--no-token",
  ]);
  assert.ok(
    typeof refusal.code === "number" && refusal.code !== 0,
    `non-loopback without a token must refuse to start, got exit=${String(refusal.code)}\n${refusal.output}`,
  );
  assert.match(refusal.output, /Refusing to start|拒绝启动/u);
  assert.match(refusal.output, /token|令牌/u);

  console.log(
    JSON.stringify({
      version,
      platform: process.platform,
      arch: process.arch,
      tui: "native import, initialized render, keyboard exit passed",
      web: "HTML, server-info, workspace, WebSocket, shutdown passed",
      security: "401 without token, 200 with token, non-loopback without token refused",
      isolated: true,
    }),
  );
} finally {
  terminal?.kill();
  web?.kill();
  await rm(directory, { recursive: true, force: true });
}

/** 跑一个必然退出的子进程并回收输出（用于断言"拒绝启动"这类 fail-closed 行为）。 */
async function runToExit(args, timeoutMs = 10_000) {
  const child = spawn(process.execPath, args, {
    cwd: workspace,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => {
    output += data;
  });
  child.stderr.on("data", (data) => {
    output += data;
  });
  // 注意：本文件从 `node:timers/promises` 导入了 `setTimeout`（签名是 (ms)），
  // 这里必须用全局定时器，否则会把回调当成 delay 传进去（ERR_INVALID_ARG_TYPE）。
  const timer = globalThis.setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const [code] = await once(child, "exit");
  globalThis.clearTimeout(timer);
  return { code, output };
}

async function until(check, label, diagnostic) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await setTimeout(100);
  }
  throw new Error(`${label} timed out:\n${diagnostic()}`);
}
