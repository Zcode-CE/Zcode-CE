import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * `window-controller` 通道噪音回归（task-32）。
 *
 * ## 现象与根因
 * 普通 Web 客户端（`/ws` = terminal-client）加载后会向 `window-controller` 发 RPC，而这条通道**只由
 * 桌面 Host 注册**（`packages/desktop/src/host/index.ts`），服务端入口 `entry-http → createLocalServices`
 * 不注册它 ⇒ 服务端每次加载打约 5 行 `Unknown channel: window-controller`（客户端 console 反而没有 error，
 * 因为它已静默降级到 fallback）。噪音本身不破坏功能，但会淹没真实排障信号。
 * 根因在 `packages/client/src/remoteServiceAccess.ts`：SDK 为**每个** channel 无条件建 proxy，
 * 使 `IServiceAccessor.windowControllerService?` 的可选语义对 RPC 客户端失效（消费方
 * `useGlobalTaskList` 的 `controller ? …` 永远走 truthy 分支）。
 *
 * ## 修法（在 web 平台层如实声明能力）
 * `packages/web/src/WebAppRoot.tsx` 的 `connect` 包一层：拿到 accessor 后返回
 * `{ ...services, windowControllerService: undefined }` —— 本宿主没有 window host ⇒ 该服务不存在，
 * 消费方走既有 fallback。**不是** try/catch 消音。
 *
 * ## 断言打在最终消费点
 * 不看源码、不看类型：自起隔离 `ZCODE_DATA_BASE_DIR` 的真实服务端 + 构建产物 + 真浏览器，
 * 390×844 与 1440×900 各加载一次，断言**服务端日志里 `Unknown channel: window-controller` 计数 = 0**。
 * 反向验证：把那 3 行改回原样并重建 ⇒ 计数回到 5/次 ⇒ 本条变红（已实测）。
 */

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const webDist = join(repoRoot, "packages/web/dist");
const serverEntry = join(repoRoot, "packages/server/dist/entry-http.js");
const TOKEN = "task32-probe-token";
const COPIED_FILES = [
  "credentials.json",
  "provider_config.json",
  "config.json",
  "model-providers.json",
  "agents-state.json",
  "onboarding-record.json",
  "setting.json",
];

async function waitFor(
  label: string,
  predicate: () => Promise<boolean> | boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("等待超时：" + label);
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

async function allocateFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function resolveChromiumExecutable(): string | null {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    join(process.env.HOME ?? "", ".cache/ms-playwright"),
  ].filter((value): value is string => Boolean(value));
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      if (!entry.startsWith("chromium-")) continue;
      const candidate = join(root, entry, "chrome-linux64/chrome");
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** 只读拷贝用户数据到临时目录：**从不写真实 `~/.zcode`**，凭据在 0700 临时目录内并 chmod 600。 */
function prepareIsolatedDataDir(): string {
  const dataDir = mkdtempSync(join(tmpdir(), "zcode-task32-"));
  const target = join(dataDir, ".zcode", "v2");
  mkdirSync(target, { recursive: true });
  const source = join(homedir(), ".zcode", "v2");
  for (const name of COPIED_FILES) {
    if (!existsSync(join(source, name))) continue;
    copyFileSync(join(source, name), join(target, name));
    try {
      chmodSync(join(target, name), 0o600);
    } catch {
      // 权限设置失败不影响隔离语义，忽略。
    }
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    const from = join(source, "tasks-index.sqlite" + suffix);
    if (existsSync(from)) copyFileSync(from, join(target, "tasks-index.sqlite" + suffix));
  }
  return dataDir;
}

/** 临时目录清理：SIGKILL 与内核回收句柄之间有窗口，ENOTEMPTY 做有界重试并如实上报。 */
async function removeTempDir(dir: string, diagnostic: (message: string) => void): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4) {
        diagnostic(
          "临时目录清理失败（不影响断言，请手工删除）：" +
            dir +
            " — " +
            (error instanceof Error ? error.message : String(error)),
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

test("加载 web 客户端不得向不存在的 window-controller 通道发 RPC（服务端日志零 Unknown channel）", async (t) => {
  if (!existsSync(join(webDist, "index.html")) || !existsSync(serverEntry)) {
    t.skip("缺少 packages/web/dist 或 packages/server/dist，跳过（先构建 web 与 server）");
    return;
  }
  const executablePath = resolveChromiumExecutable();
  if (!executablePath) {
    t.skip("未找到 Playwright chromium，跳过（显式跳过，不等于通过）");
    return;
  }
  const { chromium } = await import("playwright-core");
  const dataDir = prepareIsolatedDataDir();
  const port = await allocateFreePort();
  const baseUrl = "http://127.0.0.1:" + port + "/";
  t.diagnostic("isolated ZCODE_DATA_BASE_DIR=" + dataDir);

  let serverLog = "";
  let server: ChildProcess | null = null;
  const browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
  const countWindowControllerNoise = () =>
    serverLog
      .split("\n")
      .filter((line) => line.includes("Unknown channel") && line.includes("window-controller"))
      .length;

  try {
    server = spawn(process.execPath, [serverEntry], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PORT: String(port),
        ZCODE_SERVER_HOST: "127.0.0.1",
        ZCODE_WEB_STATIC_ROOT: webDist,
        ZCODE_DATA_BASE_DIR: dataDir,
        ZCODE_SERVER_AUTH_TOKEN: TOKEN,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const record = (chunk: unknown) => {
      serverLog += String(chunk);
    };
    server.stdout?.on("data", record);
    server.stderr?.on("data", record);
    await waitFor(
      "服务端就绪",
      async () => {
        try {
          const response = await fetch(baseUrl + "api/server-info?token=" + TOKEN, {
            cache: "no-store",
          });
          return response.ok;
        } catch {
          return false;
        }
      },
      60_000,
    );

    for (const viewport of [
      { width: 390, height: 844 },
      { width: 1440, height: 900 },
    ]) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      await page.goto(baseUrl + "?token=" + TOKEN, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      // 等到应用真的挂上（侧栏有行），否则「零噪音」可能只是还没发请求。
      await waitFor(
        viewport.width + "：应用挂载（侧栏出现工作区行）",
        async () => (await page.locator('[data-testid^="workspace-item-"]').count()) > 0,
        60_000,
      );
      await page.waitForTimeout(8_000);
      await context.close();
      assert.equal(
        countWindowControllerNoise(),
        0,
        viewport.width +
          "：服务端日志不得出现 Unknown channel: window-controller（实际日志尾部：" +
          serverLog
            .split("\n")
            .filter((line) => line.includes("Unknown channel"))
            .slice(-3)
            .join(" | ") +
          "）",
      );
    }
    t.diagnostic("390×844 与 1440×900 各加载一次后，window-controller 噪音计数 = 0");
  } finally {
    server?.kill("SIGKILL");
    await browser.close();
    await removeTempDir(dataDir, (message) => t.diagnostic(message));
  }
});
