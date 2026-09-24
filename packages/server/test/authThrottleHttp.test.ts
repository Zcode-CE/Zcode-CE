import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { ServiceCollection } from "@zcode/services";
import { createHttpServer, type HttpServerOptions } from "../src/http.js";
import { createAuthThrottle, parseTrustedProxies } from "../src/authThrottle.js";
import { createAuthTokenStore } from "../src/authToken.js";

/**
 * 鉴权失败限流 + XFF 信任收紧（task-35 / A3、G10②）打到真实服务端。
 *
 * **为什么这两件事必须在同一个文件里测**：先加按 IP 限流、却仍无条件采信 `X-Forwarded-For`，
 * 等于给攻击者一个「换头即换 IP」的绕过开关。下面「伪造 XFF 不能绕过限流」那一条就是这条耦合的
 * 回归护栏 —— 它同时依赖 `resolveClientAddress` 的默认收紧与 `createAuthThrottle` 的计数。
 *
 * **反向验证（实测过）**：把 `resolveClientAddress` 改回「优先取 XFF 首跳」，
 * 「伪造 XFF 不能绕过限流」变红；去掉限流中间件的 `check()` 分支，
 * 「达到阈值后第 N+1 次被拒」与「封禁也覆盖 WS 升级请求」变红。
 */

const TOKEN = "integration-token";

/** 每个用例自带 throttle 与独立地址，避免用例之间互相污染（限流是全局状态）。 */
async function withServer(
  options: HttpServerOptions,
  run: (baseUrl: string) => Promise<void>,
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
    await run("http://127.0.0.1:" + port);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

function probeWebSocketUpgrade(
  wsBaseUrl: string,
  headers: Record<string, string>,
): Promise<string> {
  return new Promise<string>((resolve) => {
    let settled = false;
    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const socket = new WebSocket(wsBaseUrl + "/ws", { headers });
    const timer = setTimeout(() => {
      socket.terminate();
      finish("TIMEOUT");
    }, 5000);
    socket.on("open", () => {
      socket.close();
      finish("OPEN");
    });
    socket.on("unexpected-response", (_request, response) => {
      finish("HTTP " + response.statusCode);
    });
    socket.on("error", (error) => {
      const match = /Unexpected server response: (\d+)/.exec(error.message);
      finish(match ? "HTTP " + match[1] : "ERROR " + error.message);
    });
  });
}

test("限流：连续失败达阈值后第 N+1 次被拒（403 且原因不同于 401）", async () => {
  const throttle = createAuthThrottle({ maxFailures: 3, windowMs: 60_000, banDurationMs: 60_000 });
  await withServer({ authToken: TOKEN, throttle }, async (baseUrl) => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await fetch(baseUrl + "/api/server-info", {
        headers: { authorization: "Bearer wrong-" + attempt },
      });
      assert.equal(response.status, 401, "第 " + attempt + " 次错令牌应 401");
      assert.equal(await response.text(), '{"error":"Unauthorized"}');
    }
    const blocked = await fetch(baseUrl + "/api/server-info");
    assert.equal(blocked.status, 403, "封禁期内必须 403（拒绝服务语义，不是 401）");
    const body = await blocked.text();
    assert.match(body, /Too many failed authentication attempts/, "必须给出可区分的原因");
    assert.doesNotMatch(body, /Unauthorized.*Unauthorized/, "不得退化成普通 401 文案");

    // 封禁期内连正确令牌也不放行：这正是「暴力破解被截断」的含义，且它必须可解释。
    const correctTokenWhileBanned = await fetch(baseUrl + "/api/server-info?token=" + TOKEN);
    assert.equal(correctTokenWhileBanned.status, 403);
  });
});

test("限流：**伪造 X-Forwarded-For 不能绕过**（默认不采信该头）", async () => {
  const throttle = createAuthThrottle({ maxFailures: 3, windowMs: 60_000, banDurationMs: 60_000 });
  await withServer({ authToken: TOKEN, throttle }, async (baseUrl) => {
    // 攻击者每次都换一个假 IP，试图让每个请求都落在新的计数桶里。
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await fetch(baseUrl + "/api/server-info", {
        headers: { "x-forwarded-for": "198.51.100." + attempt },
      });
      assert.equal(response.status, 401, "第 " + attempt + " 次应 401");
    }
    const blocked = await fetch(baseUrl + "/api/server-info", {
      headers: { "x-forwarded-for": "203.0.113.99" },
    });
    assert.equal(
      blocked.status,
      403,
      "伪造 XFF 必须无法重置额度（默认不采信该头 ⇒ 计数键始终是 socket 地址）",
    );
  });
});

test("限流：显式声明可信代理时，XFF 才决定计数键（真反代部署仍按真实客户端限流）", async () => {
  const throttle = createAuthThrottle({ maxFailures: 3, windowMs: 60_000, banDurationMs: 60_000 });
  await withServer(
    {
      authToken: TOKEN,
      throttle,
      // 测试请求来自 127.0.0.1，因此把回环声明为可信代理，XFF 才会被采信。
      trustedProxies: parseTrustedProxies("127.0.0.1"),
    },
    async (baseUrl) => {
      // 同一个「客户端 A」失败 3 次 ⇒ 只封 A。
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const response = await fetch(baseUrl + "/api/server-info", {
          headers: { "x-forwarded-for": "198.51.100.10" },
        });
        assert.equal(response.status, 401);
      }
      assert.equal(
        (
          await fetch(baseUrl + "/api/server-info", {
            headers: { "x-forwarded-for": "198.51.100.10" },
          })
        ).status,
        403,
        "A 应被封禁",
      );
      assert.equal(
        (
          await fetch(baseUrl + "/api/server-info", {
            headers: { "x-forwarded-for": "198.51.100.11" },
          })
        ).status,
        401,
        "另一个真实客户端不得被牵连（这是「按真实客户端限流」的意义）",
      );
    },
  );
});

test("限流：封禁也覆盖 WebSocket 升级请求（`/ws` 是主要攻击面，不能只在 HTTP 上拦）", async () => {
  const throttle = createAuthThrottle({ maxFailures: 2, windowMs: 60_000, banDurationMs: 60_000 });
  await withServer({ authToken: TOKEN, throttle }, async (baseUrl) => {
    const wsBaseUrl = baseUrl.replace("http://", "ws://");
    assert.equal(
      await probeWebSocketUpgrade(wsBaseUrl, { Cookie: "zcode_lite_token=wrong" }),
      "HTTP 401",
    );
    assert.equal(
      await probeWebSocketUpgrade(wsBaseUrl, { Cookie: "zcode_lite_token=wrong-2" }),
      "HTTP 401",
    );
    assert.equal(
      await probeWebSocketUpgrade(wsBaseUrl, { Cookie: "zcode_lite_token=wrong-3" }),
      "HTTP 403",
      "封禁后 WS 升级也必须被拒（否则攻击者只用 WS 通道就绕过了限流）",
    );
    // 同一个正常令牌在封禁期内也连不上（与被拒的 HTTP 路径一致）。
    assert.equal(
      await probeWebSocketUpgrade(wsBaseUrl, { Cookie: "zcode_lite_token=" + TOKEN }),
      "HTTP 403",
    );
  });
});

test("限流：正常用户不受影响（偶发输错后一次正确就清零，且正确令牌照常可用）", async () => {
  const throttle = createAuthThrottle({ maxFailures: 3, windowMs: 60_000, banDurationMs: 60_000 });
  await withServer({ authToken: TOKEN, throttle }, async (baseUrl) => {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      assert.equal((await fetch(baseUrl + "/api/server-info")).status, 401);
    }
    const ok = await fetch(baseUrl + "/api/server-info?token=" + TOKEN);
    assert.equal(ok.status, 200, "输错两次后带对令牌必须仍然可用（不清零就会误伤正常用户）");
    assert.equal(throttle.failureCount("127.0.0.1"), 0, "成功后计数必须清零");
    // 再错两次仍远未到阈值（3）。
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      assert.equal((await fetch(baseUrl + "/api/server-info")).status, 401);
    }
    assert.equal((await fetch(baseUrl + "/api/server-info?token=" + TOKEN)).status, 200);
  });
});

test("反代误伤：未声明可信代理时封禁回环会连带封掉所有客户端，且必须给出可操作告警", async () => {
  const throttle = createAuthThrottle({ maxFailures: 2, windowMs: 60_000, banDurationMs: 60_000 });
  const warnings: string[] = [];
  const server = createHttpServer(new ServiceCollection(), 0, { authToken: TOKEN, throttle });
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((value) => String(value)).join(" "));
  };
  try {
    if (!server.listening) {
      await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    }
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const baseUrl = "http://127.0.0.1:" + port;
    // 模拟「反代后的两个不同客户端」：未声明可信代理 ⇒ 两者都表现为 127.0.0.1。
    assert.equal((await fetch(baseUrl + "/api/server-info")).status, 401, "客户端 A 的失败");
    assert.equal(
      (await fetch(baseUrl + "/api/server-info")).status,
      401,
      "客户端 B 的失败（同一计数桶）",
    );
    assert.equal(
      (await fetch(baseUrl + "/api/server-info?token=" + TOKEN)).status,
      403,
      "封禁回环 = 正常客户端也被拒（这正是必须说出来、而不该静默的后果）",
    );
    assert.equal(
      warnings.some((entry) => entry.includes("ZCODE_SERVER_TRUSTED_PROXIES")),
      true,
      "必须告警并指出该怎么修（登记可信代理）",
    );
  } finally {
    console.warn = originalWarn;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("令牌多源：`ZCODE_SERVER_AUTH_TOKEN` 与令牌文件里的令牌都能用，且不互相影响", async () => {
  const fileRecords = [{ token: "file-token-phone", label: "phone" }];
  const tokenSource = createAuthTokenStore({
    records: [{ token: TOKEN, label: "<env>" }],
    fileRecords,
  });
  await withServer({ tokenSource }, async (baseUrl) => {
    assert.equal(
      (await fetch(baseUrl + "/api/server-info?token=" + TOKEN)).status,
      200,
      "显式令牌可用",
    );
    assert.equal(
      (await fetch(baseUrl + "/api/server-info?token=file-token-phone")).status,
      200,
      "文件令牌可用",
    );
    assert.equal((await fetch(baseUrl + "/api/server-info?token=nope")).status, 401);
  });
});

test("令牌源为空集合 ⇒ 不种 cookie（避免「看似有鉴权、实则任何令牌都能种上」）", async () => {
  // 未配置任何令牌（回环下的合法形态：`--no-token`）。此时 /api 与 /ws 也必须仍然可访问，
  // 但不得出现 Set-Cookie —— 否则「种了一个空令牌」会被误读成鉴权已启用。
  await withServer({}, async (baseUrl) => {
    const response = await fetch(baseUrl + "/api/server-info");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("set-cookie"), null);
  });
});
