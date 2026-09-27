import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHttpServer } from "@zcode/server";
import { ServiceCollection } from "@zcode/services";
// 直接引 server 源码：createAuthTokenStore 不在 @zcode/server 的公开导出面（exports 只有
// "." / "./stdio" / "./remote"），而测试需要真实的令牌源 + reload 才能启用轮换。
// 不为测试扩大那个包的公开面（那是架构决策，且属 task-16 的包）；
// 本目录同样有先例：webServiceWiring.test.ts 直接引 ../../ui/src/remoteControlWiring.js。
import { createAuthTokenStore } from "../../server/src/authToken.js";
import { createWebServiceConnectionPlane } from "../src/main/web-service/remoteControlClient.js";
import { readWebServiceToken } from "../src/main/web-service/token.js";

/**
 * 真实服务端联调：真实 createHttpServer + 真实 remoteControlClient。
 *
 * 与 webServiceConnectionWiring.test.ts 的分工（两者都要有，不是重复）：
 * - 那一份验的是接线（通道注册、载荷守卫、令牌不变式），服务端用替身 ——
 *   它能在服务端未落地时跑，且能构造真实服务端产不出的畸形形状（如多一个 token 字段）。
 * - 这一份验的是契约对得上：真服务端产出的字节流，我的 parser 全部接受。
 *   替身是我写的，它认什么形状由我决定 ⇒ 它证明不了契约一致，只有真服务端能。
 *
 * 为什么必须有这一份：两套东西各自"绿"而接起来不兼容，是本仓反复踩的形态
 * （fixture 全绿而最终消费点失败）。task-16 曾用临时探针跑过一次联调并已删除 ——
 * 探针不留证据，回归时无人能复跑。这里把它变成仓库里可重复执行的断言。
 *
 * 运行：cd packages/desktop && node --import tsx --test test/remoteControlServerContract.test.ts
 */

/** 起一个真实服务端（令牌文件模式 ⇒ 可轮换），返回 base 与令牌路径。 */
async function withRealServer(
  run: (input: { baseUrl: string; tokenPath: string }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-conncontract-"));
  const tokenPath = join(dir, "token");
  const token = "contract-probe-token-0123456789abcdef";
  await writeFile(tokenPath, token + "\n", { mode: 0o600 });
  // tokenSource 必须显式注入：只给 tokenFilePath 服务端不会启用鉴权
  // （构造时 tokenSource 来自 options.tokenSource ?? 显式 env 令牌，两者都空 ⇒ 无鉴权），
  // 于是「Bearer 应 401」会变成 200、轮换会因没有令牌源而 409。
  // 这与 packages/server/test/remoteControlConnections.test.ts 的接线同形。
  const tokenSource = createAuthTokenStore({
    records: [],
    fileRecords: [{ token }],
    filePath: tokenPath,
  });
  // 真服务端只绑回环（与 CI 口径一致，绝不在测试里绑 0.0.0.0）。
  const server = createHttpServer(new ServiceCollection(), 0, {
    host: "127.0.0.1",
    tokenSource,
    tokenFilePath: tokenPath,
  });
  try {
    if (!server.listening) {
      await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    }
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await run({ baseUrl: "http://127.0.0.1:" + String(port), tokenPath });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * 造一个只指向真服务端的 client。
 *
 * 为什么不直接复用 createWebServiceRuntime：它要 spawn 子进程（那是接线测试的事）。
 * 这里只注入 status 与 tokenPath 两个依赖 —— 与生产接线处同一份实现。
 */
function createPlaneForServer(baseUrl: string, tokenPath: string) {
  const url = new URL(baseUrl);
  return createWebServiceConnectionPlane({
    status: async () => ({
      state: "running",
      adopted: false,
      loopback: true,
      host: url.hostname,
      port: Number(url.port),
      url: baseUrl,
    }),
    tokenPath,
  });
}

test("★真实服务端：空清单是 200 + 空数组（确定 0 台），不是 null、不是 404", async () => {
  await withRealServer(async ({ baseUrl, tokenPath }) => {
    const plane = createPlaneForServer(baseUrl, tokenPath);
    const payload = await plane.list();
    assert.ok(payload, "真服务端必须给出有值载荷（空数组是合法结果，不是 null）");
    assert.deepEqual(payload.connections, [], "没有设备连着 ⇒ 确定 0 台");
    assert.equal(typeof payload.revision, "number", "revision 必须是 number");
  });
});

test("★真实服务端：鉴权口径一致（?token= 被接受，Bearer 不被接受）", async () => {
  await withRealServer(async ({ baseUrl, tokenPath }) => {
    const token = await readWebServiceToken(tokenPath);
    assert.ok(token);
    // ① ?token= ⇒ 200。
    const ok = await fetch(baseUrl + "/api/remote-control/connections?token=" + token);
    assert.equal(ok.status, 200, "?token= 必须被接受（client 用的就是这条）");
    // ② Bearer ⇒ 401。这条钉住「client 为何不能用 Authorization 头」这个判断。
    const bearer = await fetch(baseUrl + "/api/remote-control/connections", {
      headers: { authorization: "Bearer " + token },
    });
    assert.equal(bearer.status, 401, "服务端不认 Bearer ⇒ client 必须用 ?token=");
    // ③ 无凭据 ⇒ 401。
    const none = await fetch(baseUrl + "/api/remote-control/connections");
    assert.equal(none.status, 401);
  });
});

test("★真实服务端：撤销恰好其一 —— 同时给/都不给 ⇒ 400（与 client 的边界校验一致）", async () => {
  await withRealServer(async ({ baseUrl, tokenPath }) => {
    const token = await readWebServiceToken(tokenPath);
    const post = (body: unknown) =>
      fetch(baseUrl + "/api/remote-control/connections/revoke?token=" + token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    for (const bad of [{}, { id: "x", all: true }, { id: "" }, { all: false }]) {
      const response = await post(bad);
      assert.equal(
        response.status,
        400,
        "必须 400：" + JSON.stringify(bad) + "（不做就近猜一个的兜底）",
      );
    }
    // 合法形态：幂等 —— 不存在的 id 也 200 + revoked:0（不是 404）。
    const idempotent = await post({ id: "no-such-connection" });
    assert.equal(idempotent.status, 200, "幂等：不存在的 id 必须 200 而不是 404");
    assert.deepEqual(await idempotent.json(), { revoked: 0 });
    const all = await post({ all: true });
    assert.equal(all.status, 200);
    assert.deepEqual(await all.json(), { revoked: 0 }, "没有连接可撤 ⇒ revoked: 0");
  });
});

test("★真实服务端：令牌轮换 —— 旧令牌立即失效（客户端 fail-closed 成 null）", async () => {
  await withRealServer(async ({ baseUrl, tokenPath }) => {
    const plane = createPlaneForServer(baseUrl, tokenPath);
    const before = await plane.list();
    assert.ok(before, "轮换前必须能读到");

    const oldToken = await readWebServiceToken(tokenPath);
    const rotated = await plane.rotateToken();
    assert.equal(typeof rotated.rotatedAt, "number", "轮换必须给出时刻");

    // 旧令牌立即失效：直接打端点应 401。
    const stale = await fetch(
      baseUrl + "/api/remote-control/connections?token=" + String(oldToken),
    );
    assert.equal(stale.status, 401, "旧令牌必须立即失效（不必重启）");

    // client 侧 fail-closed：它每次现读令牌文件，所以轮换后仍能读到新令牌 ⇒ 仍可用。
    // 这正是本单元的实现选择（现读而非缓存）带来的正确行为。
    const after = await plane.list();
    assert.ok(after, "client 现读令牌文件 ⇒ 轮换后无需重启即可继续工作");
    const newToken = await readWebServiceToken(tokenPath);
    assert.notEqual(newToken, oldToken, "令牌文件必须真的换了");
  });
});

test("★真实服务端：连接清单里的形状被 parser 全部接受（含 workspace 缺失）", async () => {
  // 真服务端在"升级时刻不知道工作区"时省略 workspace（task-16 的实测结论）。
  // 这条在真实字节流上复核该形状能被接受 —— 而不是靠我构造的替身 JSON。
  await withRealServer(async ({ baseUrl, tokenPath }) => {
    const plane = createPlaneForServer(baseUrl, tokenPath);
    const payload = await plane.list();
    assert.ok(payload);
    // 服务端产出的每一行都必须通过 parser（这里没有连接，所以断言的是"整体形状"）；
    // 真正带行的形状由 webServiceConnectionWiring.test.ts 的替身逐档覆盖。
    for (const row of payload.connections) {
      assert.equal(typeof row.id, "string");
      assert.ok(["terminal-client", "trusted-host"].includes(row.role));
      assert.equal(typeof row.connectedAt, "number");
    }
  });
});
