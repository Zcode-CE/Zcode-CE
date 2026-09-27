import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { ServiceCollection } from "@zcode/services";
import { createHttpServer, ROUTE_POLICY, type HttpServerOptions } from "../src/http.js";
import { createAuditLog } from "../src/auditLog.js";
import { createAuthThrottle } from "../src/authThrottle.js";
import { createAuthTokenStore } from "../src/authToken.js";

/**
 * 连接面（谁连着）的服务端契约护栏 —— spec §6.4 的三条 API 与 §6.5 的验收判据。
 *
 * 为什么必须有这组测试：本切片第一次把「谁连着」变成可读、可撤销的服务端事实。
 * 三件事一旦回归就是安全或语义事故：
 * ① 撤销动作被跨站页面借已授权 cookie 触发（G1/G2）；
 * ② 「断开全部」只从清单里删掉、连接其实还活着（用户以为踢掉了，实际没有）；
 * ③ 轮换令牌返回 200 而旧令牌仍然可用（安全错觉）。
 *
 * 判据全部打在真实服务端上（真监听 + 真 WS + 真 fetch），不走纯函数 ——
 * 本仓刚记过一次教训：纯函数说放行、真实中间件拒绝（见 62edf8d）。
 */

const TOKEN = "connections-plane-token";
const CROSS_SITE_ORIGIN = "https://evil.example";

/**
 * 本文件开过的 WebSocket。每个用例收尾时强制销毁。
 *
 * 为什么必须自己管：升级后的 socket 会被 Node 从 server 的连接表里摘掉，
 * 于是 server.closeAllConnections() 管不到它们、server.close() 会一直等 ——
 * 实测：变异"撤销只删清单不关连接"会让测试挂满 20s 超时，而不是给出断言级证据。
 * 超时是比失败更弱的信号（看不出哪条不变式破了），所以这里显式兜底。
 */
const liveSockets = new Set<WebSocket>();

function closeAllLiveSockets(): void {
  for (const socket of liveSockets) {
    socket.terminate();
  }
  liveSockets.clear();
}

async function withServer(
  options: HttpServerOptions,
  run: (baseUrl: string, wsBaseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createHttpServer(new ServiceCollection(), 0, options);
  try {
    if (!server.listening) {
      await new Promise<void>((resolve) => {
        server.once("listening", () => resolve());
      });
    }
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await run("http://127.0.0.1:" + String(port), "ws://127.0.0.1:" + String(port));
  } finally {
    // 必须强制断开残留连接：server.close() 只停止接受新连接，
    // 已建立的 socket 会让它一直等下去。没有这一步时，任何"忘了关连接"的回归
    // 表现为测试挂住而不是变红 —— 挂住是比失败更差的信号（无法归因、拖垮整条流水线）。
    // 实测：变异"撤销只删清单不关连接"在加上这一行前会挂满超时。
    closeAllLiveSockets();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

/**
 * 打开一条真实的 /ws 连接并等到服务端登记完成。
 *
 * 为什么不能只看客户端 open 就断言：客户端的 open 与服务端的 onOpen（登记发生地）
 * 是两个进程侧的事件，不保证先后。这里轮询清单直到看到目标连接，避免把时序竞态
 * 写成偶发失败。
 */
async function openConnection(
  wsBaseUrl: string,
  path: string,
  headers?: Record<string, string>,
): Promise<{ socket: WebSocket; closeEvent: Promise<{ code: number; reason: string }> }> {
  // /ws 在令牌白名单内：不带令牌会先被令牌层拦成 401（那测出来的是鉴权而不是连接面）。
  // 令牌只进 URL（非浏览器客户端口径），与 desktop 接线的做法一致。
  // 调用方已经带了 token 时不再追加：重复的 token 参数取第一个，会让"用哪个令牌"变得难读。
  const url = path.includes("token=")
    ? path
    : path + (path.includes("?") ? "&" : "?") + "token=" + TOKEN;
  const socket = new WebSocket(wsBaseUrl + url, headers ? { headers } : undefined);
  liveSockets.add(socket);
  const closeEvent = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.on("close", (code: number, reason: Buffer) => {
      liveSockets.delete(socket);
      resolve({ code, reason: reason.toString() });
    });
  });
  await new Promise<void>((resolve, reject) => {
    // 兜底定时器必须清掉：否则它在测试断言失败之后仍挂着，
    // 会把"断言失败"拖成"测试超时"——超时是比失败更弱的证据（无法归因到具体断言）。
    const timer = setTimeout(() => reject(new Error("WS 未能升级：" + path)), 5000);
    socket.on("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return { socket, closeEvent };
}

/**
 * 等一条连接的关闭事件；超时返回 null 而不是一直挂着。
 *
 * 用"返回 null 再断言"而不是"超时即 reject"：这样失败信息是
 * 「必须收到关闭，而不是只在清单里消失」这条语义，
 * 而不是一句看不出哪里错的 "timeout"。
 */
function raceClose(
  closeEvent: Promise<{ code: number; reason: string }>,
): Promise<{ code: number; reason: string } | null> {
  return Promise.race([
    closeEvent,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
  ]);
}

/** 带令牌的写请求（?token= 是既有公开机制，与 desktop 接线一致）。 */
function post(
  baseUrl: string,
  path: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return fetch(baseUrl + path + "?token=" + TOKEN, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
}

function listConnections(baseUrl: string, token: string = TOKEN): Promise<Response> {
  return fetch(baseUrl + "/api/remote-control/connections?token=" + token);
}

/** 等待清单里出现至少 n 条连接（服务端登记是异步于客户端 open 的）。 */
async function waitForConnections(
  baseUrl: string,
  n: number,
  token: string = TOKEN,
): Promise<{ connections: Record<string, unknown>[]; revision: number }> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await listConnections(baseUrl, token);
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      connections: Record<string, unknown>[];
      revision: number;
    };
    if (payload.connections.length >= n) return payload;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("等待连接登记超时（期望 " + String(n) + " 条）");
}

// ---------------------------------------------------------------------------
// 一、读：GET /api/remote-control/connections
// ---------------------------------------------------------------------------

test("读：空数组 = 确定 0 台设备（200，不是 404）", async () => {
  await withServer({ authToken: TOKEN }, async (baseUrl) => {
    const response = await listConnections(baseUrl);
    assert.equal(
      response.status,
      200,
      "无连接时必须是 200 —— 404 会让面板分不清「没人连」与「端点不存在」",
    );
    const payload = (await response.json()) as { connections: unknown[]; revision: number };
    assert.deepEqual(payload.connections, [], "空清单必须是空数组");
    assert.equal(typeof payload.revision, "number", "revision 必须存在（供面板去重与轮询）");
  });
});

test("读：无凭据 401（在令牌白名单内）", async () => {
  await withServer({ authToken: TOKEN }, async (baseUrl) => {
    const response = await fetch(baseUrl + "/api/remote-control/connections");
    assert.equal(response.status, 401, "连接清单必须受鉴权保护");
  });
});

test("读：登记一条真实 /ws 连接，字段与 spec §6.4 逐条一致", async () => {
  await withServer({ authToken: TOKEN }, async (baseUrl, wsBaseUrl) => {
    const { socket } = await openConnection(wsBaseUrl, "/ws", {
      "user-agent": "connection-plane-probe/1.0",
    });
    try {
      const payload = await waitForConnections(baseUrl, 1);
      const row = payload.connections.find(
        (item) => item.userAgent === "connection-plane-probe/1.0",
      );
      assert.ok(row, "登记的行必须能被找到（按 userAgent 定位本次探针）");
      assert.equal(typeof row.id, "string");
      assert.ok((row.id as string).length > 0, "id 必须非空");
      assert.equal(row.role, "terminal-client", "/ws 的角色是 terminal-client");
      assert.equal(row.address, "127.0.0.1", "address 是解析后的对端地址");
      assert.equal(typeof row.connectedAt, "number", "connectedAt 是 epoch 毫秒");
      // 契约的可选字段：今天不产出（升级时刻服务端不知道客户端会选哪个工作区）。
      assert.equal(row.workspace, undefined, "不得编造 workspace");
    } finally {
      socket.close();
    }
  });
});

test("读：id 含随机量、不可猜（两次连接不得相同）", async () => {
  await withServer({ authToken: TOKEN }, async (baseUrl, wsBaseUrl) => {
    const first = await openConnection(wsBaseUrl, "/ws");
    const second = await openConnection(wsBaseUrl, "/ws");
    try {
      const payload = await waitForConnections(baseUrl, 2);
      const ids = payload.connections.map((item) => item.id);
      assert.equal(new Set(ids).size, ids.length, "每条连接的 id 必须唯一");
      // UUID v4 形态：122 bit 随机量。判据是"不可猜"，这里钉住它的随机来源形态。
      for (const id of ids) {
        assert.match(
          String(id),
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
          "id 必须是含随机量的 UUID（不可猜）",
        );
      }
    } finally {
      first.socket.close();
      second.socket.close();
    }
  });
});

test("读：绝不返回令牌，也不返回可反推令牌的信息", async () => {
  const capture = captureAudit();
  await withServer({ authToken: TOKEN, audit: capture.audit }, async (baseUrl, wsBaseUrl) => {
    const { socket } = await openConnection(wsBaseUrl, "/ws");
    try {
      await waitForConnections(baseUrl, 1);
      const text = await (await listConnections(baseUrl)).text();
      // 否定式断言：用真实令牌字符串反向搜索整个响应体。
      assert.doesNotMatch(text, new RegExp(TOKEN), "响应体里不得出现令牌");
      assert.doesNotMatch(text, /token/i, "响应体里不得出现 token 字样");
      assert.doesNotMatch(text, /cookie/i, "响应体里不得出现 cookie");
    } finally {
      socket.close();
    }
  });
});

test("读：revision 单调递增（集合变化才推进）", async () => {
  await withServer({ authToken: TOKEN }, async (baseUrl, wsBaseUrl) => {
    const before = (await (await listConnections(baseUrl)).json()) as { revision: number };
    const { socket } = await openConnection(wsBaseUrl, "/ws");
    const after = await waitForConnections(baseUrl, 1);
    assert.ok(after.revision > before.revision, "新增连接必须让 revision 前进");
    socket.close();
    // 断开后 revision 仍不得回退（回退会让面板的去重逻辑失效）。
    await new Promise((resolve) => setTimeout(resolve, 100));
    const closed = (await (await listConnections(baseUrl)).json()) as { revision: number };
    assert.ok(closed.revision >= after.revision, "revision 不得回退");
  });
});

// ---------------------------------------------------------------------------
// 二、写：POST /api/remote-control/connections/revoke
// ---------------------------------------------------------------------------

test("写：恰好其一 —— 同时给 / 都不给 / 空 body 一律 400", async () => {
  await withServer({ authToken: TOKEN }, async (baseUrl) => {
    const cases: { name: string; body: unknown }[] = [
      { name: "同时给 id 与 all", body: { id: "x", all: true } },
      { name: "都不给", body: {} },
      { name: "id 为空串", body: { id: "" } },
      { name: "all 为 false", body: { all: false } },
      { name: "all 为真值字符串", body: { all: "true" } },
      { name: "数组", body: [] },
    ];
    for (const item of cases) {
      const response = await post(baseUrl, "/api/remote-control/connections/revoke", item.body);
      assert.equal(
        response.status,
        400,
        item.name + " 必须 400（不做就近猜一个的兜底：断一个与断全部的后果差一个数量级）",
      );
    }
  });
});

test("写：撤销不存在的 id ⇒ 幂等 { revoked: 0 } + 200（不是 404）", async () => {
  await withServer({ authToken: TOKEN }, async (baseUrl) => {
    const first = await post(baseUrl, "/api/remote-control/connections/revoke", {
      id: "00000000-0000-4000-8000-000000000000",
    });
    assert.equal(first.status, 200, "不存在的 id 必须 200 —— 面板轮询与竞态下语义更稳");
    assert.deepEqual(await first.json(), { revoked: 0 });

    // 再撤一次同样 200/0（真的幂等，不是"第一次恰好返回 0"）。
    const second = await post(baseUrl, "/api/remote-control/connections/revoke", {
      id: "00000000-0000-4000-8000-000000000000",
    });
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), { revoked: 0 });
  });
});

test("写：撤销指定连接 ⇒ { revoked: 1 }，连接收到关闭，清单移除", async () => {
  await withServer({ authToken: TOKEN }, async (baseUrl, wsBaseUrl) => {
    const { socket, closeEvent } = await openConnection(wsBaseUrl, "/ws");
    const payload = await waitForConnections(baseUrl, 1);
    const target = payload.connections[0]!;

    const response = await post(baseUrl, "/api/remote-control/connections/revoke", {
      id: target.id,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { revoked: 1 });

    // 关键：不能只是从清单里删掉 —— 原连接必须真的收到关闭（spec §6.5 判据③）。
    const closed = await raceClose(closeEvent);
    assert.ok(closed, "被撤销的连接必须收到关闭，而不是只在清单里消失");
    assert.equal(closed.code, 4001, "用私有区间关闭码区分「被撤销」与「网络断开」");
    assert.equal(socket.readyState, WebSocket.CLOSED);

    // 再撤一次 ⇒ 幂等 0（撤销已摘除条目，close 事件的 unregister 是 no-op）。
    const again = await post(baseUrl, "/api/remote-control/connections/revoke", {
      id: target.id,
    });
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), { revoked: 0 }, "已断开的 id 必须幂等返回 0");
  });
});

test("写：全部断开 ⇒ 每条连接都收到关闭，且返回实际条数", async () => {
  await withServer({ authToken: TOKEN }, async (baseUrl, wsBaseUrl) => {
    const a = await openConnection(wsBaseUrl, "/ws");
    const b = await openConnection(wsBaseUrl, "/ws");
    await waitForConnections(baseUrl, 2);

    const response = await post(baseUrl, "/api/remote-control/connections/revoke", { all: true });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { revoked: 2 });

    for (const [name, conn] of [
      ["a", a],
      ["b", b],
    ] as const) {
      const closed = await raceClose(conn.closeEvent);
      assert.ok(closed, "连接 " + name + " 必须收到关闭（不能只从清单里删掉）");
      assert.equal(closed.code, 4001);
    }

    const after = (await (await listConnections(baseUrl)).json()) as { connections: unknown[] };
    assert.deepEqual(after.connections, [], "全部断开后清单为空");
  });
});

test("写：本来就没人连时全部断开 ⇒ { revoked: 0 } + 200（幂等）", async () => {
  await withServer({ authToken: TOKEN }, async (baseUrl) => {
    const response = await post(baseUrl, "/api/remote-control/connections/revoke", { all: true });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { revoked: 0 });
  });
});

test("写：撤销只断连接，绝不触碰服务面（进程仍在监听、后续请求照常）", async () => {
  await withServer({ authToken: TOKEN }, async (baseUrl, wsBaseUrl) => {
    const { socket } = await openConnection(wsBaseUrl, "/ws");
    await waitForConnections(baseUrl, 1);
    await post(baseUrl, "/api/remote-control/connections/revoke", { all: true });
    socket.close();

    // 服务面未被触碰的最直接证据：同一个服务仍在正常应答。
    const response = await listConnections(baseUrl);
    assert.equal(response.status, 200, "撤销连接不得停止服务进程或触碰监听");
  });
});

// ---------------------------------------------------------------------------
// 三、写：POST /api/remote-control/rotate-token
// ---------------------------------------------------------------------------

test("轮换：旧令牌立即失效、新令牌可用，且不断开既有连接", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-rotate-"));
  const tokenPath = join(dir, "token");
  const OLD = "old-token-should-be-invalidated";
  await writeFile(tokenPath, OLD + "\n", { mode: 0o600 });
  const tokenSource = createAuthTokenStore({
    records: [],
    fileRecords: [{ token: OLD }],
    filePath: tokenPath,
  });
  try {
    await withServer({ tokenSource, tokenFilePath: tokenPath }, async (baseUrl, wsBaseUrl) => {
      const { socket } = await openConnection(wsBaseUrl, "/ws?token=" + OLD);
      try {
        // 轮换前：旧令牌可用。
        const before = await fetch(baseUrl + "/api/server-info?token=" + OLD);
        assert.equal(before.status, 200, "轮换前旧令牌应可用");

        const response = await fetch(baseUrl + "/api/remote-control/rotate-token?token=" + OLD, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        assert.equal(response.status, 200, "轮换必须成功");
        const payload = (await response.json()) as { rotatedAt: number };
        assert.equal(typeof payload.rotatedAt, "number", "必须返回 rotatedAt（epoch 毫秒）");

        // 旧令牌立即失效。
        const oldAfter = await fetch(baseUrl + "/api/server-info?token=" + OLD);
        assert.equal(oldAfter.status, 401, "轮换后旧令牌必须立即失效");

        // 新令牌（从文件读）可用。
        const newToken = (await readFile(tokenPath, "utf8")).trim();
        assert.notEqual(newToken, OLD, "文件里必须已是新令牌");
        const newAfter = await fetch(baseUrl + "/api/server-info?token=" + newToken);
        assert.equal(newAfter.status, 200, "新令牌必须可用");

        // 契约边界（spec §6.4 只写「旧令牌立即失效」）：轮换不断开既有连接。
        // 这条如实钉住实现，避免后来者按「轮换 = 踢人」的预期误读。
        assert.equal(socket.readyState, WebSocket.OPEN, "轮换令牌不断开已建立的连接");
      } finally {
        socket.close();
      }
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("轮换：新令牌强度 >= 128 bit（32 字节 CSPRNG）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-rotate-strength-"));
  const tokenPath = join(dir, "token");
  const OLD = "old-token-for-strength-check";
  await writeFile(tokenPath, OLD + "\n", { mode: 0o600 });
  const tokenSource = createAuthTokenStore({
    records: [],
    fileRecords: [{ token: OLD }],
    filePath: tokenPath,
  });
  try {
    await withServer({ tokenSource, tokenFilePath: tokenPath }, async (baseUrl) => {
      await fetch(baseUrl + "/api/remote-control/rotate-token?token=" + OLD, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const token = (await readFile(tokenPath, "utf8")).trim();
      // base64url：每 4 字符 3 字节。32 字节 ⇒ 43 字符 ⇒ 256 bit。
      assert.ok(token.length >= 43, "新令牌长度不足（" + String(token.length) + " 字符）");
      assert.match(token, /^[A-Za-z0-9_-]+$/, "必须是可直接进 URL 与二维码的 base64url");
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("轮换：没有令牌文件源 ⇒ 409（fail-loud，不静默 no-op）", async () => {
  await withServer({ authToken: TOKEN }, async (baseUrl) => {
    const response = await post(baseUrl, "/api/remote-control/rotate-token", {});
    assert.equal(
      response.status,
      409,
      "只配了显式 env 令牌时不能假装轮换成功（那会让面板宣称所有人需重连，而令牌没动）",
    );
    // 旧令牌必须仍然可用 —— 证明 409 是真的没做事，不是"做了一半"。
    const still = await fetch(baseUrl + "/api/server-info?token=" + TOKEN);
    assert.equal(still.status, 200);
  });
});

// ---------------------------------------------------------------------------
// 四、跨站与来源（spec §6.5 判据⑦）
// ---------------------------------------------------------------------------

test("跨站：带恶意 Origin 的写动作必须被拒（403/401）", async () => {
  await withServer({ authToken: TOKEN }, async (baseUrl) => {
    const writes: { name: string; path: string; body: unknown }[] = [
      { name: "revoke", path: "/api/remote-control/connections/revoke", body: { all: true } },
      { name: "rotate-token", path: "/api/remote-control/rotate-token", body: {} },
    ];
    for (const item of writes) {
      const response = await post(baseUrl, item.path, item.body, {
        origin: CROSS_SITE_ORIGIN,
      });
      assert.ok(
        response.status === 403 || response.status === 401,
        item.name + " 带跨站 Origin 必须被拒（403/401），实际 " + String(response.status),
      );
    }
  });
});

test("跨站：跨源 WS 升级被拒（连接面不得被跨站建立）", async () => {
  await withServer({ authToken: TOKEN }, async (baseUrl, wsBaseUrl) => {
    const cookie = (
      (await (
        await fetch(baseUrl + "/api/server-info?token=" + TOKEN)
      ).headers.get("set-cookie")) ?? ""
    ).split(";")[0]!;
    const result = await new Promise<string>((resolve) => {
      const socket = new WebSocket(wsBaseUrl + "/ws", {
        headers: { cookie, Origin: CROSS_SITE_ORIGIN },
      });
      const timer = setTimeout(() => {
        socket.terminate();
        resolve("TIMEOUT");
      }, 5000);
      socket.on("open", () => {
        clearTimeout(timer);
        socket.close();
        resolve("OPEN");
      });
      socket.on("unexpected-response", (_request, response) => {
        clearTimeout(timer);
        resolve("HTTP " + String(response.statusCode));
      });
      socket.on("error", (error) => {
        clearTimeout(timer);
        const match = /Unexpected server response: (\d+)/.exec(error.message);
        resolve(match ? "HTTP " + match[1]! : "ERROR " + error.message);
      });
    });
    assert.equal(result, "HTTP 403", "跨源 WS 升级必须被拒（这是 G2 那条完全接管路径）");
  });
});

test("跨站：跨源 GET 不得泄露清单（靠不发 CORS 头，不靠 403）", async () => {
  await withServer({ authToken: TOKEN }, async (baseUrl, wsBaseUrl) => {
    const { socket } = await openConnection(wsBaseUrl, "/ws");
    try {
      await waitForConnections(baseUrl, 1);
      const response = await fetch(baseUrl + "/api/remote-control/connections", {
        headers: { origin: CROSS_SITE_ORIGIN, "access-control-request-method": "GET" },
      });
      // 读方法不在来源保护面内（与既有 /api/server-info 同一形态），
      // 于是"跨源读不到"由浏览器同源策略承担 —— 服务端侧的可验证事实是
      // 不下发任何 CORS 放行头。没有它，跨源 fetch 拿不到响应体。
      assert.equal(
        response.headers.get("access-control-allow-origin"),
        null,
        "绝不下发 CORS 放行头 —— 否则跨源页面能直接读到设备清单",
      );
      assert.equal(
        response.headers.get("access-control-allow-credentials"),
        null,
        "绝不放行跨源携带凭据",
      );
    } finally {
      socket.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 五、接口审计：不存在「启动/停止远端服务」的 RPC（spec §6.5 判据③）
// ---------------------------------------------------------------------------

test("接口审计：连接面恰好三条路由，且不含任何服务面操作", async () => {
  const source = await readFile(new URL("../src/http.ts", import.meta.url), "utf8");
  // ① 路由清单与契约一致（多一条就是多一个面）。
  const routes = [...source.matchAll(/app\.(get|post)\(\s*"([^"]*remote-control[^"]*)"/g)].map(
    (match) => match[1]!.toUpperCase() + " " + match[2]!,
  );
  assert.deepEqual(
    routes.sort(),
    [
      "GET /api/remote-control/connections",
      "POST /api/remote-control/connections/revoke",
      "POST /api/remote-control/rotate-token",
    ].sort(),
    "连接面必须恰好是契约里的三条路由",
  );

  // ② 三条处理器的实现体里不得出现任何服务面操作。
  // 这是规则③「连接面 API 不得启动/停止任何服务进程」的可验证形式。
  const start = source.indexOf('app.get("/api/remote-control/connections"');
  const end = source.indexOf("// 远程连接的 WebSocket 端点", start);
  assert.ok(start > 0 && end > start, "必须能定位连接面实现区段");
  const handlers = source.slice(start, end);
  // 按「调用形态」而不是裸词匹配：裸词会误伤说明文字
  // （实测：409 的提示语里写着 "by restarting with a new one" —— 那是给用户的指引，
  //  不是一次重启调用；用裸词 restart 会让这条断言永远红，从而被"顺手放宽"）。
  const forbidden: [RegExp, string][] = [
    [/process\.exit\s*\(/, "不得退出服务进程"],
    [/\.listen\s*\(/, "不得启动监听"],
    [/server\.close\s*\(/, "不得停止服务"],
    [/child_process/, "不得拉起子进程"],
    [/\bspawn\s*\(/, "不得拉起子进程"],
    [/\bexec(File)?\s*\(/, "不得执行外部命令"],
    [/\.kill\s*\(/, "不得杀进程"],
    [/stopServer|startServer|restartServer/, "不得启停服务"],
  ];
  for (const [pattern, why] of forbidden) {
    const match = pattern.exec(handlers);
    assert.equal(
      match,
      null,
      "连接面实现里出现了 " + String(match?.[0]) + "：" + why + "（规则③：连接面只断连接）",
    );
  }
});

test("路由标注：三条连接面路由都标为受保护（G11 契约）", () => {
  for (const path of [
    "/api/remote-control/connections",
    "/api/remote-control/connections/revoke",
    "/api/remote-control/rotate-token",
  ]) {
    const entry = ROUTE_POLICY.find((item) => item.path === path);
    assert.ok(entry, path + " 必须在 ROUTE_POLICY 里登记（否则鉴权会静默缺席）");
    assert.equal(entry.policy, "protected", path + " 必须标为受保护");
  }
});

test("写：无凭据的 revoke / rotate-token 一律 401", async () => {
  await withServer({ authToken: TOKEN }, async (baseUrl) => {
    for (const path of [
      "/api/remote-control/connections/revoke",
      "/api/remote-control/rotate-token",
    ]) {
      const response = await fetch(baseUrl + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
      assert.equal(response.status, 401, path + " 无凭据必须 401");
    }
  });
});

// ---------------------------------------------------------------------------
// 六、审计（web-remote-control.md §9.1）
// ---------------------------------------------------------------------------

function captureAudit() {
  const lines: string[] = [];
  const audit = createAuditLog({
    write: (line) => lines.push(line),
    coalesceWindowMs: 0,
  });
  return {
    audit,
    events: (kind: string): Record<string, unknown>[] =>
      lines
        .map((line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>)
        .filter((event) => event.kind === kind),
    text: () => lines.join("\n"),
  };
}

test("审计：撤销与轮换各留一条账，且不写令牌", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-rotate-audit-"));
  const tokenPath = join(dir, "token");
  const OLD = "audit-rotate-old-token-must-not-appear";
  await writeFile(tokenPath, OLD + "\n", { mode: 0o600 });
  const tokenSource = createAuthTokenStore({
    records: [],
    fileRecords: [{ token: OLD }],
    filePath: tokenPath,
  });
  const capture = captureAudit();
  try {
    await withServer(
      { tokenSource, tokenFilePath: tokenPath, audit: capture.audit },
      async (baseUrl, wsBaseUrl) => {
        const { socket } = await openConnection(wsBaseUrl, "/ws?token=" + OLD);
        await waitForConnections(baseUrl, 1, OLD);
        await fetch(baseUrl + "/api/remote-control/connections/revoke?token=" + OLD, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ all: true }),
        });
        socket.close();
        await fetch(baseUrl + "/api/remote-control/rotate-token?token=" + OLD, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });

        const revoked = capture.events("audit:connections-revoked");
        assert.ok(revoked.length >= 1, "撤销必须留一条审计");
        assert.equal(revoked[0]!.revoked, 1, "审计里要记实际断开了几条");

        const rotated = capture.events("audit:token-rotated");
        assert.ok(rotated.length >= 1, "轮换必须留一条审计");

        // 否定式断言：真实令牌字符串不得出现在整份审计文本里。
        assert.doesNotMatch(capture.text(), new RegExp(OLD), "审计里绝不得出现令牌");
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 七、并发上限仍按同一份状态计数（防止两份连接状态分家）
// ---------------------------------------------------------------------------

test("并发上限与连接清单用同一份状态（上限 1 时第二条连接被拒，且清单仍只有 1 条）", async () => {
  const throttle = createAuthThrottle({ maxFailures: 100, windowMs: 60_000, banDurationMs: 1000 });
  await withServer(
    { authToken: TOKEN, maxConcurrentConnections: 1, throttle },
    async (baseUrl, wsBaseUrl) => {
      const first = await openConnection(wsBaseUrl, "/ws");
      try {
        await waitForConnections(baseUrl, 1);
        const result = await new Promise<string>((resolve) => {
          const socket = new WebSocket(wsBaseUrl + "/ws");
          liveSockets.add(socket);
          const timer = setTimeout(() => {
            socket.terminate();
            resolve("TIMEOUT");
          }, 5000);
          socket.on("open", () => {
            clearTimeout(timer);
            socket.close();
            resolve("OPEN");
          });
          socket.on("unexpected-response", (_request, response) => {
            clearTimeout(timer);
            resolve("HTTP " + String(response.statusCode));
          });
          socket.on("error", (error) => {
            clearTimeout(timer);
            const match = /Unexpected server response: (\d+)/.exec(error.message);
            resolve(match ? "HTTP " + match[1]! : "ERROR " + error.message);
          });
        });
        assert.equal(result, "HTTP 403", "超过并发上限的新连接必须被拒");

        // 关键：被拒的连接不得出现在清单里（计数与清单同源）。
        const payload = (await (await listConnections(baseUrl)).json()) as {
          connections: unknown[];
        };
        assert.equal(payload.connections.length, 1, "被拒的连接不得登记进清单");
      } finally {
        first.socket.close();
      }
    },
  );
});
