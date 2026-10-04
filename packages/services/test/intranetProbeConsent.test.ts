import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Server as TcpServer } from "node:net";
import test from "node:test";
import type { IntranetProbeRequest } from "@zcode/shared";
import {
  setBotAttachmentAllowedHosts,
  setBotAttachmentDnsResolver,
} from "../src/bots/attachmentUrlGuard.js";
import {
  intranetProbeConsentKey,
  normalizeIntranetProbeConsentTcpTarget,
} from "../src/system/intranetProbeConsent.js";
import { createSystemService } from "../src/system/systemService.js";

/**
 * 内网探测目标限制的服务端回归（S3）。
 *
 * 背景：probeIntranet 接收客户端传入的 targets（tcp: host/port 或 service: url+token），
 * 原实现无任何目标限制——既是服务端 SSRF（service target 的 fetch + marker 回传）也是
 * 端口扫描原语（tcp target 的原始 socket 连接）。
 *
 * 口径（保留功能能力、消灭静默）：
 * - service target：只公网 + DNS pin + 不跟随重定向（与 bot 附件同一判据）；
 * - tcp target：默认不拒绝私网（功能目的就是探内网），但每个 host:port 必须先获得
 *   用户显式确认；未确认的目标不建连。
 *
 * 判别实验（127.0.0.1 探针 server）：
 * - tcp：未确认 ⇒ 探针 0 命中（修复前 1 命中）；记录确认后同一目标 ⇒ 1 命中。
 *   注意 tcp 探测是裸 TCP connect（不发 HTTP 请求），探针必须用原始 TCP server 计
 *   连接数，而不是 HTTP request 计数。
 * - service：URL 指向探针 server ⇒ 0 命中，且 serviceProbe 实现一次都不被调用。
 *
 * 运行：cd packages/services && node --import tsx --test test/intranetProbeConsent.test.ts
 */

function createTestService() {
  const calls = { tcp: 0, service: 0 };
  const service = createSystemService({
    tcpProbe: async () => {
      calls.tcp += 1;
      // 模拟真实建连：只有调用到这里才可能产生网络请求。
      return 42;
    },
    serviceProbe: async () => {
      calls.service += 1;
      return { latencyMs: 7, marker: "intranet" };
    },
  });
  return { service, calls };
}

function tcpRequest(targets: Array<{ host: string; port?: number }>): IntranetProbeRequest {
  return {
    targets: targets.map((target) => ({
      kind: "tcp",
      host: target.host,
      port: target.port ?? 22,
    })),
    attempts: 1,
  };
}

function serviceRequest(url: string): IntranetProbeRequest {
  return { targets: [{ kind: "service", url }], attempts: 1 };
}

test("tcp：未确认的目标不建连（tcpProbe 一次都不被调用）", async () => {
  const { service, calls } = createTestService();
  const result = await service.probeIntranet(tcpRequest([{ host: "10.0.0.5" }]));
  assert.equal(result.totalTargets, 1);
  assert.equal(result.reachedTargetCount, 0);
  assert.equal(result.isIntranet, false);
  const tcpResult = result.results[0];
  assert.equal(tcpResult?.kind, "tcp");
  assert.equal(tcpResult?.reachable, false);
  assert.equal(tcpResult?.attemptCount, 0);
  assert.match(tcpResult?.error ?? "", /consent required/);
  assert.match(tcpResult?.error ?? "", /10\.0\.0\.5:22/);
  assert.equal(calls.tcp, 0);
});

test("tcp：记录确认后同一 host:port 可探测（复用一次确认）", async () => {
  const { service, calls } = createTestService();
  await service.recordIntranetProbeTcpTargetConsent({
    targets: [{ kind: "tcp", host: "10.0.0.5", port: 22 }],
  });
  const result = await service.probeIntranet(tcpRequest([{ host: "10.0.0.5" }]));
  assert.equal(result.reachedTargetCount, 1);
  assert.equal(result.isIntranet, true);
  assert.equal(result.results[0]?.reachable, true);
  assert.equal(calls.tcp, 1);
});

test("tcp：换目标（不同 host:port）需重新确认", async () => {
  const { service, calls } = createTestService();
  await service.recordIntranetProbeTcpTargetConsent({
    targets: [{ kind: "tcp", host: "10.0.0.5", port: 22 }],
  });
  const result = await service.probeIntranet(
    tcpRequest([{ host: "10.0.0.5" }, { host: "10.0.0.6", port: 8080 }]),
  );
  const second = result.results[1];
  assert.equal(second?.kind, "tcp");
  assert.equal(second?.reachable, false);
  assert.match(second?.error ?? "", /consent required/);
  assert.equal(calls.tcp, 1); // 只有已确认的第一个目标建连
});

test("tcp：host 大小写差异不构成新目标（确认记录按规范化键复用）", async () => {
  const { service } = createTestService();
  await service.recordIntranetProbeTcpTargetConsent({
    targets: [{ kind: "tcp", host: "MyHost.Example", port: 22 }],
  });
  const result = await service.probeIntranet(tcpRequest([{ host: "myhost.example" }]));
  assert.equal(result.results[0]?.reachable, true);
});

test("tcp：默认端口（22）的确认记录覆盖未指定端口的同一目标", async () => {
  const { service } = createTestService();
  await service.recordIntranetProbeTcpTargetConsent({
    targets: [{ kind: "tcp", host: "10.0.0.5", port: 22 }],
  });
  const result = await service.probeIntranet({ targets: [{ kind: "tcp", host: "10.0.0.5" }] });
  assert.equal(result.results[0]?.reachable, true);
});

test("consent 查询：返回条目与请求逐项对齐", async () => {
  const { service } = createTestService();
  await service.recordIntranetProbeTcpTargetConsent({
    targets: [{ kind: "tcp", host: "10.0.0.5", port: 22 }],
  });
  const consent = await service.getIntranetProbeTcpTargetConsent({
    targets: [
      { kind: "tcp", host: "10.0.0.5", port: 22 },
      { kind: "tcp", host: "10.0.0.6", port: 22 },
    ],
  });
  assert.deepEqual(consent.entries, [
    { host: "10.0.0.5", port: 22, consented: true },
    { host: "10.0.0.6", port: 22, consented: false },
  ]);
});

test("consent 记录条数有 FIFO 上限（防无界增长）", async () => {
  const { service } = createTestService();
  for (let i = 0; i < 300; i += 1) {
    await service.recordIntranetProbeTcpTargetConsent({
      targets: [{ kind: "tcp", host: `10.1.0.${i}`, port: 22 }],
    });
  }
  // 第一批（10.1.0.0 ~ 10.1.0.43）应被淘汰：换目标重新确认的口径。
  const evicted = await service.getIntranetProbeTcpTargetConsent({
    targets: [{ kind: "tcp", host: "10.1.0.0", port: 22 }],
  });
  assert.equal(evicted.entries[0]?.consented, false);
  const kept = await service.getIntranetProbeTcpTargetConsent({
    targets: [{ kind: "tcp", host: "10.1.0.299", port: 22 }],
  });
  assert.equal(kept.entries[0]?.consented, true);
});

test("tcp 归一化键：空 host 返回 null、端口越界回退默认端口", () => {
  assert.equal(normalizeIntranetProbeConsentTcpTarget({ host: "   " }), null);
  assert.deepEqual(normalizeIntranetProbeConsentTcpTarget({ host: "Host", port: 70000 }), {
    host: "host",
    port: 22,
  });
  assert.equal(intranetProbeConsentKey("HOST", 22), "host:22");
});

test("service：URL 指向回环 ⇒ 判失败且 serviceProbe 不被调用", async () => {
  const { service, calls } = createTestService();
  const result = await service.probeIntranet(serviceRequest("http://127.0.0.1:9/x"));
  assert.equal(result.reachedTargetCount, 0);
  const serviceResult = result.results[0];
  assert.equal(serviceResult?.kind, "service");
  assert.equal(serviceResult?.reachable, false);
  assert.equal(serviceResult?.attemptCount, 0);
  assert.match(serviceResult?.error ?? "", /intranet service target rejected/);
  assert.equal(calls.service, 0);
});

test("service：解析到私网的域名 URL 同样被拒绝", async () => {
  setBotAttachmentDnsResolver(async () => [{ address: "10.0.0.9", family: 4 }]);
  const { service, calls } = createTestService();
  try {
    const result = await service.probeIntranet(
      serviceRequest("http://probe-service.example.test/health"),
    );
    assert.equal(result.results[0]?.reachable, false);
    assert.equal(calls.service, 0);
  } finally {
    setBotAttachmentDnsResolver(null);
  }
});

test("service：合法公网 URL 放行（serviceProbe 被调用）", async () => {
  setBotAttachmentDnsResolver(async () => [{ address: "93.184.216.34", family: 4 }]);
  const { service, calls } = createTestService();
  try {
    const result = await service.probeIntranet(
      serviceRequest("https://probe-service.example.test/health"),
    );
    assert.equal(result.reachedTargetCount, 1);
    assert.equal(result.results[0]?.reachable, true);
    assert.equal(calls.service, 1);
  } finally {
    setBotAttachmentDnsResolver(null);
  }
});

test("混合批次：authorized tcp 放行 + blocked service 判失败，strategy 为 mixed", async () => {
  setBotAttachmentDnsResolver(async () => [{ address: "10.0.0.9", family: 4 }]);
  const { service } = createTestService();
  await service.recordIntranetProbeTcpTargetConsent({
    targets: [{ kind: "tcp", host: "10.0.0.5", port: 22 }],
  });
  const result = await service.probeIntranet({
    targets: [
      { kind: "tcp", host: "10.0.0.5", port: 22 },
      { kind: "service", url: "http://probe-service.example.test/health" },
    ],
    attempts: 1,
  });
  assert.equal(result.strategy, "mixed");
  assert.equal(result.reachedTargetCount, 1);
  assert.equal(result.isIntranet, true);
  setBotAttachmentDnsResolver(null);
});

/**
 * 判别实验（tcp）：真 127.0.0.1 探针 server + 默认 tcpProbe（真实 socket 建连）。
 * tcp 探测是裸 TCP connect，探针必须计 TCP 连接数，而不是 HTTP 请求。
 */
async function withTcpProbeServer(run: (port: number) => Promise<void>): Promise<number> {
  let connections = 0;
  const server = new TcpServer(() => {
    connections += 1;
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await run(port);
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
  return connections;
}

test("判别实验（tcp）：未确认 ⇒ 探针 0 命中；记录确认后 ⇒ 1 命中", async () => {
  const before = await withTcpProbeServer(async (port) => {
    const service = createSystemService();
    await service.probeIntranet(tcpRequest([{ host: "127.0.0.1", port }]));
  });
  assert.equal(before, 0, "未确认的目标不得建连（修复前这里会是 1 次命中）");

  const after = await withTcpProbeServer(async (port) => {
    const service = createSystemService();
    await service.recordIntranetProbeTcpTargetConsent({
      targets: [{ kind: "tcp", host: "127.0.0.1", port }],
    });
    const result = await service.probeIntranet(tcpRequest([{ host: "127.0.0.1", port }]));
    assert.equal(result.results[0]?.reachable, true);
  });
  assert.equal(after, 1, "确认后才会真实建连");
});

/** 判别实验（service）：真 127.0.0.1 HTTP 探针 server + 默认 serviceProbe。 */
async function withHttpProbeServer(run: (port: number) => Promise<void>): Promise<string[]> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? "(no url)");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await run(port);
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
  return hits.slice();
}

test("判别实验（service）：URL 指向探针 server ⇒ 0 命中（默认 serviceProbe 也不会请求）", async () => {
  const hits = await withHttpProbeServer(async (port) => {
    const service = createSystemService();
    const url = `http://127.0.0.1:${port}/x`;
    const result = await service.probeIntranet(serviceRequest(url));
    assert.equal(result.results[0]?.reachable, false);
  });
  assert.deepEqual(hits, [], "SSRF 目标不得被请求（修复前这里会是 1 次命中）");
});

/**
 * token 头与判据优先级（S3 收尾）：默认 serviceProbe 经.fetchIntranetProbeServiceBytes
 * 携带 x-zcode-intranet-token；同时私网/回环拒绝优先于 token（未登记放行项时带 token 也拒）。
 */
function tokenProbeServer() {
  const received: Array<{ url: string; token: string | null }> = [];
  const server = createServer((req, res) => {
    received.push({
      url: req.url ?? "(no url)",
      token: req.headers["x-zcode-intranet-token"] ?? null,
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, marker: "intranet" }));
  });
  return { server, received };
}

function serviceRequestWithToken(url: string, token: string): IntranetProbeRequest {
  return { targets: [{ kind: "service", url, token }], attempts: 1 };
}

test("token 头：放行项登记后，默认 serviceProbe 把 x-zcode-intranet-token 发到目标", async () => {
  setBotAttachmentAllowedHosts(["127.0.0.1"]);
  const { server, received } = tokenProbeServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const service = createSystemService();
    const result = await service.probeIntranet(
      serviceRequestWithToken(`http://127.0.0.1:${port}/health`, "tok-123"),
    );
    assert.equal(result.results[0]?.reachable, true);
    assert.equal(received.length, 1);
    assert.equal(received[0]?.token, "tok-123");
    assert.equal(received[0]?.url, "/health");
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
    setBotAttachmentAllowedHosts([]);
  }
});

test("判据优先：私网/回环 + token 仍被拒绝（token 不能换通行证）", async () => {
  const { server, received } = tokenProbeServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const { service, calls } = createTestService();
  try {
    const result = await service.probeIntranet(
      serviceRequestWithToken(`http://127.0.0.1:${port}/health`, "tok-123"),
    );
    assert.equal(result.results[0]?.reachable, false);
    assert.match(result.results[0]?.error ?? "", /intranet service target rejected/);
    assert.equal(calls.service, 0, "serviceProbe 实现不得被调用");
    assert.deepEqual(received, [], "SSRF 目标不得被请求");
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
});

/** 重定向：每跳重新判定，且 token 头逐跳携带。 */
function redirectOrTargetServer(
  target: { kind: "redirect"; location: string } | { kind: "target" },
) {
  const received: Array<{ url: string; token: string | null }> = [];
  const server = createServer((req, res) => {
    received.push({
      url: req.url ?? "(no url)",
      token: req.headers["x-zcode-intranet-token"] ?? null,
    });
    if (target.kind === "redirect") {
      res.writeHead(302, { location: target.location });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, marker: "intranet" }));
  });
  return {
    server,
    received,
    setLocation(location: string) {
      (target as { location: string }).location = location;
    },
  };
}

test("重定向：放行项内 302 到同主机另一端口 ⇒ 跟随且 token 头逐跳携带", async () => {
  setBotAttachmentAllowedHosts(["127.0.0.1"]);
  const target = redirectOrTargetServer({ kind: "target" });
  const redirect = redirectOrTargetServer({ kind: "redirect", location: "placeholder" });
  await new Promise((resolve) => target.server.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => redirect.server.listen(0, "127.0.0.1", resolve));
  const targetPort = (target.server.address() as { port: number }).port;
  const redirectPort = (redirect.server.address() as { port: number }).port;
  redirect.setLocation(`http://127.0.0.1:${targetPort}/final`);
  try {
    const service = createSystemService();
    const result = await service.probeIntranet(
      serviceRequestWithToken(`http://127.0.0.1:${redirectPort}/start`, "tok-redirect"),
    );
    assert.equal(result.results[0]?.reachable, true);
    assert.deepEqual(
      target.received.map((entry) => [entry.url, entry.token]),
      [["/final", "tok-redirect"]],
    );
  } finally {
    await new Promise((resolve) => target.server.close(() => resolve()));
    await new Promise((resolve) => redirect.server.close(() => resolve()));
    setBotAttachmentAllowedHosts([]);
  }
});

test("重定向：302 到未放行的私网目标 ⇒ 每跳判据拒绝且不被请求", async () => {
  setBotAttachmentDnsResolver(async () => [{ address: "10.0.0.9", family: 4 }]);
  setBotAttachmentAllowedHosts(["127.0.0.1"]);
  const target = redirectOrTargetServer({ kind: "target" });
  const redirect = redirectOrTargetServer({
    kind: "redirect",
    location: "http://private-target.example.test/final",
  });
  await new Promise((resolve) => target.server.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => redirect.server.listen(0, "127.0.0.1", resolve));
  const redirectPort = (redirect.server.address() as { port: number }).port;
  try {
    const service = createSystemService();
    const result = await service.probeIntranet(
      serviceRequestWithToken(`http://127.0.0.1:${redirectPort}/start`, "tok-redirect"),
    );
    assert.equal(result.results[0]?.reachable, false);
    // 重定向目标解析到私网：reason 是地址级拒绝（blocked_address），
    // 而非只是 redirect_not_allowed——判据在每一跳都完整执行。
    assert.match(result.results[0]?.error ?? "", /intranet service target rejected/);
    assert.match(result.results[0]?.error ?? "", /blocked_address/);
    assert.deepEqual(target.received, [], "重定向目标不得被请求");
  } finally {
    await new Promise((resolve) => target.server.close(() => resolve()));
    await new Promise((resolve) => redirect.server.close(() => resolve()));
    setBotAttachmentDnsResolver(null);
    setBotAttachmentAllowedHosts([]);
  }
});
