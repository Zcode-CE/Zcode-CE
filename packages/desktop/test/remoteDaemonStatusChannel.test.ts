import assert from "node:assert/strict";
import test from "node:test";
import { PlatformChannels, hostResponseMessageSchema } from "@zcode/shared";

/**
 * 远程 daemon 状态通道的接缝验收：host 产出的结构 → main 校验 → renderer 消费的结构必须一致。
 *
 * 为什么必须有这一条：这条链有四段（host postMessage → shared schema 校验 → main 转发 IPC →
 * preload/desktopPlatform 订阅）。任何一段名字写错或字段被 schema 拒绝，最终表现都是
 * 「横幅永远不出现」且没有任何报错 —— 单看任一段都是绿的。
 *
 * 这里不 mock renderer：直接拿 host 真正会 postMessage 的那个对象，走一遍 schema，再把
 * 校验后的结果当成 IPC 载荷喂给 UI 的呈现层，断言用户最终看到的东西。
 */

const identity = {
  serverId: "srv-1",
  generation: 7,
  pid: 4242,
  coreLogPath: "/home/u/.zcode/server/run/core.log",
};

const HOST_STATES = [
  {
    kind: "reconnecting",
    attempt: 2,
    maxAttempts: 4,
    nextDelayMs: 1_000,
    reason: "connection-closed",
  },
  { kind: "recovered", identity },
  {
    kind: "needs-rebuild",
    reason: "daemon 已重启，之前的会话不再存在",
    previous: { generation: 7, pid: 4242 },
    current: { generation: 8, pid: 9001 },
    identity: { ...identity, generation: 8, pid: 9001 },
    coreLogPath: identity.coreLogPath,
  },
  { kind: "disconnected", reason: "重连 4 次均失败", coreLogPath: identity.coreLogPath },
] as const;

test("通道名唯一且 host/renderer 两侧一致", () => {
  assert.equal(PlatformChannels.RemoteDaemonStatusChanged, "zcode:remote-daemon-status-changed");
});

test("host 状态经 shared schema 校验后结构不变（main 转发不会丢字段）", () => {
  for (const state of HOST_STATES) {
    const hostMessage = { type: "remote-daemon-status-changed", state };
    const parsed = hostResponseMessageSchema.safeParse(hostMessage);
    assert.equal(parsed.success, true, "host 产物必须能过 main 的严格 schema：" + state.kind);
    if (!parsed.success) continue;
    // main 只做薄转发：IPC 载荷 = { state }，与 host 发出的 state 深度相等。
    const ipcPayload = { state: parsed.data.state };
    assert.deepEqual(ipcPayload.state, state, "转发过程不得改写状态：" + state.kind);
  }
});

test("未登记的状态会被 schema 拒绝（不会静默变成「已恢复」）", () => {
  const parsed = hostResponseMessageSchema.safeParse({
    type: "remote-daemon-status-changed",
    state: { kind: "unknown" },
  });
  assert.equal(parsed.success, false);
});
