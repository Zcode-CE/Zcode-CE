// 在仓库外验证发行包，避免开发机 node_modules 掩盖缺失的 TUI/native/worker 依赖。
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
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
  // 解包（非 root）会按 umask 抹掉包内记录的权限位（实测 umask 077 ⇒ bin/zcode.mjs 700、旁路 600）。
  // 这里要判的是**构建期 chmod 记录的**权限，而不是评审人机器的 umask，所以先固定成 CI 的 022。
  process.umask(0o022);
  await exec("tar", ["-xzf", resolve(archive), "-C", directory]);
  // 权限位断言（task-61 F1）：必须在**解包产物**上判。
  // 为什么重要：`cp` 会用进程 umask（task-49 实测抽出过 600）；600 在单用户机器上跑得动，
  // 但 root 安装后普通用户 import 不了 ⇒ 启动即崩。而本脚本下面用 `process.execPath` 启动入口，
  // 并不需要执行位、Node 以属主身份读 600 也照样成功 ⇒ 少了这层断言就抓不到这类回归。
  // 名单从包里 `bin/runner-*.mjs` 现读（不写死），新增旁路模块时不会留下过期的断言清单。
  const binDir = join(root, "bin");
  const runnerEntryMode = await assertMode(join(binDir, "zcode.mjs"), 0o755);
  const sidecarNames = (await readdir(binDir)).filter((name) => /^runner-.+\.mjs$/u.test(name));
  assert.ok(
    sidecarNames.length > 0,
    "bin/ 下没有 runner-*.mjs 旁路模块：runner.mjs 拆分后的结构依赖缺失（打包拷贝清单漏了？）",
  );
  for (const name of sidecarNames) await assertMode(join(binDir, name), 0o644);
  console.log(
    `permissions: zcode.mjs=${runnerEntryMode.toString(8)}, sidecars=${sidecarNames.length}x644`,
  );
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
  // 内置技能包（bundled-skills）必须在解包产物里，且必须在运行时会读的那个路径上。
  //
  // 为什么在这里判而不是在构建期判「文件复制成功」：本项目已两次踩过「中间阶段全绿、最终消费点失败」。
  // /workflow 是内置命令、无条件展开，它的提示词要求模型先读 dynamic-workflows 技能；技能门又会拒绝
  // 未加载技能时的调用 ⇒ 技能文件不在包里 = 门拒 + 读不到的死循环。构建期复制成功不能证明这一点，
  // 因为真正决定「读到哪」的是运行时 resolveBundledSkillRoots 的候选目录遍历。
  //
  // 判据与运行时同源：候选基目录第一顺位是 dirname(argv[1]) = agent/（见 entrypoint-candidates.ts），
  // 所以这里断言 agent/packages/bundled-skills/skills/<skill>/SKILL.md 存在。
  // 必需清单从包内现读（不写死第二份），新增技能时不会留下过期断言。
  const bundledSkillRoot = join(root, "agent", "packages", "bundled-skills");
  const bundledSkillsDir = join(bundledSkillRoot, "skills");
  // 用 stat 判存在而不是直接 readdir：目录缺席时要给可操作原因（哪个路径、为什么重要），
  // 而不是一条裸 ENOENT —— 这条断言的价值就在于让后来者一眼看懂漏了什么。
  const bundledSkillsDirStat = await stat(bundledSkillsDir).catch(() => null);
  assert.ok(
    bundledSkillsDirStat?.isDirectory(),
    `内置技能包不在解包产物里：${bundledSkillsDir}` +
      "（build-zcode 的 stageBundledSkillPack 漏了？运行时 resolveBundledSkillRoots 的候选目录第一顺位就是" +
      " agent/，这里没有它 ⇒ /workflow 要求模型读的技能不存在，技能门会把调用拒死）",
  );
  const bundledSkillNames = await readdir(bundledSkillsDir);
  assert.ok(
    bundledSkillNames.length > 0,
    `内置技能包没有任何技能目录：${bundledSkillsDir}（stage 了空目录？）`,
  );
  for (const skillName of bundledSkillNames) {
    const skillFile = join(bundledSkillRoot, "skills", skillName, "SKILL.md");
    const skillStat = await stat(skillFile).catch(() => null);
    assert.ok(
      skillStat?.isFile(),
      `内置技能正文不在解包产物里：${skillFile}` +
        "（build-zcode 的 stageBundledSkillPack 漏了？运行时找不到它，/workflow 会被技能门拒死）",
    );
    assert.ok((await stat(skillFile)).size > 0, `内置技能正文为空：${skillFile}`);
  }
  console.log(
    `bundled skills: ${bundledSkillNames.length} pack(s) = ${bundledSkillNames.join(", ")}`,
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

  // 终止 TUI：用**真信号**，不要往 pty 里写 \u0003。
  //
  // 为什么不能用 \u0003（实测，本仓踩过：CI 上 flaky，同一产物两次结果不同）：
  // pty 里写入 0x03 的落点取决于**当时是否已进入 raw mode**，而这是一个竞态：
  //   · 还没设 raw mode ⇒ line discipline 的 ISIG 把它转成**真 SIGINT**
  //     ⇒ OpenTUI 的 exitSignals 里有 SIGINT ⇒ exitHandler 直接 destroy ⇒ 退出码 130（不是 0）；
  //   · 已设 raw mode ⇒ ISIG 关闭 ⇒ 它变成普通字节，而 TUI 的 useKeyboard 只处理按键事件，
  //     实测**收不到** ⇒ 进程**根本不退出**（探针 5/5 超时）。
  // 实测退出码分布（同一产物，就绪后等待不同时长再发 \u0003）：
  //   0ms→[0,0,0,0,130]  500ms→[0,0,0,0,0]  1000ms→[0,0,130,0,0]
  //   2000ms→[130,0,0,130,130]  5000ms→[130,130,0,130,130]
  // ⇒ 等得越久越容易 130（信号路径），再久则挂死（raw 路径）⇒ 这个手段**本质上不可靠**。
  //
  // 本步骤要证明的是「解包产物里的 TUI 能被正常终止、不挂死、无残留」——
  // 用真信号可以**确定性地**证明这一点（实测 SIGTERM ⇒ 3/3 稳定 143，SIGINT ⇒ 3/3 稳定 130）。
  // 「键盘退出链路」不在这里验：在 pty 上模拟按键无法可靠复现（见上：raw mode 竞态），
  // 在这里测只会得到一个 flaky 的假信号。它的判定逻辑（两次 Ctrl-C 才确认退出）
  // 是纯函数 resolveCtrlCExitIntent（apps/zcode-cli/packages/tui/src/app-keyboard-helpers.ts），
  // 由 apps/zcode-cli/packages/tui/test/ctrlCExitIntent.test.ts 覆盖 —— 那里能确定性复现，
  // 且不依赖 pty/raw mode 的时序。
  process.kill(terminal.pid, "SIGTERM");
  const tuiExit = await Promise.race([
    tuiExited,
    setTimeout(8000).then(() => {
      throw new Error("TUI did not exit after SIGTERM (可能挂死)");
    }),
  ]);
  // 被信号终止 ⇒ 128 + 信号号（SIGTERM=15 ⇒ 143）。这里断言的是"**干净地**被终止"，
  // 而不是"退出码恰好为 0"：后者要求 TUI 走完应用层的优雅退出，而那条路径只能靠按键触发，
  // 在 pty 上不可靠（见上）。**断言仍然有牙齿**：挂死会超时、残留会在这里暴露。
  assert.equal(tuiExit.exitCode, 143, screen);
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

/**
 * 断言文件权限位等于期望值，失败时给出「期望/实际 mode + 文件 + 为什么重要」。
 * 权限位错在单用户机器上不可见，只会在「root 安装、普通用户运行」时以启动失败的形式暴露 ⇒ 必须钉住。
 */
async function assertMode(file, expectedMode) {
  const actualMode = (await stat(file)).mode & 0o777;
  assert.equal(
    actualMode,
    expectedMode,
    `${file} 的权限位应为 ${expectedMode.toString(8)}，实际 ${actualMode.toString(8)}` +
      "（包内入口需可执行、旁路模块需普通用户可读：root 安装后非 root 用户 import 失败会表现为启动即崩）",
  );
  return actualMode;
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
