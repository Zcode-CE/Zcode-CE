import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { Socket } from "node:net";
import { networkInterfaces } from "node:os";
import test from "node:test";
import { WebSocket } from "ws";
import { ServiceCollection } from "@zcode/services";
import { createHttpServer, type HttpServerOptions } from "../src/http.js";
import {
  buildTrustedHostEntries,
  evaluateHost,
  parseTrustedHosts,
  splitHostPort,
} from "../src/hostAllowlist.js";

/**
 * Host 白名单（task-39 / G6）—— 关掉 DNS rebinding 那条链。
 *
 * 为什么这组断言必须有牙：DNS rebinding 下攻击者页面的请求 `Origin: http://evil.com` 与
 * `Host: evil.com` **彼此一致**，所以 A-1 的来源校验会**放行**，而浏览器认为这是自己的同源、
 * 能读响应。只有 Host 白名单能拦住 —— 它一旦回归（比如有人觉得"回环访问不用校验"而加个例外），
 * 症状是"默认部署下浏览器里打开一个恶意页面即可接管工作区"，而且**没有任何其它测试会变红**。
 *
 * 两个钉住真实链路的点，不要删：
 * 1. `WebSocket 升级的 Host 也必须校验`：`/ws` 绕过中间件链的响应通道（node-ws 的适配器只取状态码），
 *    所以这条断言是"校验被挪回中间件"这类回归的唯一护栏。
 * 2. `用真实 socket 设置 Host`：undici 的 fetch 会覆盖 Host，只有裸 http 请求才能构造伪 Host。
 *
 * **反向验证（实测过）**：把 `app.use` 里的 Host 校验与 upgrade gate 的 Host 分支都去掉 ⇒
 * 「伪造 Host 必须 403」「WebSocket 升级的 Host 也必须校验」两条变红（并回到 200/OPEN）。
 */

const TOKEN = "host-allowlist-token";

function firstNonLoopbackInterfaceAddress(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4") {
        continue;
      }
      return entry.address;
    }
  }
  return undefined;
}

async function withServer(
  options: HttpServerOptions,
  run: (baseUrl: string, port: number) => Promise<void>,
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
    await run("http://127.0.0.1:" + port, port);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

/** 用裸 http 请求发一个**自定义 Host**（fetch/undici 不允许覆盖 Host，只能走这一层）。 */
function rawGet(params: { port: number; path: string; host?: string }): Promise<{
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}> {
  return requestOnHost({ ...params, connectHost: "127.0.0.1" });
}

/** 同上，但可指定**连接**地址（绑网卡时回环口不监听，必须连那个网卡地址）。 */
function requestOnHost(params: {
  connectHost: string;
  port: number;
  path: string;
  host?: string;
}): Promise<{
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: params.connectHost,
        port: params.port,
        path: params.path,
        method: "GET",
        ...(params.host === undefined ? {} : { headers: { host: params.host } }),
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => (body += String(chunk)));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body, headers: response.headers }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

function probeWebSocketUpgrade(
  port: number,
  headers: Record<string, string>,
): Promise<{
  result: string;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: { result: string; body: string }, headers = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...value, headers });
    };
    const socket = new WebSocket("ws://127.0.0.1:" + port + "/ws", { headers });
    const timer = setTimeout(() => {
      socket.terminate();
      finish({ result: "TIMEOUT", body: "" });
    }, 5000);
    socket.on("open", () => {
      socket.close();
      finish({ result: "OPEN", body: "" });
    });
    socket.on("unexpected-response", (_request, response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        finish(
          {
            result: "HTTP " + String(response.statusCode),
            body: Buffer.concat(chunks).toString("utf8"),
          },
          response.headers,
        ),
      );
    });
    socket.on("error", (error) => {
      const match = /Unexpected server response: (\d+)/.exec(error.message);
      finish(
        match
          ? { result: "HTTP " + match[1], body: "" }
          : { result: "ERROR " + error.message, body: "" },
      );
    });
  });
}

/** 直接读服务实际监听的端口（withServer 只给 baseUrl，升级探测需要端口）。 */
async function listenPort(server: {
  listening: boolean;
  once: (e: "listening", l: () => void) => unknown;
  address: () => unknown;
}): Promise<number> {
  if (!server.listening) {
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  }
  const address = server.address();
  return typeof address === "object" && address ? Number((address as { port: number }).port) : 0;
}

// ---------------------------------------------------------------------------
// 一、解析与判定口径
// ---------------------------------------------------------------------------

test("解析：支持 host / host:port / [IPv6] / [IPv6]:port，非法项丢弃", () => {
  assert.deepEqual(parseTrustedHosts("panel.example, gw.internal:8443 ,[::1],[2001:db8::5]:3030"), [
    { host: "panel.example" },
    { host: "gw.internal", port: 8443 },
    { host: "::1" },
    { host: "2001:db8::5", port: 3030 },
  ]);
  for (const bad of [
    "",
    "   ",
    "host:abc",
    "host:0",
    "host:70000",
    "1.2.3.4:80/path",
    "a b",
    "host:",
    // 注：`::1:3030` 不在这里 —— 它整体是合法 IPv6 字面量（见下面「拆分」用例的说明）。
  ]) {
    assert.deepEqual(parseTrustedHosts(bad), [], JSON.stringify(bad) + " 必须被丢弃");
  }
});

test("拆分：畸形 Host（空/路径/空白/端口非数字）⇒ null（fail-closed）", () => {
  for (const bad of [
    undefined,
    "",
    "   ",
    "evil.com/",
    "evil.com?x=1",
    "e vil.com",
    "host:abc",
    "[::1",
    "[::1]x",
  ]) {
    assert.equal(splitHostPort(bad), null, JSON.stringify(bad) + " 必须判为畸形");
  }
  // 注意（实现期修正过一条错误预期）：`::1:3030` **不是**畸形 —— 它整体是合法 IPv6 字面量
  // （`isIP()` 返回 6）。RFC 7230 要求 IPv6 带端口时加方括号，所以"不带方括号 + 端口"这个形态
  // 无歧义可解；我们的处理是把它当纯 IPv6 主机名，于是它永远匹配不上任何白名单条目（fail-closed）。
  // 这一点由下面两条断言钉住，而不是靠"判为畸形"。
  assert.deepEqual(splitHostPort("::1:3030"), { host: "::1:3030" }, "整体按 IPv6 字面量解析");
  assert.equal(
    evaluateHost("::1:3030", buildTrustedHostEntries({ listenHost: "127.0.0.1" })).allowed,
    false,
    "该形态不得命中任何白名单条目（fail-closed）",
  );
  assert.deepEqual(
    splitHostPort("Panel.Example."),
    { host: "panel.example" },
    "大小写与尾随点归一",
  );
  assert.deepEqual(splitHostPort("[::1]:3030"), { host: "::1", port: 3030 });
  assert.deepEqual(splitHostPort("1.2.3.4:80"), { host: "1.2.3.4", port: 80 });
});

test("默认白名单：回环各形态与本机网卡地址都放行（默认绑局域网仍要能用）", () => {
  const entries = buildTrustedHostEntries({ listenHost: "127.0.0.1" });
  for (const host of [
    "127.0.0.1",
    "127.0.0.1:3030",
    "127.9.9.9:8080",
    "::1",
    "[::1]",
    "[::1]:3030",
    "localhost",
    "LOCALHOST:3030",
    "localhost.",
  ]) {
    assert.equal(evaluateHost(host, entries).allowed, true, host + " 必须放行（回环形态）");
  }
  const nic = firstNonLoopbackInterfaceAddress();
  if (nic) {
    assert.equal(evaluateHost(nic, entries).allowed, true, nic + "（本机网卡地址）必须放行");
    assert.equal(evaluateHost(nic + ":3030", entries).allowed, true);
  }
  assert.equal(
    evaluateHost("0.0.0.0:3030", entries).allowed,
    false,
    "通配地址不是可访问的主机名，不得放行",
  );
});

test("**伪 Host 必须被拒**（未配置域名时不得放行任意 Host）", () => {
  const entries = buildTrustedHostEntries({ listenHost: "127.0.0.1" });
  for (const host of [
    "evil.com",
    "evil.com:3030",
    "attacker.example.",
    "notlocalhost",
    "localhost.evil.com",
    "127.0.0.1.evil.com",
  ]) {
    const decision = evaluateHost(host, entries);
    assert.equal(decision.allowed, false, host + " 必须被拒");
    assert.match(
      String(decision.reason),
      /ZCODE_SERVER_TRUSTED_HOSTS/,
      "拒绝原因必须可操作（指出该配哪个变量）",
    );
  }
});

test("端口语义：登记时不写端口 ⇒ 任意端口；写了端口 ⇒ 必须相等", () => {
  const anyPort = buildTrustedHostEntries({ configuredEntries: [{ host: "panel.example" }] });
  assert.equal(evaluateHost("panel.example:1", anyPort).allowed, true);
  assert.equal(evaluateHost("panel.example:65535", anyPort).allowed, true);
  const fixedPort = buildTrustedHostEntries({
    configuredEntries: [{ host: "gw.internal", port: 8443 }],
  });
  assert.equal(evaluateHost("gw.internal:8443", fixedPort).allowed, true);
  assert.equal(
    evaluateHost("gw.internal:443", fixedPort).allowed,
    false,
    "端口不同必须拒（配置写清了端口）",
  );
  assert.equal(
    evaluateHost("gw.internal", fixedPort).allowed,
    false,
    "没带端口的 Host 不等同于带端口那条",
  );
});

test("缺失/畸形 Host ⇒ 拒绝（fail-closed，HTTP/1.0 无 Host 也在内）", () => {
  const entries = buildTrustedHostEntries({ listenHost: "127.0.0.1" });
  const missing = evaluateHost(undefined, entries);
  assert.equal(missing.allowed, false);
  assert.match(String(missing.reason), /Host 头缺失或畸形/);
  for (const bad of ["", "   ", "evil.com/path", "a b"]) {
    assert.equal(evaluateHost(bad, entries).allowed, false, JSON.stringify(bad) + " 必须被拒");
  }
});

test("服务实际监听地址总在白名单里（绑哪张网卡就一定能用该地址访问）", () => {
  const entries = buildTrustedHostEntries({
    listenHost: "10.1.2.3",
    extraLocalAddresses: [],
    configuredEntries: [],
  });
  assert.equal(evaluateHost("10.1.2.3", entries).allowed, true, "监听地址本身必须放行");
  assert.equal(evaluateHost("10.1.2.3:3030", entries).allowed, true);
});

// ---------------------------------------------------------------------------
// 二、打到最终消费点：真实服务端
// ---------------------------------------------------------------------------

test("真实服务端：伪造 Host 403 且带拒绝标记与安全头；合法 Host 照旧", async () => {
  await withServer({ authToken: TOKEN }, async (_baseUrl, port) => {
    // 用裸 http 请求构造伪 Host（fetch 不允许覆盖 Host）。
    const fake = await rawGet({ port, path: "/api/server-info?token=" + TOKEN, host: "evil.com" });
    assert.equal(fake.status, 403, "伪 Host 必须 403");
    assert.match(fake.body, /ZCODE_SERVER_TRUSTED_HOSTS/, "403 必须给出可操作原因");
    assert.equal(fake.headers["x-zcode-host-rejected"], "1", "必须带拒绝标记头");
    assert.equal(fake.headers["x-content-type-options"], "nosniff", "拒绝响应也必须带安全头");

    const legit = await rawGet({
      port,
      path: "/api/server-info?token=" + TOKEN,
      host: "127.0.0.1:" + port,
    });
    assert.equal(legit.status, 200, "合法 Host（回环 + 真实端口）必须照旧");

    const noHost = await rawGet({ port, path: "/api/server-info?token=" + TOKEN });
    assert.equal(noHost.status, 200, "不显式设置 Host 时 Node 会自动带 127.0.0.1:port ⇒ 放行");

    // 这里只验「不匹配就拒」，避免嵌套起服务把断言意图搅浑。
  });
});

test("真实服务端：**WebSocket 升级的 Host 也必须校验**（/ws 绕过中间件通道）", async () => {
  // 这条是「有人把 Host 校验挪回中间件」这类回归的唯一护栏：中间件里返回的 403 在升级路径上
  // 会被 node-ws 的适配器丢掉响应体与响应头（A-1 实测），所以校验必须留在 HTTP 层。
  const server = createHttpServer(new ServiceCollection(), 0, { authToken: TOKEN });
  try {
    const port = await listenPort(server);
    const fake = await probeWebSocketUpgrade(port, {
      host: "evil.com",
      Cookie: "zcode_lite_token=" + TOKEN,
    });
    assert.equal(fake.result, "HTTP 403", "伪 Host 的 WS 升级必须 403");
    assert.match(fake.body, /ZCODE_SERVER_TRUSTED_HOSTS/, "拒绝必须给出可操作原因（不是空 403）");
    assert.equal(fake.headers["x-zcode-host-rejected"], "1");
    assert.equal(fake.headers["x-content-type-options"], "nosniff", "升级拒绝也必须带安全头");

    const legit = await probeWebSocketUpgrade(port, {
      host: "127.0.0.1:" + port,
      Cookie: "zcode_lite_token=" + TOKEN,
    });
    assert.equal(legit.result, "OPEN", "合法 Host 的 WS 升级必须照旧可用");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("真实服务端：登记反代域名后该 Host 必须放行（加固不得打死合法部署）", async () => {
  await withServer(
    { authToken: TOKEN, trustedHosts: [{ host: "panel.example" }] },
    async (_baseUrl, port) => {
      const allowed = await rawGet({
        port,
        path: "/api/server-info?token=" + TOKEN,
        host: "panel.example",
      });
      assert.equal(allowed.status, 200, "登记后的反代域名必须放行");

      const withPort = await rawGet({
        port,
        path: "/api/server-info?token=" + TOKEN,
        host: "panel.example:8443",
      });
      assert.equal(withPort.status, 200, "未写端口的登记项应接受任意端口（文档写明的语义）");

      const otherHost = await rawGet({
        port,
        path: "/api/server-info?token=" + TOKEN,
        host: "other.example",
      });
      assert.equal(otherHost.status, 403, "未登记的其它域名仍必须被拒");
    },
  );
});

test("真实服务端：绑本机非回环网卡 + 用该网卡 IP 访问必须照旧（默认绑局域网仍可用）", async () => {
  const nic = firstNonLoopbackInterfaceAddress();
  const bindHost = nic ?? "127.0.0.1";
  const server = createHttpServer(new ServiceCollection(), 0, { host: bindHost, authToken: TOKEN });
  try {
    const port = await listenPort(server);
    // 必须连**绑定的那个地址**：绑在网卡上时回环口根本不监听（第一版写成 rawGet 连 127.0.0.1，
    // 实测 ECONNREFUSED —— 那是测试写错，不是功能坏）。
    const response = await requestOnHost({
      connectHost: bindHost,
      port,
      path: "/api/server-info?token=" + TOKEN,
      host: bindHost + ":" + port,
    });
    assert.equal(
      response.status,
      200,
      (nic ? "绑网卡 IP 后用该 IP 访问" : "回环回退") + " 必须照旧可用",
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** 起一个服务、跑回调、关掉（需要自己拿端口的用例用）。 */
async function withServerReturning<T>(
  options: HttpServerOptions,
  run: (port: number) => Promise<T>,
): Promise<T> {
  const server = createHttpServer(new ServiceCollection(), 0, options);
  try {
    const port = await listenPort(server);
    return await run(port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// 保留一个显式的「无 Host 原始请求」用例：用裸 socket 发 HTTP/1.1 且不带 Host 头。
test("原始 socket：HTTP/1.1 不带 Host ⇒ 被拒（实测 Node 解析器先返回 400，两者都是 fail-closed）", async () => {
  const server = createHttpServer(new ServiceCollection(), 0, { authToken: TOKEN });
  try {
    const port = await listenPort(server);
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const client = new Socket();
      let buffer = "";
      client.on("error", reject);
      client.connect(port, "127.0.0.1", () => {
        // 故意只发请求行 + 一个空行：没有 Host。
        client.write("GET /api/server-info HTTP/1.1\r\nConnection: close\r\n\r\n");
      });
      client.on("data", (chunk: Buffer) => (buffer += chunk.toString()));
      client.on("end", () => {
        const status = Number((/HTTP\/1\.1 (\d+)/.exec(buffer) ?? [])[1] ?? 0);
        resolve({ status, body: buffer });
      });
    });
    // 实测：Node 的 HTTP 解析器对「HTTP/1.1 且无 Host」直接判 400 Bad Request，
    // 我们的白名单中间件根本不会被调用。两者都是 fail-closed，所以断言接受 400/403，
    // 但**明确不接受 200** —— 那才是这条链敞开的样子。
    assert.ok(
      response.status === 400 || response.status === 403,
      "不带 Host 的 HTTP/1.1 请求必须被拒（实测 400/403），实际 " + String(response.status),
    );
    assert.notEqual(response.status, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
