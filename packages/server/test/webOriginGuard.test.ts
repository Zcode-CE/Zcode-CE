import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { ServiceCollection } from "@zcode/services";
import { createHttpServer, type HttpServerOptions } from "../src/http.js";
import {
  buildSecurityHeaders,
  evaluateRequestOrigin,
  evaluateUpgradeOrigin,
  parseTrustedOrigins,
  shouldGuardRequest,
} from "../src/webExposureGuard.js";

/**
 * 跨站请求防护（CSRF）与安全响应头的护栏（task-34 / SURVEY.md 的 G1、G2、G5）。
 *
 * 为什么必须有这组测试：这两条是「不看代码就看不出来」的漏洞 ——
 * - G2：WebSocket 握手不受同源策略约束（RFC 6455 §4.1/§10.2），不校验 Origin 就等于
 *   「一个已授权的浏览器会话 + 任意恶意页面 = 完全接管工作区」；
 * - G1：`POST /api/rpc-host-capability` 无请求体、无自定义头，跨站表单即可触发并拿到
 *   trusted-host ticket，再走 `/ws/host` 拿比普通终端客户端更高的角色。
 *
 * **反向验证（实测过，去掉判定即变红）**：把 `createCrossSiteGuard` 里的
 * `if (decision.allowed)` 那段替换为无条件 `await next()`，
 * 则本文件「错误 Origin」与「Origin=null」两档全部变红；把
 * `Content-Security-Policy-Report-Only`/`X-Frame-Options` 两个 header 注释掉，
 * 则「安全响应头」一节的 4 条变红。
 */

const TOKEN = "s3cret";
const OTHER_PORT = 3799; // 只用于构造「同 host 不同端口」的跨源 Origin
const SELF_ORIGIN = "http://127.0.0.1:3030";
const CROSS_SITE_ORIGIN = "https://attacker.example";
/** 反代部署常见的「同站但不同端口」：不同于 CROSS_SITE_ORIGIN 的另一类跨源（same-site, cross-origin）。 */
const SAME_SITE_DIFFERENT_PORT = "http://127.0.0.1:" + OTHER_PORT;

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "zcode-origin-guard-"));
  const staticRoot = join(root, "web");
  await mkdir(join(staticRoot, "assets"), { recursive: true });
  await writeFile(join(staticRoot, "index.html"), "<!doctype html><title>shell-fixture</title>");
  await writeFile(join(staticRoot, "assets/app.js"), "console.log('shell-asset');");
  return { root, staticRoot };
}

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

/** 拿到一个合法 cookie（走 `?token=` 落地链路，与手机首次打开一致）。 */
async function authorizedCookie(baseUrl: string): Promise<string> {
  const response = await fetch(baseUrl + "/api/server-info?token=" + TOKEN);
  assert.equal(response.status, 200, "带 ?token= 的落地请求必须 200");
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  assert.match(cookie, /zcode_lite_token=/);
  return cookie;
}

/** 探测一次 WS 升级结果："OPEN" / "HTTP <code>" / "ERROR ..." / "TIMEOUT"。 */
function probeWebSocket(
  wsBaseUrl: string,
  path: string,
  headers?: Record<string, string>,
): Promise<string> {
  return new Promise<string>((resolve) => {
    let settled = false;
    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const socket = new WebSocket(wsBaseUrl + path, headers ? { headers } : undefined);
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
      // 被拒绝时 ws 客户端可能只发 error 事件，错误消息里带状态码，从中提取以便断言。
      const match = /Unexpected server response: (\d+)/.exec(error.message);
      finish(match ? "HTTP " + match[1] : "ERROR " + error.message);
    });
  });
}

/** 与 probeWebSocket 同形，但把被拒的 HTTP 响应对象交回来（用于断言拒绝响应也带安全头）。 */
function probeWebSocketResponse(url: string, headers: Record<string, string>): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.on("unexpected-response", (_request, response) => {
      // ws 的 IncomingMessage 是流：必须把 body 读出来再包成 Response，
      // 否则断言响应体只会看到空串（「HTTP 层拒绝」的价值恰恰在于客户端能拿到原因）。
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve(
          new Response(Buffer.concat(chunks), {
            status: response.statusCode ?? 0,
            headers: Object.entries(response.headers).flatMap(([name, value]) =>
              value === undefined
                ? []
                : Array.isArray(value)
                  ? value.map((v): [string, string] => [name, v])
                  : [[name, String(value)] as [string, string]],
            ),
          }),
        );
      });
    });
    socket.on("open", () => {
      socket.close();
      reject(new Error("意外：跨站 WS 竟然升级成功"));
    });
    socket.on("error", (error) => reject(error));
    setTimeout(() => reject(new Error("TIMEOUT")), 5000);
  });
}

// ---------------------------------------------------------------------------
// 一、纯函数口径：五档 × 两类端点
// ---------------------------------------------------------------------------

/** 五档的来源形状（后两档是「合法但不同源」的两种典型部署）。 */
const ORIGIN_TIERS = [
  { name: "无 Origin（非浏览器客户端：CLI/桌面/ws 库）", origin: undefined },
  { name: "错误 Origin（跨站站点）", origin: CROSS_SITE_ORIGIN },
  {
    name: "同 host 不同端口的 Origin（same-site, cross-origin）",
    origin: SAME_SITE_DIFFERENT_PORT,
  },
  { name: "Origin 为 null 的隔离上下文", origin: "null" },
  { name: "同源 Origin（与 Host 一致）", origin: SELF_ORIGIN },
];

const ENDPOINTS = [
  { name: "WS /ws", method: "GET", pathname: "/ws", websocket: true },
  { name: "WS /ws/host", method: "GET", pathname: "/ws/host", websocket: true },
  { name: "WS /ws/remote/x", method: "GET", pathname: "/ws/remote/x", websocket: true },
  { name: "POST /api/rpc-host-capability", method: "POST", pathname: "/api/rpc-host-capability" },
  { name: "POST /api/connect-remote", method: "POST", pathname: "/api/connect-remote" },
  {
    name: "DELETE /api/anything（未来写方法）",
    method: "DELETE",
    pathname: "/api/anything",
  },
  // 读方法与被公开的路径：**不在保护面内**，必须有明确期望，否则会误伤静态壳与既有链路。
  {
    name: "GET /api/server-info（读方法，不在保护面）",
    method: "GET",
    pathname: "/api/server-info",
  },
  { name: "GET /（SPA 壳，不在保护面）", method: "GET", pathname: "/" },
];

/** 每档的期望结论 + 理由（写成数据，便于对照 matrix 与实现是否一致）。 */
const EXPECTED: Record<string, { allowed: boolean; why: string }> = {
  "无 Origin（非浏览器客户端：CLI/桌面/ws 库）": {
    allowed: true,
    why: "浏览器对任何跨站请求都会带 Origin；不带 Origin 的只可能是非浏览器客户端，而这类客户端可以随意伪造 Origin，来源校验对它本就没有意义（拦住它的是令牌层）。放行是为了不打断 CLI/桌面与既有鉴权覆盖测试。",
  },
  "错误 Origin（跨站站点）": { allowed: false, why: "典型 CSRF：恶意站点发起的跨站请求。" },
  "同 host 不同端口的 Origin（same-site, cross-origin）": {
    allowed: false,
    why: "same-site 不等于 same-origin；端口不同就是跨源，不能被 cookie 的 SameSite 覆盖，必须按跨源拒绝。",
  },
  "Origin 为 null 的隔离上下文": {
    allowed: false,
    why: "sandbox iframe / data: / 部分重定向会把 Origin 设成字面量 null；它不是任何合法来源。",
  },
  "同源 Origin（与 Host 一致）": { allowed: true, why: "正常的同源前端。" },
};

test("五档 × 八端点的判定矩阵：每档结论与理由一致", () => {
  for (const endpoint of ENDPOINTS) {
    // 与中间件同一口径：先问「在不在保护面内」，再问「这个来源允不允许」。
    // 不走 shouldGuardRequest 就会出现「纯函数拒绝、真实中间件放行」的口径漂移。
    const inScope = shouldGuardRequest(endpoint.method, endpoint.pathname);
    for (const tier of ORIGIN_TIERS) {
      const expected = inScope ? EXPECTED[tier.name] : { allowed: true, why: "不在保护面内" };
      const decision = inScope
        ? evaluateRequestOrigin(
            {
              method: endpoint.method,
              pathname: endpoint.pathname,
              originHeader: tier.origin,
              hostHeader: "127.0.0.1:3030",
              protocol: "http:",
            },
            [],
          )
        : { allowed: true };
      assert.equal(
        decision.allowed,
        expected.allowed,
        endpoint.name +
          " × " +
          tier.name +
          " 期望 " +
          (expected.allowed ? "放行" : "拒绝") +
          "（理由：" +
          expected.why +
          "），实际 " +
          (decision.allowed ? "放行" : "拒绝：" + decision.reason),
      );
    }
  }
});

test("升级判定：WS 路径恒在保护面内（不管用什么方法探查），HTTP 读方法不在", () => {
  for (const pathname of ["/ws", "/ws/host", "/ws/remote/xyz"]) {
    assert.equal(
      evaluateUpgradeOrigin(
        { pathname, originHeader: CROSS_SITE_ORIGIN, hostHeader: "127.0.0.1:3030" },
        [],
      ).allowed,
      false,
      pathname + " 的跨源升级必须被拒（HTTP 层 gate 用的就是这个判定）",
    );
    assert.equal(
      evaluateUpgradeOrigin({ pathname, hostHeader: "127.0.0.1:3030" }, []).allowed,
      true,
      pathname + " 无 Origin 时必须放行（非浏览器客户端路径）",
    );
  }
  assert.equal(shouldGuardRequest("GET", "/ws"), true);
  assert.equal(shouldGuardRequest("GET", "/api/server-info"), false, "GET 读接口不在保护面内");
  assert.equal(
    shouldGuardRequest("POST", "/api/server-info"),
    true,
    "同路径一旦是写方法就必须保护",
  );
});

test("同源判定：默认端口等价、不同协议不等价、畸形 Origin 一律拒绝", () => {
  const decide = (origin: string, host: string, protocol = "http:") =>
    evaluateRequestOrigin(
      {
        method: "POST",
        pathname: "/api/rpc-host-capability",
        originHeader: origin,
        hostHeader: host,
        protocol,
      },
      [],
    ).allowed;

  assert.equal(
    decide("https://panel.example", "panel.example:443", "https:"),
    true,
    "显式 :443 与缺省端口应等价",
  );
  assert.equal(decide("https://panel.example:443", "panel.example", "https:"), true);
  assert.equal(decide("http://panel.example", "panel.example:8443"), false, "端口不同必须拒绝");
  assert.equal(decide("https://panel.example", "panel.example"), false, "协议不同必须拒绝");
  assert.equal(
    decide("https://panel.example/evil", "panel.example"),
    false,
    "Origin 里带路径应判为畸形并拒绝",
  );
  assert.equal(decide("file:///etc/passwd", "panel.example"), false, "非 http(s) 协议应拒绝");
  assert.equal(decide("not a url", "panel.example"), false, "不可解析的 Origin 应拒绝");
  assert.equal(decide(CROSS_SITE_ORIGIN, "panel.example", "https:"), false);
});

test("跨源合法部署：只有登记在 trustedOrigins 里的来源才放行", () => {
  const trusted = parseTrustedOrigins(
    "https://panel.example, http://gateway.internal:8443 , ,nonsense",
  );
  assert.deepEqual(
    trusted,
    ["https://panel.example", "http://gateway.internal:8443"],
    "缺省端口应被归一化，空项与不可解析项应被丢弃",
  );
  const decide = (origin: string) =>
    evaluateRequestOrigin(
      {
        method: "POST",
        pathname: "/api/rpc-host-capability",
        originHeader: origin,
        hostHeader: "127.0.0.1:3030",
        protocol: "http:",
      },
      trusted,
    ).allowed;
  assert.equal(decide("https://panel.example"), true, "显式登记的来源应放行");
  assert.equal(decide("http://gateway.internal:8443"), true, "带端口登记的来源应放行");
  assert.equal(decide("https://other.example"), false, "未登记来源仍拒绝");
});

test("安全响应头：nosniff/frame-ancestors 无条件；CSP 默认 report-only；HSTS 只在 https 且显式开启", () => {
  const defaults = buildSecurityHeaders({ secure: false });
  assert.equal(defaults["X-Content-Type-Options"], "nosniff");
  assert.equal(defaults["X-Frame-Options"], "DENY");
  assert.equal(defaults["Referrer-Policy"], "no-referrer");
  assert.equal(defaults["Content-Security-Policy-Report-Only"], "frame-ancestors 'none'");
  assert.equal(defaults["Content-Security-Policy"], undefined, "默认不得 enforce（先观察期）");
  assert.equal(defaults["Strict-Transport-Security"], undefined, "默认不得下发 HSTS");

  assert.equal(
    buildSecurityHeaders({ secure: false, hsts: true })["Strict-Transport-Security"],
    undefined,
    "明文 http 下不得下发 HSTS（否则把用户锁出明文入口）",
  );
  assert.match(
    buildSecurityHeaders({ secure: true, hsts: true })["Strict-Transport-Security"] ?? "",
    /^max-age=31536000; includeSubDomains$/,
  );
  assert.equal(
    buildSecurityHeaders({ secure: true, cspMode: "enforce" })["Content-Security-Policy"],
    "frame-ancestors 'none'",
  );
  assert.equal(
    buildSecurityHeaders({ secure: true, cspMode: "off" })["Content-Security-Policy-Report-Only"],
    undefined,
  );
  assert.equal(
    buildSecurityHeaders({ secure: true, cspMode: "off" })["X-Frame-Options"],
    "DENY",
    "点击劫持防护与 CSP 模式无关，不得被 off 一并关掉",
  );
});

// ---------------------------------------------------------------------------
// 二、打到最终消费点：真实服务端 + 真实 WS 客户端 + 真实 HTTP 请求
// ---------------------------------------------------------------------------

test("真实服务端：五档 × WS 与危险 HTTP 端点的实测结果", async () => {
  const fixture = await createFixture();
  try {
    await withServer({ authToken: TOKEN, staticRoot: fixture.staticRoot }, async (baseUrl) => {
      const wsBaseUrl = baseUrl.replace("http://", "ws://");
      const cookie = await authorizedCookie(baseUrl);
      const cookieHeader = { Cookie: cookie };

      // ① 无凭据 + 无 Origin ⇒ 401（令牌层）。这条钉住既有语义不被来源层改写。
      assert.equal(
        await probeWebSocket(wsBaseUrl, "/ws"),
        "HTTP 401",
        "无凭据无 Origin 应仍是 401",
      );

      // ② 带凭据 + 无 Origin ⇒ 允许升级（非浏览器客户端路径，含既有鉴权覆盖测试与 CLI/桌面）。
      assert.equal(
        await probeWebSocket(wsBaseUrl, "/ws", cookieHeader),
        "OPEN",
        "带 cookie 且无 Origin 应允许",
      );

      // ③ 带凭据 + 错误 Origin ⇒ 403（**核心安全断言**）。
      assert.equal(
        await probeWebSocket(wsBaseUrl, "/ws", { ...cookieHeader, Origin: CROSS_SITE_ORIGIN }),
        "HTTP 403",
        "带 cookie 的跨站 WS 必须被拒",
      );
      assert.equal(
        await probeWebSocket(wsBaseUrl, "/ws/host", { ...cookieHeader, Origin: CROSS_SITE_ORIGIN }),
        "HTTP 403",
      );
      assert.equal(
        await probeWebSocket(wsBaseUrl, "/ws/remote/x", {
          ...cookieHeader,
          Origin: CROSS_SITE_ORIGIN,
        }),
        "HTTP 403",
      );
      // same-site 不同端口同样拒绝。
      assert.equal(
        await probeWebSocket(wsBaseUrl, "/ws", {
          ...cookieHeader,
          Origin: SAME_SITE_DIFFERENT_PORT,
        }),
        "HTTP 403",
      );

      // ④ 带凭据 + 同源 Origin ⇒ 允许升级（浏览器正常路径）。
      assert.equal(
        await probeWebSocket(wsBaseUrl, "/ws", { ...cookieHeader, Origin: baseUrl }),
        "OPEN",
        "同源 Browser 客户端必须照旧可用",
      );

      // ⑤ 危险 HTTP 端点：错误 Origin ⇒ 403 且**不签发 capability**。
      const crossSite = await fetch(baseUrl + "/api/rpc-host-capability", {
        method: "POST",
        headers: { ...cookieHeader, Origin: CROSS_SITE_ORIGIN },
      });
      assert.equal(crossSite.status, 403, "跨站 POST 必须 403");
      const body = await crossSite.text();
      assert.doesNotMatch(body, /capability/i, "403 响应体不得包含 capability");
      assert.match(body, /跨站/, "403 必须给出可操作原因");

      // 同源 POST ⇒ 200 且真的签发 capability（证明拒绝是「按来源」而不是「把端点打死了」）。
      const sameOrigin = await fetch(baseUrl + "/api/rpc-host-capability", {
        method: "POST",
        headers: { ...cookieHeader, Origin: baseUrl },
      });
      assert.equal(sameOrigin.status, 200, "同源 POST 必须仍能签发 capability");
      const issued = (await sameOrigin.json()) as { capability?: string };
      assert.ok(issued.capability, "同源应拿到 capability");

      // 无 Origin + 带凭据（curl/CLI）⇒ 放行，且 capability 可用。
      const noOrigin = await fetch(baseUrl + "/api/rpc-host-capability", {
        method: "POST",
        headers: cookieHeader,
      });
      assert.equal(noOrigin.status, 200, "无 Origin 的 CLI/curl 路径不得被误伤");

      // 写方法的跨站 POST /api/connect-remote 同样拒绝（这条同时挡住服务端替攻击者出网）。
      const connectRemote = await fetch(baseUrl + "/api/connect-remote", {
        method: "POST",
        headers: { ...cookieHeader, Origin: CROSS_SITE_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ kind: "ssh" }),
      });
      assert.equal(connectRemote.status, 403, "跨站 POST /api/connect-remote 必须 403");
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("真实服务端：安全响应头打到静态壳、API 401 与 WS 拒绝响应上", async () => {
  const fixture = await createFixture();
  try {
    await withServer({ authToken: TOKEN, staticRoot: fixture.staticRoot }, async (baseUrl) => {
      for (const [label, response] of [
        ["SPA 壳", await fetch(baseUrl + "/")],
        ["静态资产", await fetch(baseUrl + "/assets/app.js")],
        ["未授权 API", await fetch(baseUrl + "/api/server-info")],
        [
          // fetch/undici 不允许手工设置 Upgrade 头，这里用真实 WS 客户端拿被拒响应，
          // 顺便证明「拒绝响应」本身也带安全头。
          "跨站 WS 拒绝",
          await (async () => {
            const cookie = await authorizedCookie(baseUrl);
            const rejected = await probeWebSocketResponse(
              baseUrl.replace("http://", "ws://") + "/ws",
              {
                Cookie: cookie,
                Origin: CROSS_SITE_ORIGIN,
              },
            );
            // 这条断言是「为什么必须在 HTTP 层拒绝」的护栏：@hono/node-ws 的升级适配器
            // 只保留状态码、把响应体与响应头一起丢掉（实测过，若不修就是空的 403）。
            assert.equal(rejected.status, 403, "跨站升级必须在 HTTP 层被拒");
            const rejectionBody = await rejected.text();
            assert.match(
              rejectionBody,
              /跨站/,
              "被拒的升级请求必须拿到可操作原因（而不是空的 403）",
            );
            assert.equal(
              rejected.headers.get("x-zcode-cross-site-rejected"),
              "1",
              "被拒的升级响应必须带来源拒绝标记头",
            );
            return rejected;
          })(),
        ],
      ] as const) {
        assert.equal(
          response.headers.get("x-content-type-options"),
          "nosniff",
          label + " 缺 nosniff",
        );
        assert.equal(
          response.headers.get("x-frame-options"),
          "DENY",
          label + " 缺 X-Frame-Options",
        );
        assert.equal(
          response.headers.get("referrer-policy"),
          "no-referrer",
          label + " 缺 Referrer-Policy",
        );
        assert.equal(
          response.headers.get("content-security-policy-report-only"),
          "frame-ancestors 'none'",
          label + " 缺 report-only CSP",
        );
        assert.equal(
          response.headers.get("strict-transport-security"),
          null,
          label + " 明文下不得有 HSTS",
        );
      }
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("真实服务端：跨源白名单生效后，登记来源可 POST、未登记来源仍被拒", async () => {
  const fixture = await createFixture();
  try {
    await withServer(
      {
        authToken: TOKEN,
        staticRoot: fixture.staticRoot,
        trustedOrigins: ["https://panel.example"],
      },
      async (baseUrl) => {
        const cookie = await authorizedCookie(baseUrl);
        const trusted = await fetch(baseUrl + "/api/rpc-host-capability", {
          method: "POST",
          headers: { Cookie: cookie, Origin: "https://panel.example" },
        });
        assert.equal(trusted.status, 200, "登记来源必须放行（否则反代部署无法工作）");
        const untrusted = await fetch(baseUrl + "/api/rpc-host-capability", {
          method: "POST",
          headers: { Cookie: cookie, Origin: CROSS_SITE_ORIGIN },
        });
        assert.equal(untrusted.status, 403, "未登记来源必须仍被拒");
      },
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
