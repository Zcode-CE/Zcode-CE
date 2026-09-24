import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWebServiceUrl,
  isProcessAlive,
  probeWebService,
  WEB_SERVICE_PROBE_TIMEOUT_MS,
} from "../src/main/web-service/probe.js";
import type { WebServiceStateRecord } from "../src/main/web-service/state.js";

/**
 * 接管探活的**五分支**契约测试（契约 §4）。
 *
 * 为什么必须逐分支测：这条判据决定主进程"要不要启第二个进程"。判错任何一个分支的后果都是
 * 用户可见的：把 `running` 判成 `stopped` ⇒ 起第二个服务实例、端口打架；
 * 把 `running-untrusted` 判成 `running` ⇒ 接管一个陌生服务并把用户链接指向它。
 *
 * 运行：cd packages/desktop && node --import tsx --test test/webServiceProbe.test.ts
 */

const RECORD: WebServiceStateRecord = {
  schemaVersion: 1,
  pid: 4242,
  host: "127.0.0.1",
  port: 38490,
  workspacePath: "/abs/ws",
  tokenFile: "/abs/token",
  staticRoot: "/abs/web-dist",
  startedAt: 1760000000000,
  entry: "zcode-server-http.cjs",
};

function deps(overrides: {
  record?: WebServiceStateRecord | undefined;
  alive?: boolean;
  probe?: number | "timeout" | "network";
  token?: string | undefined;
}) {
  const seen: Array<{ url: string; token: string | undefined; timeoutMs: number }> = [];
  return {
    seen,
    deps: {
      statePath: "/nonexistent/web-service.json",
      readState: async () => overrides.record,
      readToken: async () => ("token" in overrides ? overrides.token : "test-token"),
      isPidAlive: () => overrides.alive ?? true,
      probeServerInfo: async (input: {
        url: string;
        token: string | undefined;
        timeoutMs: number;
      }) => {
        seen.push(input);
        return overrides.probe ?? 200;
      },
    },
  };
}

test("没有状态文件 ⇒ stopped（不猜、不探测）", async () => {
  const { seen, deps: d } = deps({ record: undefined });
  assert.deepEqual(await probeWebService(d), { state: "stopped" });
  assert.equal(seen.length, 0, "没有状态文件时不该发起任何探测");
});

test("pid 已死 ⇒ stale/pid-dead（异常退出的形态）", async () => {
  const { seen, deps: d } = deps({ record: RECORD, alive: false });
  assert.deepEqual(await probeWebService(d), { state: "stale", reason: "pid-dead" });
  assert.equal(seen.length, 0, "pid 已死就不必再探测端口");
});

test("探测 200 ⇒ running + adopted（接管在跑的服务）", async () => {
  const { seen, deps: d } = deps({ record: RECORD, probe: 200 });
  const result = await probeWebService(d);
  // 契约 §4：凭证**取自 tokenFile**（不带令牌会被判 401 ⇒ 自己的服务被误判成 untrusted）。
  assert.equal(seen[0]?.token, "test-token");
  assert.equal(result.state, "running");
  assert.equal(result.state === "running" ? result.adopted : undefined, true);
  assert.equal(result.state === "running" ? result.url : undefined, "http://127.0.0.1:38490");
  assert.equal(result.state === "running" ? result.pid : undefined, 4242);
});

test("探测 401 / 403 ⇒ running-untrusted（端口上有别的服务，不接管）", async () => {
  for (const code of [401, 403]) {
    const { deps: d } = deps({ record: RECORD, probe: code });
    assert.deepEqual(await probeWebService(d), {
      state: "running-untrusted",
      host: "127.0.0.1",
      port: 38490,
    });
  }
});

test("连接被拒 ⇒ stale/port-closed", async () => {
  const { deps: d } = deps({ record: RECORD, probe: "network" });
  assert.deepEqual(await probeWebService(d), { state: "stale", reason: "port-closed" });
});

test("探测超时 ⇒ stale/probe-timeout（与 port-closed 是不同判据）", async () => {
  const { seen, deps: d } = deps({ record: RECORD, probe: "timeout" });
  assert.deepEqual(await probeWebService(d), { state: "stale", reason: "probe-timeout" });
  assert.equal(seen[0]?.timeoutMs, WEB_SERVICE_PROBE_TIMEOUT_MS);
});

test("其它非 2xx（如 500）⇒ running-untrusted，且不删状态文件", async () => {
  const { deps: d } = deps({ record: RECORD, probe: 500 });
  assert.deepEqual(await probeWebService(d), {
    state: "running-untrusted",
    host: "127.0.0.1",
    port: 38490,
  });
});

test("令牌文件读不到 ⇒ 不带令牌探测（结果会是 untrusted，而不是伪装成自己人）", async () => {
  const { seen, deps: d } = deps({ record: RECORD, probe: 401, token: undefined });
  const result = await probeWebService(d);
  assert.equal(seen[0]?.token, undefined);
  assert.equal(result.state, "running-untrusted");
});

test("IPv6 监听地址要加方括号，否则 URL 不可解析（会永远误判 port-closed）", () => {
  assert.equal(buildWebServiceUrl("127.0.0.1", 3030), "http://127.0.0.1:3030");
  assert.equal(buildWebServiceUrl("::1", 3030), "http://[::1]:3030");
  assert.equal(buildWebServiceUrl("[::1]", 3030), "http://[::1]:3030");
});

test("isProcessAlive：自己的 pid 存活，绝不可能存在的 pid 判死", () => {
  assert.equal(isProcessAlive(process.pid), true);
  // 0/负数不是合法 pid，必须判死（否则会拿它去 process.kill 并抛错）。
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-1), false);
});
