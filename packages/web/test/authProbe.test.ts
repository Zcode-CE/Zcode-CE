import assert from "node:assert/strict";
import test from "node:test";
import { buildUnauthorizedMessage, classifyServerInfoProbe } from "../src/authProbe.js";

/**
 * 未授权态的判定与文案护栏（task-21 缺陷 (a)）。
 *
 * 缺陷现象：无凭据访问时界面显示「连接已中断，正在重连（第 N 次）」并无限重试 ——
 * 把授权问题说成网络问题，且不给用户任何可照做的下一步。
 * 这里钉住两件事：① 401/403 必须判成 unauthorized（不是 unreachable）；
 * ② 未授权文案必须是可照做的（含 origin 与 ?token=），并且不得出现「重连 / reconnect」字样。
 */

test("classifyServerInfoProbe：401/403 = 未授权，2xx = 已授权，其余 = 不可达", () => {
  assert.equal(classifyServerInfoProbe({ status: 200 }), "authorized");
  assert.equal(classifyServerInfoProbe({ status: 204 }), "authorized");
  assert.equal(classifyServerInfoProbe({ status: 401 }), "unauthorized");
  assert.equal(classifyServerInfoProbe({ status: 403 }), "unauthorized");
  assert.equal(classifyServerInfoProbe({ status: 500 }), "unreachable");
  assert.equal(classifyServerInfoProbe({ networkError: true }), "unreachable");
  assert.equal(classifyServerInfoProbe({}), "unreachable");
});

test("未授权文案可照做，且不得把授权问题说成断线重连", () => {
  for (const isChinese of [true, false]) {
    const message = buildUnauthorizedMessage(isChinese, "http://10.0.0.5:3030");
    assert.match(message, /10\.0\.0\.5:3030/);
    assert.match(message, /\?token=/);
    assert.match(message, /ZCODE_SERVER_AUTH_TOKEN/);
    assert.doesNotMatch(message, /重连|正在尝试|reconnect/i, "未授权文案不得提重连");
  }
});
