import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * M1 验收判据 3 / 4 的真浏览器证据（task-30）。
 *
 * - **判据 3**：断线重连后侧栏可见集合仍在且逐条一致（复用 web-remote-replayable 的恢复语义）；
 *   同时未启动徽标 / 持久层会话数不得因重连而错乱。
 * - **判据 4**：两个**独立浏览器上下文**（各自 cookie / storage，非同一 context 的两次加载）
 *   对同一服务端的可见集合与会话数逐条一致；客户端设置（`lastWorkspaceSession`）**不参与枚举**
 *   —— 把它清空后可见集合不变。
 *
 * ## 数据隔离（重要）
 * 测试自己起真实服务端（`packages/server/dist/entry-http.js`），数据目录用 `ZCODE_DATA_BASE_DIR`
 * 指向 `mkdtemp` 出来的临时目录，**从不写用户真实 `~/.zcode`**。为了让 web 客户端能进入主界面
 * （否则停在登录门）并让注册表有真实数据，把下列文件**只读拷贝**进临时目录（随后 chmod 600，
 * 结束时整目录删除）：`credentials.json` / `provider_config.json` / `config.json` /
 * `model-providers.json` / `agents-state.json` / `onboarding-record.json` / `setting.json` /
 * `tasks-index.sqlite`（含 -wal/-shm）。拷贝的凭据只存在于 0700 临时目录内，不打印内容。
 *
 * ## 为什么这里的过期产物检查与 webLoadConsoleErrors 不同
 * 那条测试断言的是「某个**修复**在产物里生效」，产物早于源码就必须 skip。
 * 这里断言的是**已提交的 M1 行为**在产物里成立（M1.4 在 8a17bd4 就已进入构建），
 * 与源码是否更新无关，因此只要求 dist 存在；证据里记录 dist 的构建时间。
 */

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const webDist = join(repoRoot, "packages/web/dist");
const serverEntry = join(repoRoot, "packages/server/dist/entry-http.js");
const TOKEN = "task30-probe-token";
const ROW_SELECTOR = '[data-testid^="workspace-item-"]';

interface WorkspaceRowSnapshot {
  /** 行 `data-testid` 去掉前缀后的 workspace 路径（= 用户实际看到的行）。 */
  path: string;
  /** 行上的 runtime 徽标状态（未启动 / 启动中 / 启动失败 / null）。 */
  badge: string | null;
  /**
   * 该行**列出的会话条数**（`task-item-*`）。这是判据 4「各 workspace 的会话数一致」的
   * 主证据：runtime 未启动时这些行来自服务端持久层（tasks-index），与 runtime 无关。
   */
  taskItemCount: number;
  /** 未启动态文案里解析出的持久层会话数（「已有 N 个会话」）；无该文案时为 null。 */
  sessionCount: number | null;
}

interface SidebarSnapshot {
  rows: WorkspaceRowSnapshot[];
  /** 全侧栏列出的会话总数（用来证明「会话数比较」不是空断言）。 */
  totalTaskItems: number;
  /** 未启动态出现次数（有行没有会话可列时会显示它）。 */
  notStartedNoticeCount: number;
  hasConnectionOverlay: boolean;
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

/**
 * 删除临时数据目录。
 *
 * 服务端是 SIGKILL 掉的，内核回收句柄与文件写入之间可能有毫秒级窗口，rmSync 于是偶发
 * ENOTEMPTY。这里做有界重试，并把最终失败降级为诊断而不是让测试失败 —— 清理不成功不影响
 * 「断言是否成立」，但它必须被看见（不静默）。
 */
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

const COPIED_FILES = [
  "credentials.json",
  "provider_config.json",
  "config.json",
  "model-providers.json",
  "agents-state.json",
  "onboarding-record.json",
  "setting.json",
];

function prepareIsolatedDataDir(): string {
  const dataDir = mkdtempSync(join(tmpdir(), "zcode-task30-"));
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

/** 每个端口上服务端进程的输出尾部：启动失败时用于给出原因，而不是只报「等待超时」。 */
const serverOutputByPort = new Map<number, string>();

function startServer(params: { port: number; dataDir: string }): ChildProcess {
  serverOutputByPort.set(params.port, "");
  const child = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(params.port),
      ZCODE_SERVER_HOST: "127.0.0.1",
      ZCODE_WEB_STATIC_ROOT: webDist,
      ZCODE_DATA_BASE_DIR: params.dataDir,
      ZCODE_SERVER_AUTH_TOKEN: TOKEN,
    },
    // 启动失败必须能看到原因：输出留尾部，超时错误里带出来（不是只报「等待超时」）。
    stdio: ["ignore", "pipe", "pipe"],
  });
  const record = (chunk: unknown) => {
    const current = serverOutputByPort.get(params.port) ?? "";
    serverOutputByPort.set(params.port, (current + String(chunk)).slice(-4000));
  };
  child.stdout?.on("data", record);
  child.stderr?.on("data", record);
  return child;
}

async function waitForServerReady(baseUrl: string, timeoutMs: number, port: number): Promise<void> {
  await waitFor(
    "服务端就绪：" +
      baseUrl +
      "（进程输出尾部：" +
      (serverOutputByPort.get(port) ?? "").split("\n").slice(-12).join(" | ") +
      "）",
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
    timeoutMs,
  );
}

/**
 * 确保工作区行都展开。
 *
 * 为什么必须展开：行内的会话列表与未启动态都渲染在 `CollapsibleContent` 里，收起时不挂载 ——
 * 不展开就只能比较「行集合」，判据 4 的「会话数一致」会退化成空断言。
 * 这里只按**结果**判断（尝试点「展开全部」，然后看是否真的有行渲染出内容），
 * 不硬绑定那个开关控件本身：本轮 UI 归手机批次在改，绑定控件会把我的断言变成它们的负担。
 */
async function countRowsWithContent(page: import("playwright-core").Page): Promise<number> {
  return await page.evaluate(
    (selector) =>
      [...document.querySelectorAll(selector)].filter((trigger) => {
        // data-testid 挂在行的 CollapsibleTrigger（div[role=button]）上，会话列表与未启动态在
        // 它的兄弟节点 CollapsibleContent 里 —— 必须回到外层 <li> 再查，否则永远查不到内容。
        const row = trigger.closest("li") ?? trigger;
        return (
          row.querySelectorAll('[data-testid^="task-item-"]').length > 0 ||
          Boolean(row.querySelector('[data-testid="workspace-runtime-not-started"]'))
        );
      }).length,
    ROW_SELECTOR,
  );
}

async function ensureWorkspaceRowsExpanded(page: import("playwright-core").Page): Promise<boolean> {
  // 先等：默认展开时内容会自己出现（实测 ~2-5 秒内即有 23 条会话 + 8 处未启动态）。
  // **只有一行内容都没有时才去点「展开全部」** —— 那个开关的文案在 hydrate 过渡期会复用上一帧
  // 展示模型（见 taskGroupTogglePresentation 的 transitionPending 分支），无脑点击可能把
  // 已经展开的列表整体收起，反而制造出「列表空」的假象。
  let lastFailure: unknown = null;
  const pollContent = async (timeoutMs: number): Promise<boolean> => {
    try {
      await waitFor(
        "工作区行渲染出内容（会话列表或未启动态）",
        async () => (await countRowsWithContent(page)) > 0,
        timeoutMs,
      );
      return true;
    } catch (error) {
      // 不吞错：把真实原因留在 lastFailure 里，由调用方在最终失败时抛出（避免只看到一句
      // 「expanded=false」而丢掉「evaluate 抛错」这类真正的原因）。
      lastFailure = error;
      return false;
    }
  };
  if (await pollContent(20_000)) return true;
  const expandAll = page.getByRole("button", { name: "展开全部" }).first();
  if ((await expandAll.count()) > 0) {
    await expandAll.click();
    if (await pollContent(20_000)) return true;
  }
  const rows = await page.locator(ROW_SELECTOR).count();
  const globalCounts = await page.evaluate(() => ({
    taskItems: document.querySelectorAll('[data-testid^="task-item-"]').length,
    tabStripCount: document.querySelectorAll('[role="tablist"] [role="tab"]').length,
    notStarted: document.querySelectorAll('[data-testid="workspace-runtime-not-started"]').length,
    badges: document.querySelectorAll("[data-workspace-runtime-badge]").length,
    firstRowText: (document.querySelector('[data-testid^="workspace-item-"]')?.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120),
  }));
  throw new Error(
    `工作区行始终没有渲染内容（行数=${rows}）：${lastFailure instanceof Error ? lastFailure.message : String(lastFailure)} 现场=${JSON.stringify(globalCounts)}`,
  );
}

async function readSidebarSnapshot(page: import("playwright-core").Page): Promise<SidebarSnapshot> {
  return await page.evaluate((selector) => {
    const rows = [...document.querySelectorAll(selector)].map((trigger) => {
      // 同 countRowsWithContent：testid 在触发器上，内容在兄弟节点里，统一回到外层 <li>。
      const row = trigger.closest("li") ?? trigger;
      const badge = row.querySelector("[data-workspace-runtime-badge]");
      const notice = row.querySelector('[data-testid="workspace-runtime-not-started"]');
      const text = notice?.textContent?.replace(/\s+/g, " ").trim() ?? null;
      const matched = text ? /已有 (\d+) 个会话/.exec(text) : null;
      return {
        path: (trigger.getAttribute("data-testid") ?? "").replace(/^workspace-item-/, ""),
        badge: badge?.getAttribute("data-workspace-runtime-badge") ?? null,
        taskItemCount: row.querySelectorAll('[data-testid^="task-item-"]').length,
        sessionCount: matched ? Number(matched[1]) : null,
      };
    });
    return {
      rows,
      totalTaskItems: rows.reduce((sum, row) => sum + row.taskItemCount, 0),
      notStartedNoticeCount: document.querySelectorAll(
        '[data-testid="workspace-runtime-not-started"]',
      ).length,
      hasConnectionOverlay: Boolean(
        document.querySelector('[data-testid="web-connection-overlay"]'),
      ),
    };
  }, ROW_SELECTOR);
}

/**
 * 比较「集合与事实」，不比较显示顺序（顺序由客户端显示偏好决定，不属于判据 4 的集合口径）。
 *
 * `transientStarting`：重连/首次加载的过渡期里，活跃 workspace 的 sessions-index 订阅正在重建
 * （store status = connecting），行上会短暂出现「启动中」。这是**正确**的过渡态（§3.2 要求
 * 启动中显示加载态而不是「暂无任务」），不属于「未启动被错乱标记」，因此比较时忽略它；
 * 但 `not-started` 绝不能凭空出现或消失 —— 那才是判据 3 要防的错乱。
 */
function collectVisibleSetMismatches(
  left: SidebarSnapshot,
  right: SidebarSnapshot,
  options: { transientStarting: boolean },
): string[] {
  const mismatches: string[] = [];
  const leftPaths = left.rows.map((row) => row.path).sort();
  const rightPaths = right.rows.map((row) => row.path).sort();
  if (leftPaths.join("\n") !== rightPaths.join("\n")) {
    mismatches.push(
      "可见集合不一致：仅左侧 " +
        JSON.stringify(leftPaths.filter((path) => !rightPaths.includes(path))) +
        " / 仅右侧 " +
        JSON.stringify(rightPaths.filter((path) => !leftPaths.includes(path))),
    );
  }
  const leftByPath = new Map(left.rows.map((row) => [row.path, row]));
  for (const row of right.rows) {
    const previous = leftByPath.get(row.path);
    if (!previous) continue;
    if (row.taskItemCount !== previous.taskItemCount) {
      mismatches.push(
        `会话条数不一致 ${row.path}：${previous.taskItemCount} → ${row.taskItemCount}`,
      );
    }
    if (row.sessionCount !== previous.sessionCount) {
      mismatches.push(
        `未启动态会话数不一致 ${row.path}：${previous.sessionCount} → ${row.sessionCount}`,
      );
    }
    const badgeDiffers = row.badge !== previous.badge;
    const isTransientPair =
      options.transientStarting &&
      (row.badge === "starting" || previous.badge === "starting") &&
      row.badge !== "not-started" &&
      previous.badge !== "not-started";
    if (badgeDiffers && !isTransientPair) {
      mismatches.push(`徽标状态不一致 ${row.path}：${previous.badge} → ${row.badge}`);
    }
  }
  if (right.notStartedNoticeCount !== left.notStartedNoticeCount) {
    mismatches.push(
      `未启动态出现次数不一致：${left.notStartedNoticeCount} → ${right.notStartedNoticeCount}`,
    );
  }
  return mismatches;
}

function assertSameVisibleSet(
  left: SidebarSnapshot,
  right: SidebarSnapshot,
  label: string,
  options: { transientStarting: boolean } = { transientStarting: false },
): void {
  const mismatches = collectVisibleSetMismatches(left, right, options);
  assert.deepEqual(mismatches, [], label + "：可见集合/会话数必须逐条一致");
  const leftPaths = left.rows.map((row) => row.path).sort();
  const rightPaths = right.rows.map((row) => row.path).sort();
  assert.deepEqual(rightPaths, leftPaths, label + "：可见集合必须逐条一致");
}

test("M1 判据 3/4：断线重连后列表仍在 + 两个独立客户端可见集合一致", async (t) => {
  if (!existsSync(join(webDist, "index.html")) || !existsSync(serverEntry)) {
    t.skip("缺少 packages/web/dist 或 packages/server/dist，跳过（先构建 web 与 server）");
    return;
  }
  const realDb = join(homedir(), ".zcode", "v2", "tasks-index.sqlite");
  if (!existsSync(realDb)) {
    t.skip("本机没有任务索引库（注册表数据源），跳过");
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
  const baseUrl = `http://127.0.0.1:${port}/`;
  const pageUrl = baseUrl + "?token=" + TOKEN;
  t.diagnostic("isolated ZCODE_DATA_BASE_DIR=" + dataDir);
  t.diagnostic(
    "packages/web/dist/index.html mtime=" +
      statSync(join(webDist, "index.html")).mtime.toISOString(),
  );

  let server: ChildProcess | null = null;
  const browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
  const closeAll = async () => {
    try {
      server?.kill("SIGKILL");
    } catch {
      // 已退出
    }
    await browser.close();
    await removeTempDir(dataDir, (message) => t.diagnostic(message));
  };

  try {
    server = startServer({ port, dataDir });
    await waitForServerReady(baseUrl, 60_000, port);
    const serverInfo = (await (await fetch(baseUrl + "api/server-info?token=" + TOKEN)).json()) as {
      workspaces: Array<{ path: string }>;
    };
    assert.ok(
      serverInfo.workspaces.length > 1,
      "注册表默认视图必须多于 1 个 workspace（否则本测试没有区分力）",
    );
    t.diagnostic("server-info.workspaces=" + serverInfo.workspaces.length);

    // ── 客户端 A（判据 3 与 4 的基准） ──
    const contextA = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const pageA = await contextA.newPage();
    const wsOpenedA: number[] = [];
    pageA.on("websocket", () => wsOpenedA.push(Date.now()));
    const consoleErrorsA: string[] = [];
    pageA.on("console", (message) => {
      if (message.type() === "error") consoleErrorsA.push(message.text());
    });
    await pageA.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await waitFor(
      "客户端 A 侧栏出现工作区行",
      async () => (await pageA.locator(ROW_SELECTOR).count()) > 0,
      60_000,
    );
    await ensureWorkspaceRowsExpanded(pageA);
    const before = await readSidebarSnapshot(pageA);
    assert.ok(before.rows.length > 1, "断线前必须有多个工作区行");
    assert.ok(
      before.totalTaskItems > 0,
      "必须真的列出持久层会话（runtime 未启动时也应从 tasks-index 列出）——否则判据 4 的「会话数一致」没有区分力",
    );
    t.diagnostic(
      `断线前：${before.rows.length} 行 / 列出会话 ${before.totalTaskItems} 条 / 未启动态 ${before.notStartedNoticeCount} 次 / 未启动徽标 ${before.rows.filter((row) => row.badge === "not-started").length} 个 / 覆盖层 ${before.hasConnectionOverlay}`,
    );

    // ── 判据 3：杀掉服务端（同端口、同令牌、同数据目录再起） ──
    const wsCountBeforeKill = wsOpenedA.length;
    server.kill("SIGKILL");
    server = null;
    await pageA.waitForTimeout(3_000);
    const during = await readSidebarSnapshot(pageA);
    t.diagnostic("断线中：覆盖层出现 = " + during.hasConnectionOverlay);

    server = startServer({ port, dataDir });
    await waitForServerReady(baseUrl, 60_000, port);
    await waitFor(
      "客户端 A 重新建立 WebSocket",
      () => wsOpenedA.length > wsCountBeforeKill,
      90_000,
    );
    await waitFor(
      "客户端 A 恢复后覆盖层消失",
      async () => !(await readSidebarSnapshot(pageA)).hasConnectionOverlay,
      60_000,
    );
    await waitFor(
      "客户端 A 恢复后侧栏仍有工作区行",
      async () => (await pageA.locator(ROW_SELECTOR).count()) > 0,
      60_000,
    );
    // 恢复需要收敛时间：重连后活跃 workspace 会短暂进入「启动中」（订阅重建），
    // 允许过渡态、但必须收敛回断线前的状态，否则判据 3 不成立。
    let after = await readSidebarSnapshot(pageA);
    let settled = false;
    await waitFor(
      "侧栏收敛回断线前状态",
      async () => {
        after = await readSidebarSnapshot(pageA);
        // 会话列表由 RPC 异步补齐，行数/条数没回来之前不算收敛。
        if (after.rows.length === 0 || after.totalTaskItems === 0) return false;
        settled =
          collectVisibleSetMismatches(before, after, { transientStarting: true }).length === 0;
        return settled;
      },
      90_000,
    ).catch(() => undefined);
    // 无论是否收敛，都用**严格口径**断言一次，让失败信息给出精确差异。
    assertSameVisibleSet(before, after, "判据 3（断线重连前后）");
    t.diagnostic("恢复后已收敛：" + settled);
    if (during.hasConnectionOverlay) {
      assert.equal(after.hasConnectionOverlay, false, "恢复后覆盖层必须消失");
    } else {
      t.diagnostic(
        "断线中未观察到 web-connection-overlay（可能被本轮 UI 改动改名）——该项退化为诊断，未做硬断言",
      );
    }
    t.diagnostic(
      `恢复后：${after.rows.length} 行 / 列出会话 ${after.totalTaskItems} 条 / 未启动态 ${after.notStartedNoticeCount} 次 / 覆盖层 ${after.hasConnectionOverlay}`,
    );
    t.diagnostic(
      "客户端 A console error 数：" +
        consoleErrorsA.length +
        " 首行样例：" +
        JSON.stringify(
          [...new Set(consoleErrorsA.map((text) => text.split("\n")[0]?.slice(0, 120)))].slice(
            0,
            4,
          ),
        ),
    );

    // ── 判据 4a：两个**独立**上下文（各自 cookie/storage） ──
    const contextB = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const pageB = await contextB.newPage();
    await pageB.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await waitFor(
      "客户端 B 侧栏出现工作区行",
      async () => (await pageB.locator(ROW_SELECTOR).count()) > 0,
      60_000,
    );
    await ensureWorkspaceRowsExpanded(pageB);
    await pageB.waitForTimeout(8_000);
    const snapshotB = await readSidebarSnapshot(pageB);
    assertSameVisibleSet(after, snapshotB, "判据 4（两个独立客户端）", { transientStarting: true });
    t.diagnostic(
      `两个独立上下文可见集合与会话数逐条一致：${snapshotB.rows.length} 行 / ${snapshotB.totalTaskItems} 条会话`,
    );

    // ── 判据 4b：客户端设置不参与枚举（清空 lastWorkspaceSession 后集合不变） ──
    const settingPath = join(dataDir, ".zcode", "v2", "setting.json");
    const settings = JSON.parse(readFileSync(settingPath, "utf8")) as Record<string, unknown>;
    settings["lastWorkspaceSession"] = [];
    settings["recentProjects"] = [];
    writeFileSync(settingPath, JSON.stringify(settings, null, 2));
    // 设置由服务端持有：重启服务端让新设置生效，再起一个全新上下文（= 新设备）。
    server.kill("SIGKILL");
    server = null;
    server = startServer({ port, dataDir });
    await waitForServerReady(baseUrl, 60_000, port);
    const contextC = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const pageC = await contextC.newPage();
    await pageC.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await waitFor(
      "客户端 C 侧栏出现工作区行",
      async () => (await pageC.locator(ROW_SELECTOR).count()) > 0,
      60_000,
    );
    await ensureWorkspaceRowsExpanded(pageC);
    await pageC.waitForTimeout(8_000);
    const snapshotC = await readSidebarSnapshot(pageC);
    assertSameVisibleSet(after, snapshotC, "判据 4（设置清空后的新客户端）", {
      transientStarting: true,
    });
    t.diagnostic(
      "清空 lastWorkspaceSession + recentProjects 后，新客户端仍看到 " +
        snapshotC.rows.length +
        " 行，且与客户端 A/B 逐条一致（可见集合没有因为设置清空而缩小或丢失）",
    );
    await contextA.close();
    await contextB.close();
    await contextC.close();
  } finally {
    await closeAll();
  }
});

test("反向验证：注册表内容不同 ⇒ 集合比较必须报出差异（证明断言有牙齿）", async (t) => {
  if (!existsSync(join(webDist, "index.html")) || !existsSync(serverEntry)) {
    t.skip("缺少构建产物，跳过");
    return;
  }
  const realDb = join(homedir(), ".zcode", "v2", "tasks-index.sqlite");
  if (!existsSync(realDb)) {
    t.skip("本机没有任务索引库，跳过");
    return;
  }
  const executablePath = resolveChromiumExecutable();
  if (!executablePath) {
    t.skip("未找到 chromium，跳过");
    return;
  }
  const { chromium } = await import("playwright-core");
  const { DatabaseSync } = await import("node:sqlite");

  // 剪掉三个 workspace 的任务行 —— 注册表随之变小，两个客户端的可见集合必然不同。
  // 只动**副本**，不碰用户真实库。
  const fullDir = prepareIsolatedDataDir();
  const trimmedDir = prepareIsolatedDataDir();
  // 两个副本都把客户端显式列表清空，隔离变量：这样可见集合**只**由服务端注册表决定，
  // 剪掉注册表里的条目就一定会在界面上少行（否则 tab 行会继续撑住集合，反向验证会变成空转）。
  for (const dir of [fullDir, trimmedDir]) {
    const settingPath = join(dir, ".zcode", "v2", "setting.json");
    const settings = JSON.parse(readFileSync(settingPath, "utf8")) as Record<string, unknown>;
    settings["lastWorkspaceSession"] = [];
    writeFileSync(settingPath, JSON.stringify(settings, null, 2));
  }
  const trimmedDb = new DatabaseSync(join(trimmedDir, ".zcode", "v2", "tasks-index.sqlite"));
  let trimmedPaths: string[] = [];
  try {
    // 取「最近活跃」的前 3 个 —— 它们必然落在注册表默认视图的 30 天窗口内，
    // 剪掉后默认视图一定变小（否则剪的是窗口外的条目，界面上本来就不显示）。
    trimmedPaths = (
      trimmedDb
        .prepare(
          "SELECT workspace_key FROM tasks WHERE deleted = 0 GROUP BY workspace_key ORDER BY MAX(updated_at) DESC LIMIT 3",
        )
        .all() as unknown as Array<{ workspace_key: string }>
    ).map((row) => row.workspace_key);
    for (const workspaceKey of trimmedPaths) {
      trimmedDb.prepare("DELETE FROM tasks WHERE workspace_key = ?").run(workspaceKey);
      trimmedDb.prepare("DELETE FROM workspace_registry WHERE workspace_key = ?").run(workspaceKey);
    }
  } finally {
    trimmedDb.close();
  }
  assert.ok(trimmedPaths.length > 0, "必须真的剪掉了一些 workspace（否则反向验证没有区分力）");
  t.diagnostic(
    "剪掉的工作区（仅 basename）：" +
      trimmedPaths.map((path) => path.split("/").filter(Boolean).pop()).join(", "),
  );

  const browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
  const servers: ChildProcess[] = [];
  const load = async (dataDir: string): Promise<SidebarSnapshot> => {
    const port = await allocateFreePort();
    const baseUrl = `http://127.0.0.1:${port}/`;
    servers.push(startServer({ port, dataDir }));
    await waitForServerReady(baseUrl, 60_000, port);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto(baseUrl + "?token=" + TOKEN, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await waitFor(
      "侧栏出现工作区行",
      async () => (await page.locator(ROW_SELECTOR).count()) > 0,
      60_000,
    );
    await ensureWorkspaceRowsExpanded(page);
    await page.waitForTimeout(6_000);
    const snapshot = await readSidebarSnapshot(page);
    await context.close();
    return snapshot;
  };
  try {
    const full = await load(fullDir);
    const trimmed = await load(trimmedDir);
    const mismatches = collectVisibleSetMismatches(full, trimmed, { transientStarting: true });
    t.diagnostic(
      `完整库 ${full.rows.length} 行 / 剪裁库 ${trimmed.rows.length} 行；比较报出差异 ${mismatches.length} 条`,
    );
    assert.ok(
      mismatches.length > 0,
      "注册表内容不同的两个客户端，集合比较必须报出差异 —— 否则前面那些一致性断言没有牙齿",
    );
    assert.ok(
      mismatches.some((entry) => entry.includes("可见集合不一致")),
      "差异里必须包含「可见集合不一致」（实际：" + JSON.stringify(mismatches.slice(0, 3)) + "）",
    );
  } finally {
    for (const server of servers) server.kill("SIGKILL");
    await browser.close();
    await removeTempDir(fullDir, (message) => t.diagnostic(message));
    await removeTempDir(trimmedDir, (message) => t.diagnostic(message));
  }
});
