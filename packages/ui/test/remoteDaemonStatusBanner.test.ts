import assert from "node:assert/strict";
import test from "node:test";
import type { RemoteDaemonReconnectState } from "@zcode/shared";
import { describeRemoteDaemonBanner } from "../src/remoteDaemonStatusBannerModel.js";
import { useRemoteDaemonStatusStore } from "../src/store/remoteDaemonStatusStore.js";

/**
 * 远程 daemon 连接横幅的四种状态（Lead 指定的最小 UI）。
 *
 * 断言口径是「用户能据此做什么」，不是「渲染了什么 div」：
 *   - 正常连接不显示横幅（不占屏幕）；
 *   - 重连中给出第几次/多久后重试；
 *   - daemon 重启后必须提示「需重开会话」，不能显示成「已恢复」；
 *   - 断开态必须能拿到 core 日志路径（排障入口）。
 * 状态结构来自 @zcode/shared，这里只测呈现映射与 store 行为。
 */

const identity = { serverId: "srv-1", generation: 7, pid: 4242 };

test("connected 不显示横幅（正常态不占屏幕）", () => {
  assert.equal(describeRemoteDaemonBanner({ kind: "connected", identity }), null);
});

test("重连中：显示次数与下次等待秒数", () => {
  const model = describeRemoteDaemonBanner({
    kind: "reconnecting",
    attempt: 2,
    maxAttempts: 4,
    nextDelayMs: 1_500,
    reason: "connection-closed",
  });
  assert.ok(model);
  assert.equal(model.tone, "progress");
  assert.equal(model.descriptionKey, "remote.daemon.reconnecting.description");
  assert.deepEqual(model.descriptionParams, { attempt: 2, maxAttempts: 4, seconds: 2 });
});

test("接回过程中（reattaching）：进行中，不得提前报已恢复", () => {
  const model = describeRemoteDaemonBanner({ kind: "reattaching", reason: "port swap" });
  assert.ok(model);
  assert.equal(model.tone, "progress");
  assert.notEqual(model.tone, "success", "端口换代完成前不能显示成功");
});

test("re-attach 全部完成才是成功态（recovered）", () => {
  const model = describeRemoteDaemonBanner({ kind: "recovered", identity });
  assert.ok(model);
  assert.equal(model.tone, "success");
  assert.equal(model.titleKey, "remote.daemon.recovered.title");
  assert.equal(model.action, "none");
});

test("daemon 重启：警告 + 可查看日志（不能显示成已恢复）", () => {
  const model = describeRemoteDaemonBanner({
    kind: "needs-rebuild",
    reason: "daemon restarted",
    previous: { generation: 7, pid: 4242 },
    current: { generation: 8, pid: 9001 },
    identity: { serverId: "srv-1", generation: 8, pid: 9001 },
    coreLogPath: "/home/u/.zcode/server/run/core.log",
  });
  assert.ok(model);
  assert.equal(model.tone, "warning");
  assert.equal(model.titleKey, "remote.daemon.needsRebuild.title");
  assert.equal(model.action, "reopen-session", "处置动作是重开会话（工作区级），不是只给日志");
  assert.equal(model.coreLogPath, "/home/u/.zcode/server/run/core.log");
});

test("已断开：错误态 + 原因 + 重试动作 + 日志路径", () => {
  const model = describeRemoteDaemonBanner({
    kind: "disconnected",
    reason: "重连 4 次均失败",
    coreLogPath: "/home/u/.zcode/server/run/core.log",
  });
  assert.ok(model);
  assert.equal(model.tone, "error");
  assert.equal(model.action, "retry");
  assert.equal(model.descriptionParams?.reason, "重连 4 次均失败");
  assert.match(model.coreLogPath ?? "", /core\.log$/u);
});

test("store：收到新状态即恢复展示（用户关闭过的横幅不会吞掉新事件）", () => {
  const store = useRemoteDaemonStatusStore.getState();
  store.reset();
  const reconnecting: RemoteDaemonReconnectState = {
    kind: "reconnecting",
    attempt: 1,
    maxAttempts: 4,
    nextDelayMs: 0,
    reason: "connection-closed",
  };
  store.setState(reconnecting);
  assert.deepEqual(useRemoteDaemonStatusStore.getState().state, reconnecting);
  store.dismiss();
  assert.equal(useRemoteDaemonStatusStore.getState().dismissed, true);
  store.setState({ kind: "disconnected", reason: "重试耗尽" });
  assert.equal(
    useRemoteDaemonStatusStore.getState().dismissed,
    false,
    "新的状态必须重新可见：否则用户永远看不到后续结果",
  );
  useRemoteDaemonStatusStore.getState().reset();
});
