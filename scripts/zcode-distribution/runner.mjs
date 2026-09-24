#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const serverEntry = join(root, "server", "entry-http.js");
const webRoot = join(root, "web");
const agentEntry = join(root, "agent", "zcode.cjs");

function usage() {
  return `zcode-ce ${version}（内置 agent CLI: zcode-agent ${agentVersionLabel()}）

Usage:
  zcode --web [--host <host>] [--port <port>] [--workspace <path>] [--open|--no-open] [--token <token>|--no-token]
  zcode --version

Defaults:
  --host       127.0.0.1（只监听回环；要对外请传局域网 IP 或 0.0.0.0，那时必须带令牌）
  --port       3030（被占用时自动回退到空闲端口；启动日志始终打印实际地址）
  --workspace  当前目录
  --open       回环时开启，其它情况关闭
  令牌         回环默认关闭；非回环自动生成（--token=<值> 可指定）

环境变量（服务进程）：
  ZCODE_SERVER_AUTH_TOKEN        显式令牌，与令牌文件**并存、取并集**
  ZCODE_SERVER_AUTH_TOKENS_FILE  每行一条令牌的文件；SIGHUP 重载；文件空/坏 ⇒ 拒绝启动
  ZCODE_SERVER_TRUSTED_HOSTS     Host 白名单（挡 DNS rebinding），追加在回环+本机网卡+监听地址之后
  ZCODE_SERVER_TRUSTED_ORIGINS   跨源白名单（同源判定恒优先）
  ZCODE_SERVER_TRUSTED_PROXIES   可信代理（IP/CIDR），只有它们给的 X-Forwarded-For 被采信；默认谁都不信
  ZCODE_SERVER_CSP               缺省 report-only；可 off / enforce
  ZCODE_SERVER_HSTS              只在 https 且显式开启时下发
  数据目录                       ~/.zcode/v2（与桌面端共用）

Notes:
  --no-token 只允许与回环 host 组合（--no-token is only allowed with a loopback --host）：
  非回环绑定必须带令牌，否则服务端会拒绝启动。
  --web / --version 之外的参数会转发给内置 agent CLI（zcode-agent）。
`;
}
function readArgValue(argv, arg, index) {
  if (arg.includes("=")) {
    return { nextIndex: index, value: arg.slice(arg.indexOf("=") + 1) };
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${arg}`);
  }
  return { nextIndex: index + 1, value };
}

function parseArgs(argv) {
  const options = {
    command: "serve",
    host: "127.0.0.1",
    open: undefined,
    port: undefined,
    token: undefined,
    tokenEnabled: undefined,
    workspace: process.cwd(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.command = "help";
      continue;
    }
    if (arg === "--version" || arg === "-v") {
      options.command = "version";
      continue;
    }
    if (arg === "--host" || arg.startsWith("--host=")) {
      const parsed = readArgValue(argv, arg, index);
      options.host = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--port" || arg.startsWith("--port=")) {
      const parsed = readArgValue(argv, arg, index);
      options.port = Number(parsed.value);
      if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
        throw new Error("--port must be an integer between 0 and 65535");
      }
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--workspace" || arg.startsWith("--workspace=")) {
      const parsed = readArgValue(argv, arg, index);
      options.workspace = resolve(parsed.value);
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--open") {
      options.open = true;
      continue;
    }
    if (arg === "--no-open") {
      options.open = false;
      continue;
    }
    if (arg === "--token" || arg.startsWith("--token=")) {
      const parsed = readArgValue(argv, arg, index);
      options.token = parsed.value;
      options.tokenEnabled = true;
      index = parsed.nextIndex;
      continue;
    }
    if (arg === "--no-token") {
      options.tokenEnabled = false;
      continue;
    }
    throw new Error(`Unknown option "${arg}".\n${usage()}`);
  }

  // 组合级校验放在解析阶段：非回环 + 无 token 会被服务端 fail-closed 拒绝，
  // 这里提前给出一致的解释与两条可行路线。
  assertHostTokenCombination(options);

  return options;
}

function isLocalHost(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function shouldProtectHost(host) {
  return !isLocalHost(host);
}

/**
 * 是否启用并注入后端令牌。
 *
 * - `--token=<非空值>` ⇒ 启用；
 * - `--no-token`（或等价的 `--token=` 空值）⇒ 不启用；
 * - 未指定 ⇒ 非回环默认启用（与历史行为一致），回环默认不启用（本地开发）。
 *
 * 判定与启动前校验共用本函数，避免「校验说可以、实际注入的却是空 token」这类两套口径。
 */
function resolveTokenEnabled(options) {
  if (options.tokenEnabled === false) {
    return false;
  }
  if (options.tokenEnabled === true) {
    return Boolean(options.token?.trim());
  }
  return shouldProtectHost(options.host);
}

/**
 * 「非回环 + 无 token」必须在**解析参数阶段**就被拒绝。
 *
 * 服务端（packages/server 的 assertListenSecurity）对这一组合是 fail-closed 硬拒绝；
 * 如果放到这里才报错，用户会先看到「ZCode Web is running」的假象，再拿到二段错误。
 * 口径与服务端一致（不新增环境变量、不改服务端的硬拒绝）。
 */
function assertHostTokenCombination(options) {
  if (isLocalHost(options.host) || resolveTokenEnabled(options)) {
    return;
  }
  throw new Error(
    [
      `Refusing to start: --no-token cannot be combined with a non-loopback --host (${options.host}).`,
      `拒绝启动：绑定非回环地址 "${options.host}" 但未提供 token。`,
      "",
      "原因：不启用 token 时，服务端的 /api/*、/ws、/ws/host 对能访问该地址的人全部开放",
      "（其中 POST /api/rpc-host-capability 会未授权签发 trusted-host ticket），",
      "因此服务端本身也会拒绝启动 —— 这里提前报错，避免先起后拒。",
      "",
      "两种做法：",
      "  1. 只在本机用：不设 --host（默认 127.0.0.1），--no-token 仍然可用；",
      "  2. 要对外暴露：去掉 --no-token（非回环会自动生成令牌），或用 --token <token> 指定一个。",
    ].join("\n"),
  );
}

let cachedAgentVersion;

/** 内置 agent CLI 的版本：问它自己一次（只在 --help/--version 路径上发生），失败则返回 undefined。 */
async function resolveAgentVersion() {
  if (cachedAgentVersion !== undefined) {
    return cachedAgentVersion;
  }
  cachedAgentVersion = await new Promise((resolveVersion) => {
    const child = spawn(process.execPath, [agentEntry, "--version"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    const timer = globalThis.setTimeout(() => {
      child.kill("SIGKILL");
      resolveVersion(undefined);
    }, 10_000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", () => {
      globalThis.clearTimeout(timer);
      resolveVersion(undefined);
    });
    child.once("exit", () => {
      globalThis.clearTimeout(timer);
      resolveVersion(output.trim().split("\n")[0]?.trim() || undefined);
    });
  });
  return cachedAgentVersion;
}

/** 同步位置的标签：agent 版本是异步取的，未就绪时退化为占位说明。 */
function agentVersionLabel() {
  return typeof cachedAgentVersion === "string" && cachedAgentVersion
    ? cachedAgentVersion
    : "版本见下";
}

/** --version 输出：第一行保持原来的纯版本号（不破坏既有解析），第二行标注两个身份。 */
async function printVersion() {
  const agentVersion = await resolveAgentVersion();
  console.log(version);
  console.log(`zcode-ce ${version}（内置 agent CLI: zcode-agent ${agentVersion ?? "未知"}）`);
}
function createToken() {
  return randomBytes(24).toString("base64url");
}

/** 默认端口：先试 3030，被占用时回退到空闲端口（长期运行需要可预期端口，共享机又要避免碰撞）。 */
const DEFAULT_WEB_PORT = 3030;

async function pickDefaultPort(host) {
  try {
    await assertPortFree(host, DEFAULT_WEB_PORT);
    return DEFAULT_WEB_PORT;
  } catch {
    const fallback = await pickPort(host);
    console.log(`端口 ${DEFAULT_WEB_PORT} 已被占用，改用 ${fallback}（可用 --port 指定固定端口）`);
    return fallback;
  }
}

function assertPortFree(host, port) {
  return new Promise((resolveFree, rejectBusy) => {
    const server = createServer();
    server.once("error", rejectBusy);
    server.listen(port, host, () => {
      server.close((error) => (error ? rejectBusy(error) : resolveFree()));
    });
  });
}
function pickPort(host) {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePort(port);
      });
    });
  });
}

function formatUrl(host, port, token) {
  const displayHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const base = `http://${displayHost}:${port}/`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

function networkUrls(port, token) {
  const urls = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4") {
        continue;
      }
      const base = `http://${entry.address}:${port}/`;
      urls.push(token ? `${base}?token=${encodeURIComponent(token)}` : base);
    }
  }
  return urls;
}

function openBrowser(url) {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function assertRuntimeFiles() {
  for (const file of [serverEntry, agentEntry, webRoot]) {
    await access(file).catch((cause) => {
      throw new Error(`Missing runtime file: ${file}`, { cause });
    });
  }
}

async function serve(options) {
  await assertRuntimeFiles();
  const port =
    options.port && options.port > 0 ? options.port : await pickDefaultPort(options.host);
  const protect = resolveTokenEnabled(options);
  // 显式给了空 token（--token=）时按「抽到一个可用令牌」处理，避免 protect=true 却注入空值。
  const token = protect ? options.token?.trim() || createToken() : "";
  const open = options.open ?? isLocalHost(options.host);
  const localUrl = formatUrl(options.host, port, token);

  const child = spawn(process.execPath, [serverEntry], {
    cwd: options.workspace,
    env: {
      ...process.env,
      PORT: String(port),
      ZCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify([agentEntry, "app-server", "--stdio"]),
      ZCODE_AGENT_SERVER_COMMAND: process.execPath,
      ZCODE_SERVER_HOST: options.host,
      ZCODE_SERVER_WORKSPACE: options.workspace,
      ZCODE_WEB_STATIC_ROOT: webRoot,
      // 显式关闭 token 时必须清空继承值，否则 --no-token 仍会开启后端鉴权。
      ZCODE_SERVER_AUTH_TOKEN: token,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let shuttingDown = false;
  child.on("error", (error) => {
    console.error(`Unable to start Web server: ${error.message}`);
    process.exit(1);
  });

  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  child.on("exit", (code, signal) => {
    if (shuttingDown) {
      process.exit(0);
    }
    if (signal) {
      process.exit(1);
    }
    process.exit(code ?? 0);
  });

  console.log("");
  console.log("ZCode Web is running");
  console.log(`Local:   ${localUrl}`);
  if (options.host === "0.0.0.0" || options.host === "::") {
    for (const url of networkUrls(port, token)) {
      console.log(`Network: ${url}`);
    }
  }
  console.log("Press Ctrl+C to stop.");
  console.log("");

  if (open) {
    setTimeout(() => openBrowser(localUrl), 500);
  }

  const shutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    child.kill("SIGTERM");
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on("data", (chunk) => {
      if (chunk.includes(3)) {
        shutdown();
      }
    });
    process.stdin.on("error", () => {
      if (!shuttingDown) {
        shutdown();
      }
    });
  }
}

try {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && ["--version", "-v"].includes(argv[0])) {
    await printVersion();
  } else if (argv[0] === "--web") {
    const options = parseArgs(argv.slice(1));
    if (options.command === "help") {
      await resolveAgentVersion();
      console.log(usage());
    } else if (options.command === "version") await printVersion();
    else await serve(options);
  } else {
    if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) {
      const agentVersion = await resolveAgentVersion();
      console.log(`zcode-ce ${version}（内置 agent CLI: zcode-agent ${agentVersion ?? "未知"}）`);
      console.log("Web mode: zcode --web [options] (zcode --web --help for details)");
      console.log("以下帮助来自内置 agent CLI（它的版本号见上一行）：\n");
    }
    // CLI 自启动子进程依赖 argv[1]；统一指向真正的 Agent 入口，保留 TTY 与所有原始参数。
    process.argv[1] = agentEntry;
    await import(pathToFileURL(agentEntry).href);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
