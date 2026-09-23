import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import test from "node:test";
import { createAuthorizationProbeController } from "../src/authorizationProbeController.js";

/**
 * 「断线时把授权问题与网络问题分开」的判定回归（task-22 阶段 2 的独立单元）。
 *
 * 钉住的缺陷：旧实现把授权探测放在「相位变化」上（effect 依赖 connection.phase），
 * 一个相位只探一次。断线往往就是服务在重启 —— 那一刻 /api/server-info 也连不上，
 * 只能得到 unreachable；此后不再探测 ⇒ 即使服务已起来并用 401 拒绝这个浏览器，
 * 页面也永远停在「正在重连（第 N 次）…恢复后本页会自动继续，无需刷新」，
 * 用户拿不到那条「怎么拿到带令牌链接」的可照做文案。
 *
 * 运行：cd packages/web && node --import tsx --test test/authorizationProbeController.test.ts
 */

const outcome = (value: "authorized" | "unauthorized" | "unreachable") => value;

test("探测落在服务重启窗口（unreachable）后，下一个 attempt 必须重新探测并切到未授权", async () => {
  const sequences: Array<"authorized" | "unauthorized" | "unreachable"> = [
    "unreachable", // 第 1 次：服务正在重启，/api 也连不上（本缺陷的触发条件）
    "unauthorized", // 第 2 次：服务已起来，cookie 失效 → 401
  ];
  let unauthorizedCalls = 0;
  const controller = createAuthorizationProbeController({
    probe: async () => {
      const next = sequences.shift() ?? "authorized";
      return next;
    },
    onUnauthorized: () => {
      unauthorizedCalls += 1;
    },
  });

  controller.notifyConnectionState("reconnecting", 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(unauthorizedCalls, 0, "第一次探测是 unreachable，不得误判成未授权");

  controller.notifyConnectionState("reconnecting", 2);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(unauthorizedCalls, 1, "第二个 attempt 探到 401 必须切到未授权态");
  assert.equal(controller.peekLastProbedAttempt(), 2);

  // 定案后不再重复触发（覆盖层只需要一次状态切换）
  controller.notifyConnectionState("reconnecting", 3);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(unauthorizedCalls, 1);

  // 用户点「重试」后重新开始判定：允许后续再接收到未授权
  controller.reset();
  controller.notifyConnectionState("reconnecting", 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(unauthorizedCalls, 1, "reset 后第一次探测是 authorized 序列耗尽，不应触发");
});

test("同一个 attempt 重复通知不重复探测；非「连不上」相位不探测", async () => {
  let probeCalls = 0;
  const controller = createAuthorizationProbeController({
    probe: async () => {
      probeCalls += 1;
      return outcome("unreachable");
    },
    onUnauthorized: () => {
      throw new Error("不应触发");
    },
  });

  controller.notifyConnectionState("reconnecting", 4);
  controller.notifyConnectionState("reconnecting", 4);
  controller.notifyConnectionState("reconnecting", 4);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probeCalls, 1, "同一 attempt 只探一次（effect 会因依赖变化重跑）");

  controller.notifyConnectionState("connected", 5);
  controller.notifyConnectionState("connecting", 5);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probeCalls, 1, "已连上/正在连接时不探测");

  controller.notifyConnectionState("failed", 6);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probeCalls, 2, "预算用尽的 failed 相位仍要探测一次（给用户可照做的文案）");
});

/**
 * 用真实 socket 复现「服务重启窗口」：代理在最前面，上游先不起（连接被拒 = unreachable），
 * 再起一个只会用 401 拒绝陈旧 cookie 的服务（= 探测必须拿到 401 而不是超时/连接被拒）。
 * 这条不依赖浏览器，因此可以进 CI。
 */
test("真实 socket：上游从「连接被拒」变成「401 拒绝陈旧 cookie」时，控制器必须切到未授权", async (t) => {
  const proxy = net.createServer();
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve()));
  const proxyPort = (proxy.address() as net.AddressInfo).port;

  const upstreamPortRef = { current: 0 };
  const upstreamRef: { current: http.Server | null } = { current: null };
  // 用 t.after 注册清理：断言失败时也要跑，否则悬挂的 socket / server 会让 node:test 一直等
  // （实测：失败路径下测试进程会挂到外部 timeout，CI 上就是卡死）。
  t.after(() => {
    for (const socket of pairs) {
      socket.destroy();
    }
    upstreamRef.current?.closeAllConnections?.();
    proxy.closeAllConnections?.();
    upstreamRef.current?.close();
    proxy.close();
  });
  const pairs = new Set<net.Socket>();
  proxy.on("connection", (client) => {
    const upstream = net.connect(upstreamPortRef.current, "127.0.0.1");
    pairs.add(client);
    pairs.add(upstream);
    client.pipe(upstream);
    upstream.pipe(client);
    const cleanup = () => {
      pairs.delete(client);
      pairs.delete(upstream);
    };
    client.on("error", cleanup);
    upstream.on("error", cleanup);
    client.on("close", cleanup);
    upstream.on("close", cleanup);
  });

  const probe = async (): Promise<"authorized" | "unauthorized" | "unreachable"> => {
    try {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/api/server-info`, {
        cache: "no-store",
        // 不要 keep-alive：否则 undici 的连接池会让代理的 close() 一直等下去，测试进程不退出。
        headers: { cookie: "zcode_lite_token=stale", connection: "close" },
        // 与生产代码同构：探测必须有超时上限，否则「上游不可达」时 fetch 会一直 pending。
        signal: AbortSignal.timeout(1_200),
      });
      return response.status === 401 ? "unauthorized" : "authorized";
    } catch {
      return "unreachable";
    }
  };

  let unauthorizedCalls = 0;
  const controller = createAuthorizationProbeController({
    probe,
    onUnauthorized: () => {
      unauthorizedCalls += 1;
    },
  });

  // 1) 服务重启窗口：上游没起（代理侧连接被拒 ⇒ unreachable）
  controller.notifyConnectionState("reconnecting", 1);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(
    controller.peekLastProbedAttempt(),
    1,
    "第一次探测必须真的跑过（否则这条断言没有意义）",
  );
  assert.equal(unauthorizedCalls, 0);

  // 2) 上游起来，并配置成「只有 cookie 正确才 200，否则 401」
  const upstream = http.createServer((request, response) => {
    const cookie = String(request.headers.cookie ?? "");
    if (!cookie.includes("zcode_lite_token=" + "good-token")) {
      response.writeHead(401, { "content-type": "text/plain" });
      response.end("unauthorized");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  upstreamRef.current = upstream;
  upstreamPortRef.current = (upstream.address() as net.AddressInfo).port;

  // 3) 下一个 attempt：同一个陈旧 cookie 现在必须被识别为「授权问题」
  controller.notifyConnectionState("reconnecting", 2);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(unauthorizedCalls, 1, "服务在跑但 401 拒绝 ⇒ 必须切到未授权态而不是继续重连");

  // 清理在 t.after 里统一做（见上）。
});
