import assert from "node:assert/strict";
import test from "node:test";
import {
  createRemoteDaemonReconnectController,
  reconnectDelayMs,
  type DaemonReconnectAttempt,
  type RemoteDaemonReconnectState,
} from "../src/host/remoteDaemonReconnectController.js";

/**
 * daemon 重连状态机的三条分支（Lead 决策 #4）。
 *
 * 语义底线：只有 generation/pid 未变才算「恢复」（同一 daemon，pty/agent scope 还在）；
 * 变了必须标 `needs-rebuild` —— 报「已恢复」会让用户以为会话还在，实际已经丢了。
 * 重连只重跑 probe→admission→ticket→ws，绝不静默切 stdio（那会另起一个 server）。
 */

function identity(generation: number, pid: number, coreLogPath?: string) {
  return { serverId: "srv-1", generation, pid, ...(coreLogPath ? { coreLogPath } : {}) };
}

function collect() {
  const states: RemoteDaemonReconnectState[] = [];
  return { states, onStateChange: (state: RemoteDaemonReconnectState) => states.push(state) };
}

test("分支 1：generation/pid 未变 ⇒ recovered（同一 daemon，会话仍在）", async () => {
  const seen = collect();
  const delays: number[] = [];
  const controller = createRemoteDaemonReconnectController({
    reconnect: async () => ({ ok: true, identity: identity(7, 4242) }),
    onStateChange: seen.onStateChange,
    sleep: async (ms) => delays.push(ms),
  });
  const state = await controller.start(identity(7, 4242), "connection-closed");
  assert.equal(state.kind, "recovered");
  assert.deepEqual(delays, [], "第一次尝试应立即进行，不先等退避");
  assert.equal(seen.states[0]?.kind, "reconnecting");
  assert.equal(seen.states.at(-1)?.kind, "recovered");
});

test("分支 2：generation 变了 ⇒ needs-rebuild（daemon 重启，会话全丢）", async () => {
  const seen = collect();
  const controller = createRemoteDaemonReconnectController({
    reconnect: async () => ({
      ok: true,
      identity: identity(8, 9001, "$HOME/.zcode/server/run/core.log"),
    }),
    onStateChange: seen.onStateChange,
    sleep: async () => undefined,
  });
  const state = await controller.start(identity(7, 4242), "connection-closed");
  assert.equal(state.kind, "needs-rebuild");
  if (state.kind === "needs-rebuild") {
    assert.deepEqual(state.previous, { generation: 7, pid: 4242 });
    assert.deepEqual(state.current, { generation: 8, pid: 9001 });
    assert.match(state.coreLogPath ?? "", /core\.log$/u, "需要给用户 core log 入口");
  }
});

test("分支 2b：只有 pid 变化也算重启（generation 缺失时的兜底判据）", async () => {
  const controller = createRemoteDaemonReconnectController({
    reconnect: async () => ({ ok: true, identity: { serverId: "srv-1", pid: 9001 } }),
    sleep: async () => undefined,
  });
  const state = await controller.start({ serverId: "srv-1", pid: 4242 }, "backend-disconnected");
  assert.equal(state.kind, "needs-rebuild");
});

test("分支 3：重试耗尽 ⇒ disconnected，保留最后原因与 core log，且退避按指数增长", async () => {
  const seen = collect();
  const delays: number[] = [];
  let attempts = 0;
  const controller = createRemoteDaemonReconnectController({
    maxAttempts: 4,
    baseDelayMs: 500,
    maxDelayMs: 8_000,
    reconnect: async (): Promise<DaemonReconnectAttempt> => {
      attempts += 1;
      return {
        ok: false,
        kind: "unusable",
        reason: "attempt " + attempts + " failed",
        coreLogPath: "$HOME/.zcode/server/run/core.log",
      };
    },
    onStateChange: seen.onStateChange,
    sleep: async (ms) => delays.push(ms),
  });
  const state = await controller.start(identity(1, 1), "connection-closed");
  assert.equal(state.kind, "disconnected");
  assert.equal(attempts, 4, "最多重试 maxAttempts 次");
  assert.deepEqual(delays, [500, 1000, 2000], "指数退避（第一次不等待）");
  if (state.kind === "disconnected") {
    assert.match(state.reason, /attempt 4 failed/u, "要带最后一次的真实原因");
    assert.match(state.coreLogPath ?? "", /core\.log$/u);
  }
  const reconnectings = seen.states.filter((item) => item.kind === "reconnecting");
  assert.equal(reconnectings.length, 4);
});

test("不可重试的失败（未安装/不支持/不兼容/起不来）⇒ 立即 disconnected，不空转", async () => {
  for (const kind of ["not-installed", "unsupported", "incompatible", "start-failed"] as const) {
    let attempts = 0;
    const controller = createRemoteDaemonReconnectController({
      reconnect: async () => {
        attempts += 1;
        return { ok: false, kind, reason: kind + " failure" };
      },
      sleep: async () => undefined,
    });
    const state = await controller.start(identity(1, 1), "connection-closed");
    assert.equal(state.kind, "disconnected", kind + " 应直接放弃");
    assert.equal(attempts, 1, kind + " 不该重试");
  }
});

test("cancel()：进行中的重连立即收口为 disconnected（不继续退避）", async () => {
  let attempts = 0;
  const controller = createRemoteDaemonReconnectController({
    maxAttempts: 4,
    reconnect: async () => {
      attempts += 1;
      return { ok: false, kind: "unusable", reason: "flaky" };
    },
    sleep: async () => {
      controller.cancel();
    },
  });
  const state = await controller.start(identity(1, 1), "connection-closed");
  assert.equal(state.kind, "disconnected");
  assert.match(state.kind === "disconnected" ? state.reason : "", /取消/u);
  assert.equal(attempts, 1, "取消后不再尝试");
});

test("re-attach 成功 ⇒ recovered（recovered 只在真正接回窗口后发出）", async () => {
  const seen = collect();
  let reattachCalls = 0;
  const controller = createRemoteDaemonReconnectController({
    reconnect: async () => ({ ok: true, identity: identity(7, 4242) }),
    reattach: async () => {
      reattachCalls += 1;
      return { ok: true };
    },
    onStateChange: seen.onStateChange,
    sleep: async () => undefined,
  });
  const state = await controller.start(identity(7, 4242), "connection-closed");
  assert.equal(reattachCalls, 1, "同一 daemon 必须尝试一次 re-attach");
  assert.equal(state.kind, "recovered");
  const kinds = seen.states.map((item) => item.kind);
  assert.ok(kinds.includes("reattaching"), "接回过程要作为独立阶段上报");
  assert.ok(
    kinds.indexOf("reattaching") < kinds.indexOf("recovered"),
    "必须先 reattaching 再 recovered",
  );
});

test("re-attach 失败 ⇒ needs-rebuild，且绝不出现 recovered", async () => {
  const seen = collect();
  const controller = createRemoteDaemonReconnectController({
    reconnect: async () => ({ ok: true, identity: identity(7, 4242) }),
    reattach: async () => ({ ok: false, reason: "renderer port swap failed" }),
    onStateChange: seen.onStateChange,
    sleep: async () => undefined,
  });
  const state = await controller.start(identity(7, 4242), "connection-closed");
  assert.equal(state.kind, "needs-rebuild");
  if (state.kind === "needs-rebuild") {
    assert.match(state.reason, /接回窗口/u);
  }
  assert.equal(
    seen.states.some((item) => item.kind === "recovered"),
    false,
    "接不回来就不能报已恢复（否则 UI 会骗用户）",
  );
});

test("reconnect 抛错不得被当成成功（未真正连上就不能报 recovered）", async () => {
  const seen = collect();
  const controller = createRemoteDaemonReconnectController({
    maxAttempts: 2,
    reconnect: async () => {
      throw new Error("attach failed");
    },
    onStateChange: seen.onStateChange,
    sleep: async () => undefined,
  });
  await assert.rejects(
    () => controller.start(identity(1, 1), "connection-closed"),
    /attach failed/u,
    "重连实现的异常必须冒泡，不能被吞成 recovered",
  );
  assert.equal(
    seen.states.some((state) => state.kind === "recovered" || state.kind === "needs-rebuild"),
    false,
    "异常路径不得产生任何「已连上」类状态",
  );
});

test("退避上限截断：delay 不超过 maxDelayMs", () => {
  assert.equal(reconnectDelayMs(1, 500, 8_000), 500);
  assert.equal(reconnectDelayMs(2, 500, 8_000), 1_000);
  assert.equal(reconnectDelayMs(10, 500, 8_000), 8_000);
});
