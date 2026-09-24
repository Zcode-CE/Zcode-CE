#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const serverEntry = join(root, "server", "entry-http.js");
const webRoot = join(root, "web");
const agentEntry = join(root, "agent", "zcode.cjs");

// ── 已被拆出的旁路模块（task-49）────────────────────────────────────────────
// 注意**结构前提**：runner.mjs 曾被逐字节拷进分发包的 bin/zcode.mjs，而旁路模块不会自动跟过去。
// 因此 scripts/build-zcode.mjs 现在**显式把 runner-*.mjs 逐个拷进 bin/** ——
// 若新增旁路模块而忘了改那里，分发包会缺文件（这是拆分时最容易踩的坑）。
import {
  DEFAULT_HOST,
  formatUrl,
  isLocalHost,
  networkUrls,
  openBrowser,
  pickDefaultPort,
  shouldProtectHost,
} from "./runner-web.mjs";
import { configEnv, loadConfigFile } from "./runner-config.mjs";
import { resolveAgentVersion, setUsageContext, usage } from "./runner-usage.mjs";
// ── 身份头与 usage 文案：已拆到 runner-usage.mjs（整段原样搬，见该文件头注释）──────────────
setUsageContext({ packageVersion: version, agentEntry });

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
    host: undefined,
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

/** --version 输出：第一行保持原来的纯版本号（不破坏既有解析），第二行标注两个身份。 */
async function printVersion() {
  const agentVersion = await resolveAgentVersion();
  console.log(version);
  console.log(`zcode-ce ${version}（内置 agent CLI: zcode-agent ${agentVersion ?? "未知"}）`);
}
function createToken() {
  return randomBytes(24).toString("base64url");
}

// ── 进程编排：spawn 服务进程、转发输出、信号处理、退出码（本文件只留这一半）──────────────
async function assertRuntimeFiles() {
  for (const file of [serverEntry, agentEntry, webRoot]) {
    await access(file).catch((cause) => {
      throw new Error(`Missing runtime file: ${file}`, { cause });
    });
  }
}

// 优先级链：flag > env > 文件 > 默认（spec §2）。
function resolveOptions(options) {
  const file = loadConfigFile();
  // 下面的 fallback 常量来自 runner-web.mjs（默认地址/端口与端口回退策略同属"监听编排"）。
  const envHost = process.env.ZCODE_SERVER_HOST?.trim();
  const envPort = process.env.PORT?.trim();
  const envWorkspace = process.env.ZCODE_SERVER_WORKSPACE?.trim();
  const envPortNumber = envPort ? Number(envPort) : undefined;
  if (envPort && (!Number.isInteger(envPortNumber) || envPortNumber < 1 || envPortNumber > 65535)) {
    throw new Error(`环境变量 PORT 取值非法：期望 1–65535 的整数端口，实际 ${envPort}`);
  }
  const host = options.host ?? envHost ?? file.host ?? DEFAULT_HOST;
  const port = options.port ?? envPortNumber ?? file.port;
  const workspace = options.workspace ?? envWorkspace ?? file.workspace ?? process.cwd();
  const token = options.token ?? process.env.ZCODE_SERVER_AUTH_TOKEN?.trim() ?? file.token;
  const tokenEnabled = options.tokenEnabled ?? (file.noToken === true ? false : undefined);
  const open = options.open ?? file.open;
  const passthrough = {
    ...file,
    host: undefined,
    port: undefined,
    workspace: undefined,
    token: undefined,
    open: undefined,
    noToken: undefined,
  };
  return { ...options, host, port, workspace, token, tokenEnabled, open, file, passthrough };
}

async function serve(rawOptions) {
  const options = resolveOptions(rawOptions);
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
      ...configEnv(options.passthrough),
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
