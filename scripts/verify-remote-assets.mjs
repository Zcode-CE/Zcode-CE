#!/usr/bin/env node
/* eslint-disable max-lines */
/**
 * 端到端验收：把「装配好的发布根」当成远程资源 CDN，跑完整 connectRemote。
 *
 * 链路（与真实 SSH 远程工作区同一套代码，只是把 ssh2 传输换成同机的 POSIX 假后端）：
 *   读 <root>/<版本>/manifest-<平台>.json  → 按组件下载 + sha256 校验 → 上传"远端" →
 *   在"远端"起 zcode-server → 握手 → 建立 RPC 通道。
 *
 * 为什么要固化成脚本（而不是一次性探针）：
 *   1. 之前的一次性探针跑完不退出（残留句柄/子进程），超时被杀 ⇒ 这里显式收尾并 process.exit；
 *   2. "远端" HOME 重定向到临时目录，绝不碰真实 ~/.zcode；
 *   3. 退出码语义明确：0 = 全链路通过。
 *
 * 用法：
 *   node scripts/assemble-remote-assets.mjs            # 先装配
 *   pnpm exec tsx scripts/verify-remote-assets.mjs     # 再验收（需要 tsx：@zcode/server 的入口指向 TS 源码）
 *   可选：--root <发布根> --version <版本> --keep-temp
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { createReadStream } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

const args = parseArgs(process.argv.slice(2));
const rootDir = resolve(args.root ?? join(repoRoot, ".tmp/remote-assets-publish"));
const keepTemp = args.keepTemp === true;
const manifestVersion = args.version ?? resolveVersion();
const tempDir = mkdtempSync(join(tmpdir(), "zcode-remote-assets-verify-"));
const remoteHome = join(tempDir, "home");
const logPath = join(tempDir, "verify.log");

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--root") {
      parsed.root = argv[index + 1];
      index += 1;
    } else if (token === "--version") {
      parsed.version = argv[index + 1];
      index += 1;
    } else if (token === "--keep-temp") {
      parsed.keepTemp = true;
    } else {
      throw new Error(`未知参数：${token}`);
    }
  }
  return parsed;
}

function resolveVersion() {
  const packageVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;
  if (existsSync(join(rootDir, packageVersion, `manifest-${platformKey()}.json`))) {
    return packageVersion;
  }
  const candidates = existsSync(rootDir)
    ? readdirSync(rootDir).filter((name) =>
        existsSync(join(rootDir, name, `manifest-${platformKey()}.json`)),
      )
    : [];
  if (candidates.length === 1) {
    return candidates[0];
  }
  throw new Error(
    `无法确定发布版本：请先运行 node scripts/assemble-remote-assets.mjs，或用 --version 指定（发布根 ${rootDir}）`,
  );
}

/** 本机平台对应的远端 platformArch（与管理端 prepare-prebuilds.mjs 的命名一致）。 */
function platformKey() {
  const os =
    process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `${os}-${arch}`;
}

function log(line) {
  appendFileSync(logPath, `${line}\n`);
}

class LocalPosixBackend {
  #children = new Set();

  async detect() {
    const [platform, arch] = platformKey().split("-");
    return { platform, arch };
  }

  async upload(localPath, remotePath) {
    const target = this.#resolve(remotePath);
    mkdirSync(dirname(target), { recursive: true });
    appendFileSync(logPath, `[fake-remote] upload ${localPath} -> ${target}\n`);
    const { copyFileSync } = await import("node:fs");
    copyFileSync(localPath, target);
  }

  async exec(command) {
    appendFileSync(logPath, `[fake-remote] exec ${command.replace(/\n/gu, " | ")}\n`);
    const child = spawn("/bin/sh", ["-c", command], {
      env: { ...process.env, HOME: remoteHome },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#children.add(child);
    child.on("exit", () => this.#children.delete(child));
    const listeners = [];
    let fired = false;
    const onClose = (fn) => {
      listeners.push(fn);
      return { dispose: () => listeners.splice(listeners.indexOf(fn), 1) };
    };
    // 回调可能顺手 dispose 自己；先在快照上迭代，避免边遍历边改数组。
    const fire = (code) => {
      if (fired) return;
      fired = true;
      for (const fn of listeners.slice()) fn(code);
    };
    child.on("exit", (code) => fire(code ?? 0));
    child.on("error", () => fire(1));
    return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, onClose };
  }

  async exists(remotePath) {
    try {
      statSync(this.#resolve(remotePath));
      return true;
    } catch {
      return false;
    }
  }

  async readFile(remotePath) {
    return readFileSync(this.#resolve(remotePath), "utf8");
  }

  dispose() {}

  killChildren() {
    for (const child of this.#children) {
      try {
        child.kill("SIGTERM");
      } catch {
        // 已经退出
      }
    }
  }

  #resolve(remotePath) {
    if (remotePath === "~") return remoteHome;
    if (remotePath.startsWith("~/")) return join(remoteHome, remotePath.slice(2));
    return remotePath;
  }
}

const stats = { requests: [], downloads: 0 };

function createStaticServer(publishRoot) {
  return createServer((req, res) => {
    const rawPath = new URL(req.url ?? "/", "http://localhost").pathname;
    const urlPath = decodeURIComponent(rawPath);
    const filePath = join(publishRoot, normalize(urlPath).replace(/^(\.\.[/\\])+/u, ""));
    let size = 0;
    try {
      size = statSync(filePath).size;
    } catch {
      // 命中失败要能一眼看出是哪条候选 URL 404（客户端按"父级 root → 版本化路径"顺序探测，
      // 装配布局只满足其中一条时，另一条会正常 404）。
      stats.requests.push(`404 ${req.method} ${rawPath}`);
      log(`[static] 404 ${req.method} ${rawPath} (file=${filePath})`);
      res.writeHead(404, { "content-length": "0" });
      res.end();
      return;
    }
    if (!/\.tar\.gz$|manifest-.+\.json$/u.test(filePath)) {
      stats.requests.push(`403 ${req.method} ${rawPath}`);
      res.writeHead(403, { "content-length": "0" });
      res.end();
      return;
    }
    if (extname(filePath) === ".gz") stats.downloads += 1;
    stats.requests.push(`200 ${req.method} ${rawPath}`);
    log(`[static] 200 ${req.method} ${rawPath}`);
    res.writeHead(200, {
      "content-length": String(size),
      "content-type": "application/octet-stream",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(filePath).pipe(res);
  });
}

async function main() {
  mkdirSync(remoteHome, { recursive: true });
  const manifestPath = join(rootDir, manifestVersion, `manifest-${platformKey()}.json`);
  if (!existsSync(manifestPath)) {
    throw new Error(`发布根缺少平台 manifest：${manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.appVersion !== manifestVersion) {
    // 客户端 remoteAssetCache.ts:1264 会拒绝 appVersion 不一致的 manifest；这里提前给出可读原因。
    throw new Error(
      `manifest.appVersion(${manifest.appVersion}) 与待验收版本(${manifestVersion}) 不一致；客户端会直接拒绝（remoteAssetCache.ts:1264）`,
    );
  }
  // 客户端版本必须等于 manifest.appVersion，否则拿不到资源：这是硬约束，不是我们的测试技巧。
  globalThis.__ZCODE_VERSION__ = manifestVersion;

  const server = createStaticServer(rootDir);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  // 用相对路径而不是裸名 @zcode/server：scripts/ 不是 workspace 包，裸名解析不到 workspace 链接；
  // 而 packages/server/src 内部的 @zcode/server/remote/*.js 自引用由它自己的 package.json exports 解析。
  const { connectRemote } = await import("../packages/server/src/remote/connect.js");
  const backend = new LocalPosixBackend();
  let exitCode = 1;
  try {
    const connection = await connectRemote(backend, {
      remoteCdnBaseUrl: baseUrl,
      remoteCacheDir: join(tempDir, "cache"),
      deployLockMode: "caller-serialized",
      appVersion: manifestVersion,
      handshakeTimeout: 30_000,
      signal: AbortSignal.timeout(300_000),
    });
    await connection.disposeAndWait({ timeoutMs: 5_000 });
    exitCode = 0;
  } finally {
    backend.killChildren();
    backend.dispose();
    server.close();
  }
  return exitCode;
}

let exitCode = 1;
try {
  exitCode = await main();
  const manifestCount = stats.requests.filter((item) => item.includes("manifest-")).length;
  if (exitCode === 0) {
    console.log("RESULT: PASS");
    console.log(`  manifest 请求: ${manifestCount}`);
    console.log(`  组件下载(GET): ${stats.downloads}`);
    console.log(`  远端 HOME: ${remoteHome}`);
  } else {
    console.log("RESULT: FAIL（详见日志）");
  }
} catch (error) {
  console.error(`RESULT: FAIL — ${error instanceof Error ? error.message : String(error)}`);
  exitCode = 1;
} finally {
  if (!keepTemp) {
    rmSync(tempDir, { recursive: true, force: true });
  }
  console.log(
    keepTemp ? `日志与临时目录保留在 ${tempDir}` : `日志已随临时目录清理（--keep-temp 可保留）`,
  );
  // 显式退出：假后端会留下 ssh2/子进程类的句柄，靠事件循环自然退出会挂住（一次性探针就踩过）。
  process.exit(exitCode);
}
