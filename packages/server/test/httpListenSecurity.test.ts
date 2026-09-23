import assert from "node:assert/strict";
import test from "node:test";
import { ServiceCollection } from "@zcode/services";
import {
  DEFAULT_HTTP_LISTEN_HOST,
  assertListenSecurity,
  createHttpServer,
  isLoopbackHost,
} from "../src/http.js";

/**
 * packages/server HTTP 入口的监听安全默认值。
 *
 * 为什么必须钉住：修复前不传 host 时服务端绑**所有网卡**，且未设置
 * `ZCODE_SERVER_AUTH_TOKEN` 时 /api/*、/ws、/ws/host 全部无鉴权可达 —— 实测可以从
 * 局域网 IP 无凭证读到 server-info 并发 /ws/host 的 trusted-host ticket（拿到即得
 * desktop-continuous 角色）。这几条断言是那次修复的护栏，详见
 * `.reverse/40-remote-control/SECURITY-SERVER-DEFAULTS.md`。
 *
 * 只绑回环：这些用例里的真实监听一律用 127.0.0.1 + 端口 0，绝不在 CI 上绑 0.0.0.0。
 * 非回环的「放行/拒绝」由纯函数 assertListenSecurity 覆盖。
 */

/** serve() 返回后绑定是异步的：必须等到 listening 再取端口，否则 address() 还是 null。 */
async function resolveListenPort(server: {
  listening: boolean;
  once: (event: "listening", listener: () => void) => unknown;
  address: () => unknown;
}): Promise<number> {
  if (!server.listening) {
    await new Promise<void>((resolve) => {
      server.once("listening", () => resolve());
    });
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

async function withLoopbackServer(
  options: { authToken?: string },
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createHttpServer(new ServiceCollection(), 0, options);
  try {
    const port = await resolveListenPort(server);
    await run("http://127.0.0.1:" + port);
  } finally {
    await closeServer(server);
  }
}

test("非回环 + 无 token：拒绝启动（fail-closed）", () => {
  for (const host of ["0.0.0.0", "::", "[::]", "192.168.1.10", "example.internal"]) {
    assert.throws(() => assertListenSecurity({ host }), /拒绝启动/, "host=" + host + " 必须被拒绝");
  }
  // 报错必须可操作：给出 token 的生成/设置方式与对外暴露的两种替代方案。
  assert.throws(() => assertListenSecurity({ host: "0.0.0.0" }), /ZCODE_SERVER_AUTH_TOKEN/);
  assert.throws(() => assertListenSecurity({ host: "0.0.0.0" }), /127.0.0.1/);
  // 集成层面：真正的入口函数在选择监听地址时就抛错，不存在「先监听再警告」的窗口。
  assert.throws(() => createHttpServer(new ServiceCollection(), 0, { host: "0.0.0.0" }));
});

test("回环 + 无 token：放行，且默认监听地址就是回环（本地开发不被打断）", async () => {
  assert.equal(DEFAULT_HTTP_LISTEN_HOST, "127.0.0.1");
  for (const host of ["127.0.0.1", "localhost", "::1", "[::1]", " 127.0.0.1 "]) {
    assert.equal(isLoopbackHost(host), true, "host=" + host + " 应判为回环");
    assert.doesNotThrow(() => assertListenSecurity({ host }));
  }
  for (const host of ["0.0.0.0", "::", "", "10.0.0.5"]) {
    assert.equal(isLoopbackHost(host), false, "host=" + host + " 不应判为回环");
  }

  // 不传 host 时真实绑定的必须是回环地址（此前是通配 *）。
  const server = createHttpServer(new ServiceCollection(), 0, {});
  try {
    await resolveListenPort(server);
    const address = server.address();
    assert.equal(
      typeof address === "object" && address !== null && "address" in address
        ? address.address
        : undefined,
      "127.0.0.1",
    );
  } finally {
    await closeServer(server);
  }
});

test("非回环 + token：放行", async () => {
  // 刻意不在 CI 上真的绑 0.0.0.0：放行判定由纯函数覆盖，真实监听放在回环上验证 token 链路。
  assert.doesNotThrow(() => assertListenSecurity({ host: "0.0.0.0", authToken: "secret" }));
  assert.doesNotThrow(() => assertListenSecurity({ host: "::", authToken: " secret " }));
  const server = createHttpServer(new ServiceCollection(), 0, {
    host: "127.0.0.1",
    authToken: "secret",
  });
  await resolveListenPort(server);
  await closeServer(server);
});

test("token 校验：无凭证 401，正确 token 放行，cookie 可复用", async () => {
  await withLoopbackServer({ authToken: "secret" }, async (baseUrl) => {
    assert.equal((await fetch(baseUrl + "/api/server-info")).status, 401);
    assert.equal((await fetch(baseUrl + "/api/server-info?token=wrong")).status, 401);

    const authorized = await fetch(baseUrl + "/api/server-info?token=secret");
    assert.equal(authorized.status, 200);
    const setCookie = authorized.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /zcode_lite_token=secret/);

    const cookie = setCookie.split(";")[0] ?? "";
    const replayed = await fetch(baseUrl + "/api/server-info", { headers: { cookie } });
    assert.equal(replayed.status, 200);
  });
});

test("token cookie 属性：HttpOnly + SameSite=Lax 恒定，Secure 只在 https（含反代）下出现", async () => {
  await withLoopbackServer({ authToken: "secret" }, async (baseUrl) => {
    const plain = await fetch(baseUrl + "/api/server-info?token=secret");
    const plainCookie = plain.headers.get("set-cookie") ?? "";
    assert.match(plainCookie, /HttpOnly/);
    assert.match(plainCookie, /SameSite=Lax/);
    assert.doesNotMatch(
      plainCookie,
      /Secure/,
      "明文 http 下加 Secure 会让 cookie 不被回发，登录必失败",
    );

    const proxied = await fetch(baseUrl + "/api/server-info?token=secret", {
      headers: { "x-forwarded-proto": "https" },
    });
    const proxiedCookie = proxied.headers.get("set-cookie") ?? "";
    assert.match(proxiedCookie, /Secure/);
    assert.match(proxiedCookie, /HttpOnly/);
    assert.match(proxiedCookie, /SameSite=Lax/);
  });
});
