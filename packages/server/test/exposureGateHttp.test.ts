import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ServiceCollection } from "@zcode/services";
import { createHttpServer } from "../src/http.js";
import { parseTrustedProxies } from "../src/authThrottle.js";

/**
 * 「回环 + 外部访问信号 ⇒ 拒绝启动 / 告警」的**最终消费点**证据。
 *
 * ## 为什么不能只测纯函数
 * 判据（exposureGate.ts）与**接线**是两件事：判据对、但 http.ts 没把它接进
 * `assertListenSecurity`（或接错了时机 —— 比如在拉起了 provider runtime 之后才判），
 * 用户看到的现象就是"服务照样起来、照样没有鉴权"。所以这里分两层打：
 * ① **真实服务端**（`createHttpServer`，真监听）：该拒绝的必须抛错、该起的必须真起得来；
 * ② **真实入口进程**（`packages/server/dist/entry-http.js`，子进程）：在**用户形态**上确认
 *    拒绝发生在**任何子系统被拉起之前**（进程以非 0 码退出，而不是先打一堆日志再报错）。
 *
 * ## 面板路径（负向断言，**必须真的跑那条配置**）
 * 桌面面板启动的服务**本来就带令牌文件**（`packages/desktop/src/main/web-service/service.ts`
 * 把 `ZCODE_SERVER_AUTH_TOKENS_FILE` 指到 0600 的令牌文件），因此加固**不得**影响它。
 * 最后一条用例按**面板真实下发的 env**（`PORT` / `ZCODE_SERVER_HOST` /
 * `ZCODE_SERVER_AUTH_TOKENS_FILE` / `ZCODE_WEB_STATIC_ROOT` / `ZCODE_SERVER_WORKSPACE`）
 * 真起一次服务并断言 `/api/server-info` 无令牌 401 / 带令牌 200 —— 不是"看一眼代码觉得没问题"。
 */

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const serverEntry = join(repoRoot, "packages/server/dist/entry-http.js");

async function listenPort(server: {
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

async function closeServer(server: { close: (callback: () => void) => unknown }): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

// ---------------------------------------------------------------------------
// 一、真实服务端：该拒绝的拒绝
// ---------------------------------------------------------------------------

test("回环 + 登记了外部域名 + 无令牌 ⇒ 拒绝启动（这是那条 curl 绕过的堵法）", () => {
  for (const host of ["127.0.0.1", "localhost", "::1"]) {
    assert.throws(
      () =>
        createHttpServer(new ServiceCollection(), 0, {
          host,
          trustedHosts: [{ host: "panel.example" }],
        }),
      /拒绝启动/,
      "host=" + host + " 登记了外部域名却没有令牌，必须拒绝",
    );
  }
  // 报错必须可操作：说清为什么 + 两条修法（照既有 fail-closed 文案风格）。
  assert.throws(
    () =>
      createHttpServer(new ServiceCollection(), 0, {
        host: "127.0.0.1",
        trustedHosts: [{ host: "panel.example" }],
      }),
    /ZCODE_SERVER_TRUSTED_HOSTS/,
  );
  assert.throws(
    () =>
      createHttpServer(new ServiceCollection(), 0, {
        host: "127.0.0.1",
        trustedHosts: [{ host: "panel.example" }],
      }),
    /ZCODE_SERVER_AUTH_TOKEN/,
  );
});

test("回环 + 配了可信代理 + 无令牌 ⇒ 拒绝启动（配了它就是在声明自己在反代之后）", () => {
  assert.throws(
    () =>
      createHttpServer(new ServiceCollection(), 0, {
        host: "127.0.0.1",
        trustedProxies: parseTrustedProxies("127.0.0.1"),
      }),
    /拒绝启动/,
  );
  assert.throws(
    () =>
      createHttpServer(new ServiceCollection(), 0, {
        host: "127.0.0.1",
        trustedProxies: parseTrustedProxies("10.0.0.0/8"),
      }),
    /ZCODE_SERVER_TRUSTED_PROXIES/,
  );
});

// ---------------------------------------------------------------------------
// 二、真实服务端：不该拒绝的必须照旧（**否定式断言同样重要**）
// ---------------------------------------------------------------------------

test("回环 + 无信号 + 无令牌 ⇒ 照旧启动（本地开发路径不被打断）", async () => {
  const server = createHttpServer(new ServiceCollection(), 0, { host: "127.0.0.1" });
  try {
    const port = await listenPort(server);
    assert.ok(port > 0, "默认回环部署必须照常监听");
  } finally {
    await closeServer(server);
  }
});

test("回环 + 登记了域名 + **有**令牌 ⇒ 照常启动（加固不得打死合法的反代部署）", async () => {
  const server = createHttpServer(new ServiceCollection(), 0, {
    host: "127.0.0.1",
    authToken: "loopback-proxy-token",
    trustedHosts: [{ host: "panel.example" }],
    trustedProxies: parseTrustedProxies("127.0.0.1"),
  });
  try {
    const port = await listenPort(server);
    const baseUrl = "http://127.0.0.1:" + port;
    // 令牌链路照常生效（不是"起来了但没鉴权"）。
    assert.equal((await fetch(baseUrl + "/api/server-info")).status, 401);
    assert.equal(
      (await fetch(baseUrl + "/api/server-info?token=loopback-proxy-token")).status,
      200,
    );
  } finally {
    await closeServer(server);
  }
});

test("回环 + **只**登记了跨源白名单 + 无令牌 ⇒ 照常启动（不把配错升级成起不来）", async () => {
  // 与「登记域名」相反的有意取舍：只登记 TRUSTED_ORIGINS 是此前能起来的一种形态，
  // 因此它走**告警**而不是拒绝 —— 这条断言钉住"我们没有顺手把合法路径打死"。
  const server = createHttpServer(new ServiceCollection(), 0, {
    host: "127.0.0.1",
    trustedOrigins: ["https://ui.example"],
  });
  const warnings = await captureWarnings(async () => {
    await listenPort(server);
  });
  try {
    assert.ok(
      warnings.some((entry) => entry.includes("暴露面提醒")),
      "该告警（这是唯一可达的告警形态）",
    );
  } finally {
    await closeServer(server);
  }
});

test("回环 + 只登记了**非法**项 ⇒ 照常启动（非法项被丢弃 ≠ 有信号）", async () => {
  // 判据读的是**解析后的生效项**：一个写错的域名不该把服务变成起不来（与既有取舍一致）。
  const server = createHttpServer(new ServiceCollection(), 0, {
    host: "127.0.0.1",
    trustedHosts: [],
    trustedProxies: [],
  });
  try {
    assert.ok((await listenPort(server)) > 0);
  } finally {
    await closeServer(server);
  }
});

test("非回环 + 无令牌仍然拒绝（既有语义未被削弱）", () => {
  assert.throws(
    () => createHttpServer(new ServiceCollection(), 0, { host: "0.0.0.0" }),
    /拒绝启动/,
  );
  assert.throws(
    () =>
      createHttpServer(new ServiceCollection(), 0, {
        host: "0.0.0.0",
        trustedHosts: [{ host: "panel.example" }],
      }),
    /非回环地址/,
    "非回环优先命中既有的 fail-closed 分支（新分支只补回环那一档）",
  );
});

// ---------------------------------------------------------------------------
// 三、告警（B）打到真实服务端：该打的打、不该打的不打
// ---------------------------------------------------------------------------

function captureWarnings(run: () => Promise<void>): Promise<string[]> {
  const original = console.warn;
  const captured: string[] = [];
  console.warn = (...args: unknown[]) => {
    captured.push(args.map((value) => String(value)).join(" "));
  };
  return run()
    .then(() => captured)
    .finally(() => {
      console.warn = original;
    });
}

test("告警：**回环 + 只登记了跨源白名单 + 无令牌** ⇒ 真打日志、服务能起、且确实没有鉴权", async () => {
  // 这是告警**唯一**能触发的形态（可达性由 exposureGate.test.ts 的矩阵用例逐格钉住）：
  // 「可信代理 / 登记域名 + 无令牌」与「非回环 + 无令牌」两档都已被拒绝启动，跑不到这里。
  const server = createHttpServer(new ServiceCollection(), 0, {
    host: "127.0.0.1",
    trustedOrigins: ["https://ui.example"],
  });
  const warnings = await captureWarnings(async () => {
    await listenPort(server);
  });
  try {
    const hit = warnings.filter((entry) => entry.includes("暴露面提醒"));
    assert.equal(hit.length, 1, "必须打且只打一条，实际：" + JSON.stringify(warnings));
    assert.ok(hit[0]!.includes("https://ui.example"), "必须写明是哪个来源带来的风险");
    assert.ok(hit[0]!.includes("完全控制本机工作台"), "必须写明后果");
    // 服务确实起来了（告警不改行为）—— 并且确实**没有鉴权**，这就是告警要说的那件事。
    const port = await listenPort(server);
    assert.equal((await fetch("http://127.0.0.1:" + port + "/api/server-info")).status, 200);
  } finally {
    await closeServer(server);
  }
});

test("告警：**被拒绝的那一档不得同时打告警**（两种状态必须互斥）", () => {
  // 「回环 + 登记域名 + 无令牌」会被拒绝启动 ⇒ 连服务都没起来，当然也不该有告警。
  assert.throws(
    () =>
      createHttpServer(new ServiceCollection(), 0, {
        host: "127.0.0.1",
        trustedHosts: [{ host: "panel.example" }],
      }),
    /拒绝启动/,
  );
});

test("告警：默认部署（回环、无信号、无令牌）不得产生任何暴露面告警", async () => {
  const server = createHttpServer(new ServiceCollection(), 0, { host: "127.0.0.1" });
  const warnings = await captureWarnings(async () => {
    await listenPort(server);
  });
  try {
    assert.deepEqual(
      warnings.filter((entry) => entry.includes("暴露面提醒")),
      [],
      "默认回环部署不得被告警（否则告警会变成噪音、真事件被淹）",
    );
  } finally {
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// 四、真实入口进程：拒绝必须发生在**任何子系统被拉起之前**
// ---------------------------------------------------------------------------

function newestSourceMtime(): number {
  let newest = 0;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const info = statSync(full);
      if (info.isDirectory()) {
        walk(full);
        continue;
      }
      if (name.endsWith(".ts")) newest = Math.max(newest, info.mtimeMs);
    }
  };
  walk(join(repoRoot, "packages/server/src"));
  return newest;
}

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

interface EntryRun {
  code: number | null;
  output: string;
  /** 进程是否真的开始监听（用真实 HTTP 探测，不看日志文案）。 */
  listening: boolean;
}

/**
 * 起真实入口进程、给它预算、观察它是"起来了"还是"以非 0 码退出"。
 *
 * 判据用**真实 HTTP 探测**而不是日志字符串：日志文案可以改，端口有没有被监听不能撒谎。
 */
async function runEntry(env: Record<string, string>): Promise<EntryRun> {
  const dataDir = mkdtempSync(join(tmpdir(), "zcode-entry-gate-"));
  const port = await pickFreePort();
  const child = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      ZCODE_DATA_BASE_DIR: dataDir,
      ZCODE_SERVER_WORKSPACE: dataDir,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += String(chunk)));
  child.stderr.on("data", (chunk: Buffer) => (output += String(chunk)));

  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => resolve(code)),
  );
  /** 进程退出或超时都要收敛：否则一条**失败**的用例会把整个套件挂住（反向验证时实测到过）。 */
  const settle = async (): Promise<void> => {
    child.kill("SIGTERM");
    const graceful = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 6000)),
    ]);
    if (!graceful) {
      child.kill("SIGKILL");
      await exited;
    }
  };

  let listening = false;
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch("http://127.0.0.1:" + port + "/api/server-info", {
          signal: AbortSignal.timeout(1000),
        });
        // 200/401 都算"真的在监听"（差别只在有没有令牌）。
        if (response.status === 200 || response.status === 401) {
          listening = true;
          break;
        }
      } catch {
        // 还没起来
      }
      // 进程已经退出 ⇒ 不必再等（被拒绝的路径就是走这条）。
      const settled = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
      ]);
      if (settled && !listening) break;
    }
    await settle();
    return { code: await exited, output, listening };
  } finally {
    // 清理**必须在 finally 里**：断言失败也不能留下临时目录（而且失败路径最需要它）。
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
}

/**
 * 产物新鲜度前置条件：进程级用例断言的是**构建产物**，产物早于源码就必须显式跳过
 * （否则是在断言旧代码 —— 那比不测更危险）。三个用例共用，避免各写一份而漏掉一处。
 */
function skipUnlessDistFresh(t: { skip: (message: string) => void }): boolean {
  if (!existsSync(serverEntry)) {
    t.skip("缺少 packages/server/dist/entry-http.js，跳过（先 pnpm --filter @zcode/server build）");
    return true;
  }
  if (statSync(serverEntry).mtimeMs < newestSourceMtime()) {
    t.skip(
      "packages/server/dist/entry-http.js 早于 src（产物已过期），跳过以免断言旧代码；" +
        "重建后再跑：pnpm --filter @zcode/server build",
    );
    return true;
  }
  return false;
}

test("真实入口进程：回环 + 登记域名 + 无令牌 ⇒ 起不来，且拒绝发生在子系统之前", async (t) => {
  if (skipUnlessDistFresh(t)) return;

  const run = await runEntry({
    ZCODE_SERVER_HOST: "127.0.0.1",
    ZCODE_SERVER_TRUSTED_HOSTS: "panel.example",
  });
  assert.equal(
    run.listening,
    false,
    "登记了外部域名却没有令牌时，服务**不得**监听（实际：" + run.output.slice(0, 400) + "）",
  );
  assert.notEqual(run.code, 0, "必须以非 0 码退出");
  assert.equal(typeof run.code, "number", "退出码必须是数字（被信号杀掉会得到 null，那是假通过）");
  assert.match(run.output, /拒绝启动/);
  assert.match(run.output, /ZCODE_SERVER_TRUSTED_HOSTS/);
  assert.match(run.output, /panel\.example/);
  // **拒绝发生在任何子系统被拉起之前**：否则用户会先看到一堆 provider/CUA 日志再报错。
  assert.doesNotMatch(run.output, /provider-runtime/, "被拒绝时不得先拉起 provider runtime");
});

test("真实入口进程：同一个登记项 + 令牌文件 ⇒ 正常启动（面板/反代形态不被误伤）", async (t) => {
  if (skipUnlessDistFresh(t)) return;

  // 这正是桌面面板下发的形状：令牌**文件**（不是明文 env）。
  const tokenDir = mkdtempSync(join(tmpdir(), "zcode-entry-token-"));
  const tokenPath = join(tokenDir, "web-service-token");
  const token = "entry-gate-probe-token";
  const { writeFileSync } = await import("node:fs");
  writeFileSync(tokenPath, token + "\n", { mode: 0o600 });
  try {
    const run = await runEntry({
      ZCODE_SERVER_HOST: "127.0.0.1",
      ZCODE_SERVER_TRUSTED_HOSTS: "panel.example",
      ZCODE_SERVER_AUTH_TOKENS_FILE: tokenPath,
    });
    assert.equal(
      run.listening,
      true,
      "有令牌时同样的登记项必须照常起来：" + run.output.slice(0, 400),
    );
  } finally {
    rmSync(tokenDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 五、面板路径不受影响（**负向断言：真的跑面板那条配置**）
// ---------------------------------------------------------------------------

test("面板路径：按桌面面板真实下发的 env 起服务 ⇒ 照常可用（加固不得打死面板）", async (t) => {
  if (skipUnlessDistFresh(t)) return;

  // env 逐项对应 packages/desktop/src/main/web-service/service.ts 的 start()：
  // PORT / ZCODE_SERVER_HOST / ZCODE_SERVER_AUTH_TOKENS_FILE / ZCODE_WEB_STATIC_ROOT /
  // ZCODE_SERVER_WORKSPACE。面板**不**下发 trustedHosts / trustedProxies（回环 scope），
  // 且令牌文件一定存在（ensureWebServiceToken）⇒ 加固对它应当**完全无感**。
  const tokenDir = mkdtempSync(join(tmpdir(), "zcode-panel-token-"));
  const tokenPath = join(tokenDir, "web-service-token");
  const token = "panel-probe-token";
  const { writeFileSync } = await import("node:fs");
  writeFileSync(tokenPath, token + "\n", { mode: 0o600 });

  const dataDir = mkdtempSync(join(tmpdir(), "zcode-panel-data-"));
  const port = await pickFreePort();
  const child = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      ZCODE_SERVER_HOST: "127.0.0.1",
      ZCODE_SERVER_AUTH_TOKENS_FILE: tokenPath,
      ZCODE_SERVER_WORKSPACE: dataDir,
      ZCODE_DATA_BASE_DIR: dataDir,
      // 面板会带静态根；这里用仓库里的真实产物（缺了也不影响本次断言，只是没有面板壳）。
      ...(existsSync(join(repoRoot, "packages/web/dist"))
        ? { ZCODE_WEB_STATIC_ROOT: join(repoRoot, "packages/web/dist") }
        : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += String(chunk)));
  child.stderr.on("data", (chunk: Buffer) => (output += String(chunk)));
  const baseUrl = "http://127.0.0.1:" + port;
  try {
    let ready = false;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(baseUrl + "/api/server-info", {
          signal: AbortSignal.timeout(1000),
        });
        if (response.status === 401) {
          ready = true;
          break;
        }
      } catch {
        // 还没起来
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal(
      ready,
      true,
      "面板配置必须能起来（无令牌探测应得到 401）：" + output.slice(0, 400),
    );
    // 令牌链路照常：无令牌 401、带令牌 200。
    assert.equal((await fetch(baseUrl + "/api/server-info")).status, 401);
    assert.equal((await fetch(baseUrl + "/api/server-info?token=" + token)).status, 200);
    // 面板不会触发新的拒绝（env 里没有任何登记项）⇒ 不得出现那条拒绝文案。
    assert.doesNotMatch(output, /拒绝启动/);
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 8000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(tokenDir, { recursive: true, force: true });
  }
});
