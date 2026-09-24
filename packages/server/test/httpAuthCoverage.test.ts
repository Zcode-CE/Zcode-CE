import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { ServiceCollection } from "@zcode/services";
import { createHttpServer } from "../src/http.js";
import { createAuthThrottle } from "../src/authThrottle.js";

/**
 * 鉴权覆盖面回归（task-21 缺陷 (b) 的护栏）。
 *
 * 背景：用户实测报「不带 token 也能进页面」。逐路由实测的结论是**没有鉴权缺口**：
 * 静态壳按设计公开、/api/* 与 /ws* 一律 401。但探测中发现一处口径漏洞：
 * `GET /api`（无尾斜杠）既不匹配 `/api/` 前缀，就落进了静态 SPA fallback 返回 index.html(200)。
 * 它不泄漏业务数据，但 API 命名空间本身不该被静态兜底接走 —— 这里把它和它的同类路径全部钉住。
 *
 * 反向验证：把 `isTokenProtectedPath` 的 `pathname === "/api"` 那行删掉重跑，`/api` 一条会变红。
 */

const SECRET_MARKER = "business-secret-must-not-leak";

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "zcode-auth-coverage-"));
  const staticRoot = join(root, "web");
  await mkdir(join(staticRoot, "assets"), { recursive: true });
  await writeFile(join(staticRoot, "index.html"), "<!doctype html><title>shell-fixture</title>");
  await writeFile(join(staticRoot, "assets/app.js"), "console.log('shell-asset');");
  // 放在 staticRoot 之外：任何穿越都必须拿不到它。
  await writeFile(join(root, "secret.json"), JSON.stringify({ leak: SECRET_MARKER }));
  return { root, staticRoot };
}

async function withServer(
  options: { authToken?: string; staticRoot?: string },
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

const PROTECTED_GET_PATHS = [
  "/api",
  "/api/",
  "/api/server-info",
  "/api/rpc-host-capability",
  "/api/connect-remote",
  "/api/anything-not-registered",
  "/ws",
  "/ws/host",
  "/ws/remote/some-id",
];

test("无凭据：所有 /api* 与 /ws* 路径必须 401，且 body 不含业务数据", async () => {
  const fixture = await createFixture();
  try {
    await withServer(
      {
        authToken: "s3cret",
        staticRoot: fixture.staticRoot,
        // 本用例会打十几条无凭据请求，**超过默认限流阈值**（10 次/5 分钟 ⇒ 之后的请求会是 403）。
        // 这里显式放宽：本用例要验的是「鉴权覆盖面与响应体」，不是限流（限流有自己的用例文件）。
        throttle: createAuthThrottle({ maxFailures: 10_000 }),
      },
      async (baseUrl) => {
        for (const path of PROTECTED_GET_PATHS) {
          const response = await fetch(baseUrl + path);
          assert.equal(response.status, 401, "GET " + path + " 必须 401");
          const body = await response.text();
          assert.equal(body, '{"error":"Unauthorized"}', "GET " + path + " 不得返回别的内容");
          assert.doesNotMatch(body, /session|taskId|workspace/i, "GET " + path + " 泄漏了业务数据");
        }

        // ② 写方法（POST）无凭据时有**两道**闸，谁先命中取决于请求头：
        //    - 不带 `Origin`（curl / CLI / 测试）：来源链放行（无 Origin 视为非浏览器客户端）⇒ 令牌链 401；
        //    - 带跨站 `Origin`：来源链先拒（403）—— 这正是 task-34 的 CSRF 防护，
        //      且 403 响应体里**不得**出现 capability 之类的业务词。
        // 两条都要求「不泄漏业务数据」。
        for (const path of ["/api/rpc-host-capability", "/api/connect-remote"]) {
          const noOrigin = await fetch(baseUrl + path, { method: "POST" });
          assert.equal(noOrigin.status, 401, "POST " + path + "（无 Origin）必须 401");
          assert.doesNotMatch(await noOrigin.text(), /capability|deviceSid|session/i);

          const crossSite = await fetch(baseUrl + path, {
            method: "POST",
            headers: { origin: "https://attacker.example" },
          });
          assert.equal(
            crossSite.status,
            403,
            "POST " + path + "（跨站 Origin）必须被来源链拒绝（403）",
          );
          assert.doesNotMatch(
            await crossSite.text(),
            /capability|deviceSid|session/i,
            "跨站 403 响应体不得泄漏业务数据",
          );
        }

        // ③ 同源 Origin 的写方法无凭据 ⇒ 由令牌链给 401（来源链放行、令牌链拦住）。
        for (const path of ["/api/rpc-host-capability", "/api/connect-remote"]) {
          const sameOrigin = await fetch(baseUrl + path, {
            method: "POST",
            headers: { origin: baseUrl },
          });
          assert.equal(sameOrigin.status, 401, "POST " + path + "（同源 Origin）必须 401");
        }
      },
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("有意公开的路径：静态壳与 SPA fallback 不得被鉴权打死", async () => {
  const fixture = await createFixture();
  try {
    await withServer({ authToken: "s3cret", staticRoot: fixture.staticRoot }, async (baseUrl) => {
      for (const path of ["/", "/index.html", "/share/abc", "/tasks"]) {
        const response = await fetch(baseUrl + path);
        assert.equal(response.status, 200, path + " 应返回 SPA 壳");
        assert.match(await response.text(), /shell-fixture/, path + " 应拿到壳而不是业务数据");
      }
      const asset = await fetch(baseUrl + "/assets/app.js");
      assert.equal(asset.status, 200);
      assert.match(await asset.text(), /shell-asset/);
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("路径穿越不得读到 staticRoot 之外的文件", async () => {
  const fixture = await createFixture();
  try {
    await withServer({ authToken: "s3cret", staticRoot: fixture.staticRoot }, async (baseUrl) => {
      for (const path of ["/../secret.json", "/%2e%2e/secret.json", "/assets/../../secret.json"]) {
        const response = await fetch(baseUrl + path);
        const body = await response.text();
        assert.doesNotMatch(body, new RegExp(SECRET_MARKER), path + " 读到了壳外文件");
      }
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("WebSocket 端点：无凭据 401，带 cookie 才能升级", async () => {
  const fixture = await createFixture();
  try {
    await withServer({ authToken: "s3cret", staticRoot: fixture.staticRoot }, async (baseUrl) => {
      const wsUrl = baseUrl.replace("http://", "ws://");
      const probe = (path: string, headers?: Record<string, string>) =>
        new Promise<string>((resolve) => {
          const socket = new WebSocket(wsUrl + path, headers ? { headers } : undefined);
          const timer = setTimeout(() => {
            socket.terminate();
            resolve("TIMEOUT");
          }, 4000);
          socket.on("open", () => {
            clearTimeout(timer);
            socket.close();
            resolve("OPEN");
          });
          socket.on("unexpected-response", (_request, response) => {
            clearTimeout(timer);
            resolve("HTTP " + response.statusCode);
          });
          socket.on("error", (error) => {
            clearTimeout(timer);
            resolve("ERROR " + error.message);
          });
        });

      for (const path of ["/ws", "/ws/host", "/ws/remote/x"]) {
        assert.equal(await probe(path), "HTTP 401", path + " 无凭据必须 401");
      }

      const authorized = await fetch(baseUrl + "/api/server-info?token=s3cret");
      assert.equal(authorized.status, 200);
      const cookie = (authorized.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      assert.match(cookie, /zcode_lite_token=s3cret/);
      assert.equal(await probe("/ws", { Cookie: cookie }), "OPEN", "带 cookie 应能升级");
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
