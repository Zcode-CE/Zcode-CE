import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * 真浏览器「加载不产生渲染错误」回归（task-29）。
 *
 * ## 为什么需要它
 * `packages/ui/test/hookOrderStability.test.ts` 只能钉住缺陷的**结构形态**（源码级）。
 * 真正被用户看到的现象只在真实浏览器里出现，而且**dev 与 prod 的表现不同**：
 *  - dev：React 额外打印 `React has detected a change in the order of Hooks called by …`；
 *  - prod：没有那条表，只有 `TypeError: Cannot read properties of undefined (reading 'length')`
 *    以及 `The above error occurred in the <OnboardingDialog> component`（子树被错误边界重建）。
 * 所以这一条必须在**构建产物 + 真实服务端**上跑，它才是最终消费点的证据。
 *
 * ## 运行方式
 *  - 已起动服务端时：`ZCODE_WEB_E2E_URL=http://host:port/`（此时只断言渲染错误类，
 *    不断言「控制台零 error」—— 用户自己的服务器可能缺 channel 而打印 RPC 噪音）；
 *  - 未提供 URL 时：若 `packages/web/dist` 与 `packages/server/dist/entry-http.js` 都存在、
 *    且构建产物**不早于**源码（否则断言的是旧产物），本测试会自己起一个隔离 `ZCODE_DATA_BASE_DIR`
 *    的服务端，并断言**控制台零 error**；
 *  - 前置条件不满足时 `t.skip` 并打印原因（显式跳过，不静默通过）。
 */

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const webDist = join(repoRoot, "packages/web/dist");
const serverEntry = join(repoRoot, "packages/server/dist/entry-http.js");

/** 缺陷的两个可观测指纹：React 内部读 undefined.length，以及它归属的渲染错误。 */
const RENDER_ERROR_PATTERNS = [
  /areHookInputsEqual/,
  /Cannot read properties of undefined \(reading 'length'\)/,
  /order of Hooks/,
  /The above error occurred in the </,
  /React subtree crashed/,
];

function newestMtimeMs(dir: string, predicate: (name: string) => boolean): number {
  let newest = 0;
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      const info = statSync(full);
      if (info.isDirectory()) {
        walk(full);
        continue;
      }
      if (predicate(name)) newest = Math.max(newest, info.mtimeMs);
    }
  };
  walk(dir);
  return newest;
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

async function waitForServerReady(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(baseUrl + "api/server-info", { cache: "no-store" });
      if (response.ok || response.status === 401) return;
    } catch {
      // 还没起来
    }
    if (Date.now() > deadline) throw new Error("服务端未在预算内就绪：" + baseUrl);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

interface ProbeResult {
  errors: string[];
  totalErrorCount: number;
}

async function probeConsoleErrors(params: {
  chromium: typeof import("playwright-core").chromium;
  executablePath: string;
  url: string;
  width: number;
  height: number;
  waitMs: number;
}): Promise<ProbeResult> {
  const browser = await params.chromium.launch({
    executablePath: params.executablePath,
    args: ["--no-sandbox"],
  });
  try {
    const context = await browser.newContext({
      viewport: { width: params.width, height: params.height },
    });
    const page = await context.newPage();
    const errors: string[] = [];
    let totalErrorCount = 0;
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      totalErrorCount += 1;
      errors.push(message.text());
    });
    page.on("pageerror", (error) => {
      totalErrorCount += 1;
      errors.push(error.stack ?? String(error));
    });
    await page.goto(params.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(params.waitMs);
    return { errors, totalErrorCount };
  } finally {
    await browser.close();
  }
}

test("加载 web 客户端不得出现渲染期错误（真浏览器，390×844 与 1440×900）", async (t) => {
  const executablePath = resolveChromiumExecutable();
  if (!executablePath) {
    t.skip("未找到 Playwright chromium，跳过（显式跳过，不等于通过）");
    return;
  }
  let chromium: typeof import("playwright-core").chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    t.skip("未安装 playwright-core，跳过（显式跳过，不等于通过）");
    return;
  }

  let baseUrl = process.env.ZCODE_WEB_E2E_URL?.trim() ?? "";
  // 只有「自己起服务端」时才断言控制台零 error；用户提供的 URL 可能带环境噪音。
  let assertNoConsoleErrorsAtAll = false;
  let stopServer: (() => void) | null = null;
  let cleanupDir: string | null = null;

  if (!baseUrl) {
    if (!existsSync(join(webDist, "index.html")) || !existsSync(serverEntry)) {
      t.skip(
        "缺少 packages/web/dist 或 packages/server/dist，跳过（先 pnpm --filter @zcode/web build 与 pnpm --filter @zcode/server build）",
      );
      return;
    }
    const distMtime = statSync(join(webDist, "index.html")).mtimeMs;
    const sourceMtime = Math.max(
      newestMtimeMs(join(repoRoot, "packages/ui/src"), (name) => /\.tsx?$/.test(name)),
      newestMtimeMs(join(repoRoot, "packages/web/src"), (name) => /\.tsx?$/.test(name)),
    );
    if (distMtime < sourceMtime && process.env.ZCODE_WEB_E2E_FORCE !== "1") {
      t.skip(
        "packages/web/dist 早于源码（构建产物已过期），跳过以免断言旧产物；重建后再跑：pnpm --filter @zcode/web build（" +
          "若在 CI 里刚构建完仍误判，可设 ZCODE_WEB_E2E_FORCE=1 强制断言）",
      );
      return;
    }
    if (distMtime < sourceMtime) {
      t.diagnostic(
        "ZCODE_WEB_E2E_FORCE=1：构建产物早于源码，仍按当前产物断言（结果可能代表旧代码）",
      );
    }
    const dataDir = mkdtempSync(join(tmpdir(), "zcode-web-console-"));
    cleanupDir = dataDir;
    const port = 38000 + Math.floor(Math.random() * 1000);
    baseUrl = `http://127.0.0.1:${port}/`;
    const child = spawn(process.execPath, [serverEntry], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PORT: String(port),
        ZCODE_SERVER_HOST: "127.0.0.1",
        ZCODE_WEB_STATIC_ROOT: webDist,
        // 隔离数据目录：不读写真实 ~/.zcode（测试不得改用户数据）。
        ZCODE_DATA_BASE_DIR: dataDir,
        ZCODE_SERVER_AUTH_TOKEN: "",
      },
      stdio: "ignore",
    });
    stopServer = () => child.kill("SIGKILL");
    assertNoConsoleErrorsAtAll = true;
    try {
      await waitForServerReady(baseUrl, 60_000);
    } catch (error) {
      stopServer();
      child.kill("SIGKILL");
      rmSync(dataDir, { recursive: true, force: true });
      throw error;
    }
  }

  try {
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 1440, height: 900 },
    ]) {
      const result = await probeConsoleErrors({
        chromium,
        executablePath,
        url: baseUrl,
        width: viewport.width,
        height: viewport.height,
        waitMs: 12_000,
      });
      const renderErrors = result.errors.filter((text) =>
        RENDER_ERROR_PATTERNS.some((pattern) => pattern.test(text)),
      );
      assert.deepEqual(
        renderErrors,
        [],
        `${viewport.width}x${viewport.height} 加载出现渲染期错误（hook 槽位错位会以 areHookInputsEqual 读 undefined.length 出现）`,
      );
      if (assertNoConsoleErrorsAtAll) {
        assert.deepEqual(
          result.errors,
          [],
          `${viewport.width}x${viewport.height} 控制台出现 error（自起服务端时要求零 error）`,
        );
      } else {
        t.diagnostic(
          `${viewport.width}x${viewport.height}: ${result.totalErrorCount} 条 console error（用户提供的 URL，只校验渲染错误类）`,
        );
      }
    }
  } finally {
    stopServer?.();
    if (cleanupDir) rmSync(cleanupDir, { recursive: true, force: true });
  }
});
