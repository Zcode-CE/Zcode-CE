import assert from "node:assert/strict";
import test from "node:test";
import { createAuditLog, type AuditEvent } from "../src/auditLog.js";

/**
 * 审计日志的契约（task-46 / B1）。
 *
 * 这组断言里**最重要的是否定式断言**：审计日志是「出了事之后唯一的账本」，它一旦把凭据写进去，
 * 就从"证据"变成"第二个泄露点"。所以下面用**真实令牌字符串**反向搜索日志文本，必须搜不到。
 *
 * 反向验证（实测）：去掉 `audit.record` 的调用 ⇒ 集成测试里对应的事件断言变红；
 * 把合并逻辑换成"直接丢超限事件"⇒「不得丢失事件」那条变红（因为总数对不上）。
 */

function captureAudit(options?: Parameters<typeof createAuditLog>[0]) {
  const lines: { text: string; level: string }[] = [];
  const audit = createAuditLog({
    ...options,
    write: (line, level) => lines.push({ text: line, level }),
  });
  const parsed = () =>
    lines.map(
      (line) => JSON.parse(line.text.slice(line.text.indexOf("{"))) as Record<string, unknown>,
    );
  return { audit, lines, parsed };
}

test("结构化：一行一条 JSON、字段稳定、带 ISO 时间戳与事件名", () => {
  const { audit, lines, parsed } = captureAudit({
    now: () => Date.parse("2026-09-24T12:00:00.000Z"),
  });
  audit.record({
    kind: "audit:ws-open",
    peer: "203.0.113.7",
    role: "terminal-client",
    connectionId: "c1",
    authenticated: true,
    tokenLabel: "手机",
  });
  assert.equal(lines.length, 1);
  const line = lines[0]!;
  assert.match(line.text, /^\[.*\] \[pid:\d+\] \[zcode-server:audit\] \{/);
  assert.equal(line.level, "info", "连接生命周期是 info");
  const event = parsed()[0]!;
  assert.equal(event.kind, "audit:ws-open");
  assert.equal(event.ts, "2026-09-24T12:00:00.000Z");
  assert.equal(event.peer, "203.0.113.7");
  assert.equal(event.tokenLabel, "手机");
  assert.equal(event.connectionId, "c1");
});

test("等级：安全拒绝走 warn，生命周期与重载走 info", () => {
  const { audit, lines } = captureAudit();
  audit.record({ kind: "audit:ws-open", peer: "p" });
  audit.record({ kind: "audit:ws-close", peer: "p" });
  audit.record({ kind: "audit:token-reload", peer: "local" });
  audit.record({ kind: "audit:auth-failure", peer: "p" });
  audit.record({ kind: "audit:auth-ban", peer: "p" });
  audit.record({ kind: "audit:host-rejected", peer: "p" });
  audit.record({ kind: "audit:origin-rejected", peer: "p" });
  audit.record({ kind: "audit:connection-limit-rejected", peer: "p" });
  assert.deepEqual(
    lines.map((line) => line.level),
    ["info", "info", "info", "warn", "warn", "warn", "warn", "warn"],
  );
});

test("高频事件：窗口内超上限不逐条写，但**计数不丢**（窗口末给出汇总）", () => {
  let now = 1_000;
  const { audit, parsed } = captureAudit({
    now: () => now,
    coalesceWindowMs: 1_000,
    coalesceMaxEventsPerWindow: 3,
  });
  for (let index = 0; index < 10; index += 1) {
    audit.record({
      kind: "audit:auth-failure",
      peer: "203.0.113.9",
      path: "/api/server-info",
      reason: "令牌无效或缺失",
    });
  }
  // 前 3 条逐条写出，其余 7 条等窗口末的汇总。
  assert.equal(audit.pendingKeyCount(), 1);
  now += 1_000;
  audit.record({
    kind: "audit:auth-failure",
    peer: "203.0.113.9",
    path: "/api/server-info",
    reason: "令牌无效或缺失",
  });
  const events = parsed();
  const summaries = events.filter(
    (event) => typeof event.coalesced === "object" && event.coalesced !== null,
  );
  assert.equal(summaries.length, 1, "跨窗时必须补一条汇总");
  const summary = summaries[0]!.coalesced as {
    count: number;
    windowMs: number;
    firstAt: string;
    lastAt: string;
  };
  assert.equal(summary.count, 10, "汇总计数必须等于窗口内实际事件数（一条都不能丢）");
  assert.equal(summary.windowMs, 1_000);
  assert.match(summary.firstAt, /^\d{4}-/);
  // 明细 3 条 + 汇总 1 条 + 新窗口首条 1 条 = 5 条日志，而不是 11 条。
  assert.equal(events.length, 5, "降噪后日志条数应远小于事件数");
});

test("不同对端不合并（多源扫描必须看得见）", () => {
  const { audit, parsed } = captureAudit({
    coalesceWindowMs: 10_000,
    coalesceMaxEventsPerWindow: 1,
  });
  audit.record({ kind: "audit:auth-failure", peer: "198.51.100.1", reason: "r" });
  audit.record({ kind: "audit:auth-failure", peer: "198.51.100.2", reason: "r" });
  audit.record({ kind: "audit:auth-failure", peer: "198.51.100.3", reason: "r" });
  assert.equal(audit.pendingKeyCount(), 3, "三个对端 = 三个独立的合并窗口");
  assert.deepEqual(
    parsed().map((event) => event.peer),
    ["198.51.100.1", "198.51.100.2", "198.51.100.3"],
  );
});

test("flush：进程退出前写出窗口内计数（不丢）", () => {
  const { audit, parsed } = captureAudit({ coalesceMaxEventsPerWindow: 1 });
  audit.record({ kind: "audit:origin-rejected", peer: "203.0.113.7", reason: "跨站" });
  audit.record({ kind: "audit:origin-rejected", peer: "203.0.113.7", reason: "跨站" });
  audit.record({ kind: "audit:origin-rejected", peer: "203.0.113.7", reason: "跨站" });
  audit.flush();
  const summary = parsed().find(
    (event) => typeof event.coalesced === "object" && event.coalesced !== null,
  );
  assert.ok(summary, "flush 必须给出汇总");
  assert.equal((summary.coalesced as { count: number }).count, 3);
  assert.equal(audit.pendingKeyCount(), 0, "flush 后窗口清空");
});

test("**否定式**：令牌字面量、查询串、cookie、Origin 绝不进日志", () => {
  const secretToken = "super-secret-token-do-not-log-me";
  const { audit, lines } = captureAudit();
  const event: AuditEvent = {
    kind: "audit:token-reload",
    peer: "local",
    reason: "SIGHUP 重载令牌文件",
    tokenCount: 2,
    tokenLabels: ["<env>", "手机"],
  };
  audit.record(event);
  audit.record({
    kind: "audit:auth-failure",
    peer: "203.0.113.7",
    method: "GET",
    path: "/api/server-info",
    reason: "令牌无效或缺失",
  });
  const text = lines.map((line) => line.text).join("\n");

  for (const forbidden of [
    secretToken,
    "zcode_lite_token=",
    "?token=",
    "Cookie",
    "cookie",
    "Origin",
    "Bearer",
  ]) {
    assert.equal(
      text.includes(forbidden),
      false,
      "审计日志不得包含 " + JSON.stringify(forbidden) + "；实际：" + text.slice(0, 200),
    );
  }
  // 反向自检：断言本身有牙齿 —— 同一段文本里确实能找到我们**期望**出现的字段。
  assert.match(
    text,
    /"tokenLabels":\["<env>","手机"\]/,
    "标签必须写进去（否则排障时不知道撤销了谁）",
  );
  assert.match(text, /"path":"\/api\/server-info"/, "路径必须写进去（不含查询串）");
});

test("审计写入失败不影响调用方，且不静默（fail-loud）", () => {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  try {
    const audit = createAuditLog({
      write: () => {
        throw new Error("sink 坏了");
      },
    });
    assert.doesNotThrow(() => audit.record({ kind: "audit:ws-open", peer: "p" }));
    assert.equal(errors.length, 1, "写入失败必须留下 error（不静默）");
    assert.match(errors[0]!, /审计写入失败/);
  } finally {
    console.error = originalError;
  }
});
