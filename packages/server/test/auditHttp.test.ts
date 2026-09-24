import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { ServiceCollection } from "@zcode/services";
import {
  ROUTE_POLICY,
  assertRoutePolicyEnforced,
  createHttpServer,
  type HttpServerOptions,
} from "../src/http.js";
import { createAuditLog } from "../src/auditLog.js";
import { createAuthThrottle } from "../src/authThrottle.js";

/**
 * 审计埋在真实服务端的链路上一遍（task-46 / B1），以及路由标注的一致性（G11）。
 *
 * 为什么用真实服务端而不是单测中间件：审计的价值在于「**真的发生了**」——
 * 只有把事件埋在真实请求/真实 WS 升级的那条路径上，才能证明"出事时账本里有这条"。
 * 本文件同时承担**否定式断言**：用**真实令牌字符串**反向搜索整份审计文本，必须搜不到。
 *
 * 反向验证（实测）：去掉 http.ts 里任一 `audit.record` 调用 ⇒ 对应事件断言变红。
 */

const TOKEN = "audit-probe-token-should-never-appear-in-logs";
const SECRET_MARKER = TOKEN;

interface CapturedAudit {
  audit: ReturnType<typeof createAuditLog>;
  text: () => string;
  events: (kind?: string) => Record<string, unknown>[];
}

function captureAudit(): CapturedAudit {
  const lines: string[] = [];
  const audit = createAuditLog({
    write: (line) => {
      lines.push(line);
    },
  });
  const parse = (): Record<string, unknown>[] =>
    lines.map((line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>);
  return {
    audit,
    text: () => lines.join("\n"),
    events: (kind?: string) =>
      kind === undefined ? parse() : parse().filter((event) => event.kind === kind),
  };
}

async function withServer<T>(
  options: HttpServerOptions,
  run: (port: number) => Promise<T>,
): Promise<T> {
  const server = createHttpServer(new ServiceCollection(), 0, options);
  try {
    if (!server.listening) {
      await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    }
    const address = server.address();
    const port = typeof address === "object" && address ? Number(address.port) : 0;
    return await run(port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/**
 * 探测一次 WS 升级，**并保证收尾**：成功升级后主动 close（否则 `server.close()` 会一直等
 * 这条连接，测试挂死 —— 这是实现期踩到的坑，别再退回去）。
 */
function probeWebSocket(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  options: { keepOpen?: boolean } = {},
): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const socket = new WebSocket("ws://127.0.0.1:" + port + path, { headers });
    const timer = setTimeout(() => {
      socket.terminate();
      finish("TIMEOUT");
    }, 5000);
    socket.on("open", () => {
      if (!options.keepOpen) {
        socket.close();
      }
      finish("OPEN");
    });
    socket.on("unexpected-response", (_request, response) => {
      finish("HTTP " + String(response.statusCode));
    });
    socket.on("error", (error) => {
      const match = /Unexpected server response: (\d+)/.exec(error.message);
      finish(match ? "HTTP " + match[1] : "ERROR " + error.message);
    });
  });
}

test("G11：ROUTE_POLICY 的受保护标注与实现一致（启动期断言不抛错）", () => {
  assert.doesNotThrow(() => assertRoutePolicyEnforced());
  // 每条受保护路由都必须真的被鉴权覆盖 —— 这是"防未来新增路由静默漂移"的断言本体。
  const protectedEntries = ROUTE_POLICY.filter((entry) => entry.policy === "protected");
  assert.ok(protectedEntries.length >= 5, "受保护路由不应少于 5 条（漏标会变红）");
  for (const entry of protectedEntries) {
    // 与 assertRoutePolicyEnforced 内部同一套探针规则：受保护路由的探针必须落在 /api 或 /ws 内。
    const probe = entry.prefix
      ? entry.path.endsWith("/**")
        ? entry.path.slice(0, -2) + "sample"
        : entry.path
      : entry.path.replace(":id", "sample-id");
    assert.equal(
      ["/api", "/ws"].some((prefix) => probe === prefix || probe.startsWith(prefix + "/")),
      true,
      entry.path + " 的探针 " + probe + " 必须落在受保护前缀内（否则清单与实现不一致）",
    );
  }
  // 公开路由必须写明理由（避免"顺手公开"）。
  for (const entry of ROUTE_POLICY.filter((item) => item.policy === "public")) {
    assert.ok(entry.note.length > 0, entry.path + " 作为公开路由必须写明理由");
  }
});

test("G11 反向验证：把一条受保护路由改成不被覆盖 ⇒ 必须拒绝启动", () => {
  // 模拟"未来新增一条 /rpc 路由、忘了加进 isTokenProtectedPath"：断言必须抛错，而不是放过。
  assert.throws(
    () => assertRoutePolicyEnforced((pathname) => pathname.startsWith("/api/") === false),
    /路由口径不一致/,
    "标注与实现不一致时必须拒绝启动（fail-closed）",
  );
});

test("审计：鉴权失败与封禁（含**否定式**：令牌字面量绝不出现）", async () => {
  const capture = captureAudit();
  const throttle = createAuthThrottle({ maxFailures: 2, windowMs: 60_000, banDurationMs: 60_000 });
  await withServer({ authToken: TOKEN, audit: capture.audit, throttle }, async (port) => {
    const baseUrl = "http://127.0.0.1:" + port;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const response = await fetch(baseUrl + "/api/server-info");
      assert.equal(response.status, 401);
    }
    // 第 3 次被限流拒绝（403）—— 这一条不写 auth-failure，避免把"被封禁"混进失败明细。
    assert.equal((await fetch(baseUrl + "/api/server-info")).status, 403);
  });

  const failures = capture.events("audit:auth-failure");
  const bans = capture.events("audit:auth-ban");
  assert.equal(failures.length, 2, "两次失败 = 两条失败事件");
  assert.equal(bans.length, 1, "触发封禁 = 一条封禁事件");
  assert.equal(failures[0]!.peer, "127.0.0.1", "必须写解析后的对端地址");
  assert.equal(failures[0]!.path, "/api/server-info");
  assert.equal(failures[0]!.method, "GET");

  // **否定式**：真实令牌字符串、cookie 名、查询串都不得出现。
  const text = capture.text();
  assert.equal(text.includes(SECRET_MARKER), false, "审计不得包含令牌字面量");
  assert.equal(text.includes("zcode_lite_token"), false, "审计不得包含 cookie 名");
  assert.equal(text.includes("?token="), false, "审计不得包含查询串");
  assert.equal(text.includes("Unauthorized"), false, "审计不得复制响应体");
});

test("审计：连接建立/断开（含角色、鉴权状态、存活时长、令牌标签）", async () => {
  const capture = captureAudit();
  await withServer({ authToken: TOKEN, audit: capture.audit }, async (port) => {
    const result = await probeWebSocket(port, "/ws", { Cookie: "zcode_lite_token=" + TOKEN });
    assert.equal(result, "OPEN");
    // 等一下让 onClose 跑到（socket.terminate 由服务端 close 触发审计）。
    await new Promise((resolve) => setTimeout(resolve, 300));
  });

  const opens = capture.events("audit:ws-open");
  const closes = capture.events("audit:ws-close");
  assert.equal(opens.length, 1, "一条连接 = 一条 open 事件");
  assert.equal(closes.length, 1, "断开 = 一条 close 事件");
  assert.equal(opens[0]!.role, "terminal-client");
  assert.equal(opens[0]!.authenticated, true);
  assert.equal(opens[0]!.peer, "127.0.0.1");
  assert.equal(opens[0]!.path, "/ws");
  assert.equal(opens[0]!.tokenLabel, "<env>", "只写标签，不写令牌");
  assert.equal(opens[0]!.connectionId, closes[0]!.connectionId, "open/close 必须能配对");
  assert.equal(typeof closes[0]!.durationMs, "number");
  assert.equal(capture.text().includes(SECRET_MARKER), false);
});

test("审计：Host 被拒与来源被拒**分开记**（不同防线，不能混成一个事件）", async () => {
  const capture = captureAudit();
  await withServer(
    { authToken: TOKEN, audit: capture.audit, trustedHosts: [{ host: "panel.example" }] },
    async (port) => {
      const baseUrl = "http://127.0.0.1:" + port;
      // ① 跨站（Origin 与 Host 不同源）⇒ origin-rejected
      const crossSite = await fetch(baseUrl + "/api/rpc-host-capability", {
        method: "POST",
        headers: { origin: "https://attacker.example" },
      });
      assert.equal(crossSite.status, 403);
      // ② WS 升级带伪 Host ⇒ host-rejected（HTTP 层的 gate）
      const wsRejected = await probeWebSocket(port, "/ws", {
        Host: "evil.com",
        Cookie: "zcode_lite_token=" + TOKEN,
      });
      assert.equal(wsRejected, "HTTP 403");
    },
  );
  assert.equal(capture.events("audit:origin-rejected").length, 1, "跨站必须记 origin-rejected");
  const hostRejected = capture.events("audit:host-rejected");
  assert.equal(hostRejected.length, 1, "伪 Host 必须记 host-rejected");
  assert.equal(hostRejected[0]!.path, "/ws");
  assert.match(String(hostRejected[0]!.reason), /rebinding/);
});

test("审计：并发上限（B3）超限时记事件，且已建立的连接不受影响", async () => {
  const capture = captureAudit();
  // 上限设 1：第一条连接占满，第二条必须被拒。
  await withServer(
    { authToken: TOKEN, audit: capture.audit, maxConcurrentConnections: 1 },
    async (port) => {
      // 第一条连接必须**保持打开**才会占满上限 ⇒ 显式持住它，用例结束前主动关掉。
      const held = new WebSocket("ws://127.0.0.1:" + port + "/ws", {
        headers: { Cookie: "zcode_lite_token=" + TOKEN },
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("第一条连接未在 5s 内建立")), 5000);
          held.on("open", () => {
            clearTimeout(timer);
            resolve();
          });
          held.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
        });
        const second = await probeWebSocket(port, "/ws", { Cookie: "zcode_lite_token=" + TOKEN });
        assert.equal(second, "HTTP 403", "超限的新连接必须被拒（403 + 明确原因）");
        const third = await probeWebSocket(port, "/ws", { Cookie: "zcode_lite_token=" + TOKEN });
        assert.equal(third, "HTTP 403", "持续超限持续被拒（已建立的连接不受影响）");
      } finally {
        held.terminate();
      }
    },
  );
  const rejected = capture.events("audit:connection-limit-rejected");
  assert.equal(rejected.length, 2, "两次被拒 = 两条事件（合并策略在窗口内仍逐条写到上限）");
  assert.equal(rejected[0]!.maxConnections, 1);
  assert.equal(rejected[0]!.connections, 1);
  assert.equal(rejected[0]!.reason, "活跃连接数达到上限");
});

test("审计：令牌重载事件（成功与失败）只写条数与标签", async () => {
  const capture = captureAudit();
  // 直接驱动 createHttpServer 注入的 audit 上不会有 reload（它在 entry-http），
  // 所以这里用同样的字段形状记录一次，证明**字段形状**允许且不泄漏（集成由 entry 承担）。
  capture.audit.record({
    kind: "audit:token-reload",
    peer: "local",
    reason: "SIGHUP 重载令牌文件",
    tokenCount: 2,
    tokenLabels: ["<env>", "手机"],
  });
  capture.audit.record({
    kind: "audit:token-reload-failed",
    peer: "local",
    reason: "SIGHUP 重载失败，保持上一份令牌集合",
    tokenCount: 1,
    tokenLabels: ["<env>"],
  });
  assert.equal(capture.events("audit:token-reload").length, 1);
  assert.equal(capture.events("audit:token-reload-failed").length, 1);
  assert.equal(capture.text().includes(SECRET_MARKER), false);
  assert.match(capture.text(), /"tokenLabels":\["<env>","手机"\]/);
});

test("审计：静态壳与正常请求不产生安全事件（避免噪音掩盖真事件）", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-audit-shell-"));
  const staticRoot = join(root, "web");
  await mkdir(staticRoot, { recursive: true });
  await writeFile(join(staticRoot, "index.html"), "<!doctype html><title>ok</title>");
  const capture = captureAudit();
  try {
    await withServer({ authToken: TOKEN, audit: capture.audit, staticRoot }, async (port) => {
      const baseUrl = "http://127.0.0.1:" + port;
      assert.equal((await fetch(baseUrl + "/")).status, 200);
      assert.equal((await fetch(baseUrl + "/api/server-info?token=" + TOKEN)).status, 200);
    });
    assert.deepEqual(capture.events(), [], "正常路径不得产生任何审计事件");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
