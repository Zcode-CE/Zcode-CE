#!/usr/bin/env node
/* eslint-disable max-lines -- 冒烟脚本按「启动 → CDP → 断言 → 诊断 → 清理」单文件实现；拆开会把失败诊断拆到多个文件里，反而更难排查。 */
// 打包版启动冒烟：启动「解包后的发布产物」，用 CDP 断言它真的能起来并完成渲染。
//
// 为什么需要它：发布流水线的 build job 只做 install → bundle → upload，从不启动产物；
// 构建期断言（asar 内容、native 边界、体积审计）全绿 ≠ 打包版能启动。issue #6 就是这种形态：
// 包能构建、能安装、CI 全绿，但打包版 preload 因外置依赖缺失而失败 ⇒ 窗口在、渲染器不挂载。
//
// 断言（三条都是硬门，任一失败退出码 1）：
//   1. `window.zcode` 由 preload 通过 contextBridge 暴露（packages/desktop/src/preload/index.ts:231），
//      打包版 preload 加载失败时它不存在 —— 这是「打包缺依赖」最直接的信号；
//   2. `#root` 有子节点（renderer 真挂载了 React，不是白屏）；
//   3. 主进程日志出现 `dom-ready fired`（启动链走到了窗口创建）。
//
// 零新依赖：只用 Node 24 内置的 `fetch` 与全局 `WebSocket`（undici），不依赖 playwright。
// 有意不做像素/截图断言：CI runner 无 GPU、跑在 Xvfb 里，像素判据引入的是环境噪声而不是产品信号；
// 本脚本防的是「启动链/preload/渲染挂载」类回归，不防 DWM/合成类问题（那是真机才能看的现象）。
//
// 用法：
//   node scripts/desktop-startup-smoke.mjs --app-dir packages/desktop/dist/linux-unpacked
//   node scripts/desktop-startup-smoke.mjs --app-dir <解包目录> [--timeout 45000] [--port 23456]
//        [--data-dir <dir>] [--executable <路径或文件名>]
//
// 参数：
//   --app-dir     必填。解包后的产物目录（linux-unpacked / win-unpacked / 含 *.app 的目录）
//   --timeout     整体超时（毫秒），默认 45000；从 spawn 起算，覆盖「等 target + 跑断言」
//   --port        CDP 调试端口，默认在 20000-30000 里挑一个空闲端口
//   --data-dir    应用数据根（对应 ZCODE_DATA_BASE_DIR），默认 mkdtemp；显式传入时不删除，便于事后看日志
//   --executable  可执行文件路径或文件名；缺省按平台从 app-dir 推断
//
// 退出码：0 = 三条断言全过；1 = 任一失败或启动失败（失败时打印 stdout/stderr/应用日志尾部与 CDP 异常）。

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const DEFAULT_TIMEOUT_MS = 45_000;
const PORT_RANGE = { min: 20_000, max: 30_000 };
const POLL_INTERVAL_MS = 250;
// 失败诊断只留尾部：完整 stderr 可能有上万行（Chromium 噪声），全打出来反而看不到关键信息。
const TAIL_LINES = 40;

function usage() {
  return [
    "用法: node scripts/desktop-startup-smoke.mjs --app-dir <解包目录> [选项]",
    "  --app-dir <dir>       必填，解包后的产物目录（linux-unpacked / win-unpacked / 含 *.app 的目录）",
    `  --timeout <ms>        整体超时，默认 ${DEFAULT_TIMEOUT_MS}`,
    `  --port <n>            CDP 端口，默认在 ${PORT_RANGE.min}-${PORT_RANGE.max} 内挑空闲端口`,
    "  --data-dir <dir>      应用数据根（ZCODE_DATA_BASE_DIR），默认临时目录",
    "  --executable <name>   可执行文件路径或文件名，默认按平台推断",
  ].join("\n");
}

function fail(message) {
  throw new SmokeError(message);
}

class SmokeError extends Error {}

function parseArgs(argv) {
  const options = {
    appDir: undefined,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    port: undefined,
    dataDir: undefined,
    executable: undefined,
  };
  const takeValue = (name, value) => {
    if (value === undefined || value.startsWith("--")) {
      fail(`参数 ${name} 缺少取值\n${usage()}`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--app-dir":
        options.appDir = takeValue(arg, argv[(index += 1)]);
        break;
      case "--timeout": {
        const raw = takeValue(arg, argv[(index += 1)]);
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed <= 0) fail(`--timeout 必须是正数，收到 ${raw}`);
        options.timeoutMs = parsed;
        break;
      }
      case "--port": {
        const raw = takeValue(arg, argv[(index += 1)]);
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
          fail(`--port 必须是 1-65535 的整数，收到 ${raw}`);
        }
        options.port = parsed;
        break;
      }
      case "--data-dir":
        options.dataDir = resolve(takeValue(arg, argv[(index += 1)]));
        break;
      case "--executable":
        options.executable = takeValue(arg, argv[(index += 1)]);
        break;
      case "--help":
      case "-h":
        console.log(usage());
        process.exit(0);
        break;
      default:
        fail(`未知参数：${arg}\n${usage()}`);
    }
  }

  if (!options.appDir) fail(`缺少必填参数 --app-dir\n${usage()}`);
  options.appDir = resolve(options.appDir);
  return options;
}

async function isFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function isExecutableFile(filePath) {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return false;
    // Windows 没有执行位概念；该分支只服务于 linux/mac 的推断。
    return (info.mode & 0o111) !== 0 && info.size > 1_048_576;
  } catch {
    return false;
  }
}

/**
 * 推断要启动的可执行文件。
 *
 * 为什么按「体积最大」而不是按固定名字：产物名由 electron-builder 的 productName/executableName 决定
 * （Linux 是 `zcode-ce`，Windows 是 `<productName>.exe`），而 --app-dir 可能是任意解包路径。
 * Electron 主二进制是目录里最大的可执行文件（约 180-220 MB），比写死名字更能跟随产品身份改名。
 */
async function resolveExecutable(options) {
  if (options.executable) {
    const candidate = isAbsolute(options.executable)
      ? options.executable
      : join(options.appDir, options.executable);
    if (!(await isFile(candidate))) fail(`--executable 指向的文件不存在：${candidate}`);
    return candidate;
  }

  const entries = await readdir(options.appDir, { withFileTypes: true });
  const names = entries.filter((entry) => !entry.isDirectory()).map((entry) => entry.name);

  if (process.platform === "win32") {
    const exeNames = names.filter((name) => name.toLowerCase().endsWith(".exe"));
    if (exeNames.length === 0) fail(`app-dir 下没有 .exe：${options.appDir}`);
    const sized = await Promise.all(
      exeNames.map(async (name) => ({ name, size: (await stat(join(options.appDir, name))).size })),
    );
    sized.sort((left, right) => right.size - left.size);
    return join(options.appDir, sized[0].name);
  }

  if (process.platform === "darwin") {
    // 允许 --app-dir 直接指向 .app 或它的父目录。
    const appName = options.appDir.endsWith(".app")
      ? basename(options.appDir)
      : (await readdir(options.appDir, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"))
          .map((entry) => entry.name)[0];
    if (!appName) fail(`app-dir 下没有 .app：${options.appDir}`);
    const appRoot = options.appDir.endsWith(".app")
      ? options.appDir
      : join(options.appDir, appName);
    const macOsDir = join(appRoot, "Contents", "MacOS");
    const macOsEntries = await readdir(macOsDir);
    const binaries = [];
    for (const name of macOsEntries) {
      const fullPath = join(macOsDir, name);
      if (await isExecutableFile(fullPath)) binaries.push({ name, fullPath });
    }
    if (binaries.length === 0) fail(`.app 内没有可执行主二进制：${macOsDir}`);
    return binaries[0].fullPath;
  }

  const candidates = await Promise.all(
    names.map(async (name) => ({
      name,
      executable: await isExecutableFile(join(options.appDir, name)),
    })),
  );
  const executables = candidates.filter((entry) => entry.executable);
  if (executables.length === 0) {
    fail(`app-dir 下没有可执行文件：${options.appDir}（可用 --executable 显式指定）`);
  }
  const sized = await Promise.all(
    executables.map(async ({ name }) => ({
      name,
      size: (await stat(join(options.appDir, name))).size,
    })),
  );
  sized.sort((left, right) => right.size - left.size);
  return join(options.appDir, sized[0].name);
}

/** 端口被占用时 CDP 会静默连不上，所以先真的 bind 一次确认可用。 */
async function pickFreePort(preferredPort) {
  const tryBind = (port) =>
    new Promise((resolvePromise, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen({ port, host: "127.0.0.1" }, () => {
        server.close(() => resolvePromise(true));
      });
    });

  if (preferredPort !== undefined) {
    try {
      await tryBind(preferredPort);
      return preferredPort;
    } catch {
      fail(`--port ${preferredPort} 不可用（已被占用或无权限）`);
    }
  }

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const candidate =
      PORT_RANGE.min + Math.floor(Math.random() * (PORT_RANGE.max - PORT_RANGE.min + 1));
    try {
      await tryBind(candidate);
      return candidate;
    } catch {
      // 撞上占用端口就换一个；不做固定重试次数以外的退避，避免掩盖异常环境。
    }
  }
  fail(`在 ${PORT_RANGE.min}-${PORT_RANGE.max} 内连续 30 次没找到空闲端口`);
}

function createOutputCollector(stream) {
  const chunks = [];
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    chunks.push(chunk);
    // 只保留尾部窗口，防止长跑把内存撑大（Chromium 日志可能是百万行级）。
    if (chunks.length > 2_000) chunks.splice(0, chunks.length - 2_000);
  });
  return () => chunks.join("");
}

function tailLines(text, lineCount = TAIL_LINES) {
  const lines = text.split(/\r?\n/u).filter((line) => line.trim() !== "");
  return lines.slice(-lineCount).join("\n");
}

/** 应用日志目录：getAppConfigDir()/logs = ${ZCODE_DATA_BASE_DIR}/.zcode/v2/logs。 */
function resolveAppLogDir(dataDir) {
  return join(dataDir, ".zcode", "v2", "logs");
}

async function readAppLogState(dataDir) {
  const logDir = resolveAppLogDir(dataDir);
  let names;
  try {
    names = (await readdir(logDir)).filter((name) => name.endsWith(".log"));
  } catch {
    return { logDir, matched: false, path: undefined, tail: "" };
  }
  if (names.length === 0) return { logDir, matched: false, path: undefined, tail: "" };

  // 按文件名排序（YYYY-MM-DD.log）比按 mtime 稳：跨天/时钟漂移时 mtime 会骗人。
  names.sort();
  const newest = names[names.length - 1];
  const filePath = join(logDir, newest);
  let content = "";
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return { logDir, matched: false, path: filePath, tail: "" };
  }
  return {
    logDir,
    path: filePath,
    matched: content.includes("dom-ready fired"),
    tail: tailLines(content),
  };
}

/** 最小 CDP 客户端：Node 24 的全局 WebSocket + 手写请求/响应配对，不引第三方库。 */
class CdpSession {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #closed = false;
  consoleLines = [];
  exceptions = [];

  static async connect(url) {
    const session = new CdpSession();
    session.#socket = new WebSocket(url);
    await new Promise((resolvePromise, reject) => {
      const onOpen = () => {
        cleanup();
        resolvePromise();
      };
      const onError = (event) => {
        cleanup();
        reject(new SmokeError(`CDP WebSocket 连接失败：${event?.message ?? "未知错误"}`));
      };
      const cleanup = () => {
        session.#socket.removeEventListener("open", onOpen);
        session.#socket.removeEventListener("error", onError);
      };
      session.#socket.addEventListener("open", onOpen);
      session.#socket.addEventListener("error", onError);
    });
    session.#socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      } catch {
        return;
      }
      if (message.id !== undefined) {
        const pending = session.#pending.get(message.id);
        if (!pending) return;
        session.#pending.delete(message.id);
        if (message.error) {
          pending.reject(new SmokeError(`CDP ${message.error.message ?? "调用失败"}`));
        } else {
          pending.resolve(message.result ?? {});
        }
        return;
      }
      session.#recordEvent(message);
    });
    // 目标被销毁（窗口关闭/渲染器崩溃）时连接会关闭：必须把挂起的请求一并 reject，
    // 否则调用方的 await 永不返回，整个冒烟会挂到 CI 的 step 超时，真实失败原因被掩盖。
    session.#socket.addEventListener("close", () =>
      session.#rejectAllPending("CDP 连接已关闭（页面目标被销毁？）"),
    );
    session.#socket.addEventListener("error", () => session.#rejectAllPending("CDP 连接出错"));
    return session;
  }

  #rejectAllPending(reason) {
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.reject(new SmokeError(reason));
    this.#pending.clear();
  }

  #recordEvent(message) {
    if (message.method === "Runtime.consoleAPICalled") {
      const { type, args = [] } = message.params ?? {};
      const text = args
        .map((arg) =>
          typeof arg.value === "string"
            ? arg.value
            : JSON.stringify(arg.value ?? arg.description ?? arg.type),
        )
        .join(" ");
      this.consoleLines.push(`[${type}] ${text}`);
      if (this.consoleLines.length > 500)
        this.consoleLines.splice(0, this.consoleLines.length - 500);
      return;
    }
    if (message.method === "Runtime.exceptionThrown") {
      const details = message.params?.exceptionDetails ?? {};
      const description = details.exception?.description ?? details.text ?? "未知异常";
      this.exceptions.push(String(description).split("\n").slice(0, 6).join("\n"));
      if (this.exceptions.length > 50) this.exceptions.splice(0, this.exceptions.length - 50);
    }
  }

  send(method, params = {}, timeoutMs = 10_000) {
    if (this.#closed) return Promise.reject(new SmokeError("CDP 连接已关闭"));
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise((resolvePromise, reject) => {
      // 每条 CDP 调用都必须有超时：目标半死（渲染器卡住/导航中）时协议层可能永不回包。
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new SmokeError(`CDP ${method} 超时（${timeoutMs}ms 未回包）`));
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolvePromise(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** 求值并取回可 JSON 序列化的值；页面正在导航时会抛，由调用方重试。 */
  async evaluate(expression, timeoutMs = 10_000) {
    const result = await this.send(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: false,
        userGesture: false,
      },
      timeoutMs,
    );
    const exception = result.exceptionDetails;
    if (exception) {
      const description = exception.exception?.description ?? exception.text ?? "求值抛错";
      throw new SmokeError(`页面求值失败：${String(description).split("\n")[0]}`);
    }
    return result.result?.value;
  }

  close() {
    try {
      this.#socket.close();
    } catch {
      // 关闭失败不影响判定。
    }
  }
}

async function waitForPageTarget(port, deadline, getExitInfo) {
  const listUrl = `http://127.0.0.1:${port}/json/list`;
  let lastError = "尚未请求";
  while (Date.now() < deadline) {
    const exitInfo = getExitInfo();
    if (exitInfo) {
      fail(
        `应用进程在出现 index.html 页面目标前退出（code=${exitInfo.code} signal=${exitInfo.signal}）；` +
          "主进程启动失败时通常就是这个形态",
      );
    }
    try {
      const response = await fetch(listUrl, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        const targets = await response.json();
        // 只认渲染器主窗口：另可能有 CUA 操作指示器/更新窗等 target（见 desktopWindowLifecycle）。
        const page = targets.find(
          (target) =>
            target?.type === "page" &&
            typeof target.url === "string" &&
            target.url.includes("index.html") &&
            typeof target.webSocketDebuggerUrl === "string",
        );
        if (page) return page;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  fail(
    `等待 CDP 页面目标超时（${listUrl}）——最后一次错误：${lastError}\n` +
      "排查方向：端口没起来（--no-sandbox/鉴权失败）、窗口没创建、或 index.html 未被加载",
  );
}

// 单次求值：把三条 DOM/preload 事实一次取回，避免分别求值时状态不一致。
const PROBE_EXPRESSION = `(() => {
  const zcode = window.zcode;
  const root = document.querySelector("#root");
  return {
    url: location.href,
    readyState: document.readyState,
    zcodeType: typeof zcode,
    zcodeKeyCount: zcode && typeof zcode === "object" ? Object.keys(zcode).length : 0,
    rootChildren: root ? root.childElementCount : -1,
  };
})()`;

async function runAssertions({ cdp, deadline, dataDir, getExitInfo }) {
  let probe;
  let logState = { matched: false, path: undefined, tail: "" };

  while (Date.now() < deadline) {
    const exitInfo = getExitInfo();
    if (exitInfo) {
      // 进程在断言期间退出：立刻失败，别等满超时（CI 上「等满 45 秒才报错」会把真实原因藏起来）。
      fail(`应用进程在断言期间退出（code=${exitInfo.code} signal=${exitInfo.signal}）`);
    }
    try {
      // 单次求值最多等 5 秒；页面导航/上下文重建会失败，由下一轮重试。
      probe = await cdp.evaluate(PROBE_EXPRESSION, 5_000);
    } catch {
      // 页面还在导航/上下文重建，重试到 deadline。
    }
    logState = await readAppLogState(dataDir);
    const zcodeReady = probe?.zcodeType === "object" && probe.zcodeKeyCount > 0;
    const rootReady = typeof probe?.rootChildren === "number" && probe.rootChildren > 0;
    if (zcodeReady && rootReady && logState.matched) break;
    await sleep(POLL_INTERVAL_MS);
  }

  const results = [
    {
      name: "window.zcode 已由 preload 暴露",
      passed: probe?.zcodeType === "object" && probe.zcodeKeyCount > 0,
      detail: `typeof=${probe?.zcodeType ?? "未取到"} keys=${probe?.zcodeKeyCount ?? 0}`,
    },
    {
      name: "#root 有子节点（renderer 已挂载）",
      passed: typeof probe?.rootChildren === "number" && probe.rootChildren > 0,
      detail:
        probe?.rootChildren === -1
          ? "找不到 #root 元素"
          : `childElementCount=${probe?.rootChildren ?? "未取到"}`,
    },
    {
      name: "主进程日志出现 dom-ready fired",
      passed: logState.matched === true,
      detail: logState.path ? `日志=${logState.path}` : "日志文件尚未生成",
    },
  ];
  return { results, probe, logState };
}

async function stopAppProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const waitForExit = async (ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) return true;
      await sleep(100);
    }
    return false;
  };

  if (process.platform === "win32") {
    // Windows 上 detached 不构成可整体 kill 的进程组；用 taskkill /T 收掉子进程树。
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    await waitForExit(3_000);
    return;
  }

  // detached: true 让 Electron 与其 host/agent 子进程在同一个新进程组里，杀组才能不残留。
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  if (await waitForExit(3_000)) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
  await waitForExit(3_000);
}

function printSection(title, body) {
  if (!body || body.trim() === "") return;
  console.error(`\n----- ${title} -----`);
  console.error(body.trimEnd());
}

function printDiagnostics({ stdout, stderr, logState, cdp, exitInfo }) {
  console.error("\n[smoke] 诊断信息：");
  if (exitInfo) console.error(`  进程退出：code=${exitInfo.code} signal=${exitInfo.signal}`);
  printSection(`stdout 尾部（最后 ${TAIL_LINES} 行）`, tailLines(stdout));
  printSection(`stderr 尾部（最后 ${TAIL_LINES} 行）`, tailLines(stderr));
  printSection(`应用日志尾部（${logState.logDir}）`, logState.tail);
  if (cdp?.exceptions?.length) printSection("CDP 页面异常", cdp.exceptions.join("\n---\n"));
  if (cdp?.consoleLines?.length) {
    // error 级 console 是 preload/renderer 失败时最直接的证据，优先打出来。
    const errors = cdp.consoleLines.filter((line) => /^\[(error|assert|warning)\]/u.test(line));
    printSection(
      "CDP console（error/warning）",
      (errors.length ? errors : cdp.consoleLines).slice(-20).join("\n"),
    );
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.appDir)) fail(`--app-dir 不存在：${options.appDir}`);

  const executable = await resolveExecutable(options);
  const port = await pickFreePort(options.port);
  const createdDataDir = options.dataDir === undefined;
  const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), "zcode-startup-smoke-")));

  console.log(`[smoke] 可执行文件：${executable}`);
  console.log(`[smoke] CDP 端口：${port}；数据根：${dataDir}；超时：${options.timeoutMs}ms`);

  let child;
  let cdp;
  let stdoutText = () => "";
  let stderrText = () => "";
  let exitInfo = null;
  let logState = { matched: false, logDir: resolveAppLogDir(dataDir), path: undefined, tail: "" };

  try {
    child = spawn(
      executable,
      ["--no-sandbox", "--disable-gpu", `--remote-debugging-port=${port}`],
      {
        // 隔离业务数据与 Electron userData：后者同时决定单实例锁身份，
        // 不隔离时本机已有的 ZCode-CE 会让本次启动直接退出（second-instance）。
        env: {
          ...process.env,
          ZCODE_DATA_BASE_DIR: dataDir,
          ZCODE_DESKTOP_USER_DATA_DIR: join(dataDir, "electron-userdata"),
        },
        stdio: ["ignore", "pipe", "pipe"],
        // Linux/mac 用独立进程组，便于连同 host/agent 子进程一起干净收掉。
        detached: process.platform !== "win32",
      },
    );
    stdoutText = createOutputCollector(child.stdout);
    stderrText = createOutputCollector(child.stderr);
    child.on("exit", (code, signal) => {
      exitInfo = { code, signal };
    });
    child.on("error", (error) => {
      exitInfo = { code: null, signal: null, error: error.message };
    });

    const deadline = Date.now() + options.timeoutMs;
    const target = await waitForPageTarget(port, deadline, () => exitInfo);
    console.log(`[smoke] 已找到页面目标：${target.url}`);

    cdp = await CdpSession.connect(target.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");

    const assertionResult = await runAssertions({
      cdp,
      deadline,
      dataDir,
      getExitInfo: () => exitInfo,
    });
    logState = assertionResult.logState;
    const { results, probe } = assertionResult;

    console.log("\n[smoke] 断言结果：");
    for (const result of results) {
      console.log(`  ${result.passed ? "PASS" : "FAIL"}  ${result.name}（${result.detail}）`);
    }
    if (probe) {
      console.log(`  页面：url=${probe.url} readyState=${probe.readyState}`);
    }

    const failed = results.filter((result) => !result.passed);
    if (failed.length > 0) {
      console.error(`\n[smoke] FAIL：${failed.length}/${results.length} 条断言未通过`);
      printDiagnostics({ stdout: stdoutText(), stderr: stderrText(), logState, cdp, exitInfo });
      return 1;
    }

    console.log("[smoke] PASS：打包版启动链、preload 桥与 renderer 挂载均正常");
    return 0;
  } catch (error) {
    console.error(`\n[smoke] FAIL：${error instanceof Error ? error.message : String(error)}`);
    logState = await readAppLogState(dataDir).catch(() => logState);
    printDiagnostics({ stdout: stdoutText(), stderr: stderrText(), logState, cdp, exitInfo });
    return 1;
  } finally {
    cdp?.close();
    await stopAppProcess(child);
    if (createdDataDir) {
      await rm(dataDir, { recursive: true, force: true }).catch(() => {});
    } else {
      console.log(`[smoke] 保留显式指定的数据目录：${dataDir}`);
    }
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    // 参数错误/环境问题都是 SmokeError：只打消息和用法，不打栈（栈会把真正要读的那行冲掉）。
    // 只有真正的意外（我们自己的 bug）才打印栈。
    if (error instanceof SmokeError) {
      console.error(`[smoke] FAIL：${error.message}`);
    } else {
      console.error(`[smoke] 内部错误：${error instanceof Error ? error.stack : String(error)}`);
    }
    process.exitCode = 1;
  });
