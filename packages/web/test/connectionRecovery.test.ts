import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_RECONNECT_POLICY,
  createConnectionSupervisor,
  reconnectDelayMs,
  type ConnectionPhase,
  type ConnectionPhaseInfo,
} from "../src/connectionRecovery.js";
import { evaluateServerCompatibility } from "../src/serverCompatibility.js";

/**
 * 断线自愈的护栏（task-16 的最高价值项）。
 *
 * 为什么必须钉住：手机锁屏/切后台必然断连，而修复前 `packages/client/src/websocket.ts` 不重连、
 * web 入口的 onClose 是空实现 —— 断线后页面假死且没有任何提示。这里断言的是**行为契约**：
 * 退避序列、失败次数上限、用户手动重试、以及断线后一定会重新建立连接。
 * 时钟与连接函数都是注入的，因此不依赖真实网络与真实计时器。
 */

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function createFakeClock() {
  let nextId = 1;
  const timers = new Map<number, { handler: () => void; delayMs: number }>();
  return {
    setTimeoutImpl: (handler: () => void, delayMs: number) => {
      const id = nextId;
      nextId += 1;
      timers.set(id, { handler, delayMs });
      return id;
    },
    clearTimeoutImpl: (handle: unknown) => {
      timers.delete(handle as number);
    },
    pendingDelays: () => [...timers.values()].map((timer) => timer.delayMs),
    async runPending() {
      const entries = [...timers.entries()];
      for (const [id] of entries) timers.delete(id);
      for (const [, timer] of entries) timer.handler();
      await flush();
    },
  };
}

function createDeferredConnector<T>() {
  const pending: Array<{ resolve: (value: T) => void; reject: (error: unknown) => void }> = [];
  let total = 0;
  return {
    connect: () => {
      total += 1;
      return new Promise<T>((resolve, reject) => {
        pending.push({ resolve, reject });
      });
    },
    /** 累计发起过多少次连接（pending 会被测试消费掉，不能拿它当调用次数）。 */
    calls: () => total,
    async succeedWith(value: T) {
      const call = pending.shift();
      assert.ok(call, "没有待完成的连接调用");
      call.resolve(value);
      await flush();
    },
    async failWith(error: unknown) {
      const call = pending.shift();
      assert.ok(call, "没有待完成的连接调用");
      call.reject(error);
      await flush();
    },
  };
}

function createHarness(options: { maxAttempts?: number } = {}) {
  const clock = createFakeClock();
  const connector = createDeferredConnector<string>();
  const phases: Array<{ phase: ConnectionPhase; info: ConnectionPhaseInfo }> = [];
  const sessions: string[] = [];
  const supervisor = createConnectionSupervisor<string>({
    connect: connector.connect,
    onSession: (session) => sessions.push(session),
    onPhase: (phase, info) => phases.push({ phase, info }),
    policy: {
      maxAttempts: options.maxAttempts ?? 3,
      baseDelayMs: 500,
      maxDelayMs: 10_000,
      jitterRatio: 0,
    },
    random: () => 0.5,
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
  });
  return { clock, connector, phases, sessions, supervisor };
}

test("退避序列：指数增长并按上限截断", () => {
  const policy = { ...DEFAULT_RECONNECT_POLICY, jitterRatio: 0 };
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7].map((attempt) => reconnectDelayMs(attempt, policy, () => 0.5)),
    [500, 1000, 2000, 4000, 8000, 10_000, 10_000],
  );
  // 抖动区间：random 取 0 / 1 分别对应下界与上界（用默认抖动比例 0.2）。
  const jittered = { ...DEFAULT_RECONNECT_POLICY };
  assert.equal(
    reconnectDelayMs(1, jittered, () => 0),
    400,
  );
  assert.equal(
    reconnectDelayMs(1, jittered, () => 1),
    600,
  );
});

test("首次连接成功：connected 且回调拿到会话", async () => {
  const { connector, phases, sessions, supervisor } = createHarness();
  supervisor.start();
  assert.deepEqual(
    phases.map((entry) => entry.phase),
    ["connecting"],
  );
  await connector.succeedWith("session-1");
  assert.equal(supervisor.phase(), "connected");
  assert.deepEqual(sessions, ["session-1"]);
});

test("连接失败 → 退避重连 → 成功；退避序列与尝试次数正确", async () => {
  const { clock, connector, phases, sessions, supervisor } = createHarness();
  supervisor.start();
  assert.equal(connector.calls(), 1);

  await connector.failWith(new Error("boom"));
  assert.equal(supervisor.phase(), "reconnecting");
  assert.deepEqual(clock.pendingDelays(), [500]);
  assert.equal(phases.at(-1)?.info.attempt, 1);

  await clock.runPending();
  assert.equal(connector.calls(), 2);
  await connector.failWith(new Error("boom again"));
  assert.deepEqual(clock.pendingDelays(), [1000]);
  assert.equal(phases.at(-1)?.info.attempt, 2);

  await clock.runPending();
  await connector.succeedWith("session-2");
  assert.equal(supervisor.phase(), "connected");
  assert.equal(supervisor.attempt(), 0, "成功后退避计数必须清零");
  assert.deepEqual(sessions, ["session-2"]);
});

test("已连接后断线（手机锁屏）：立刻进入重连并回到可用", async () => {
  const { clock, connector, phases, sessions, supervisor } = createHarness();
  supervisor.start();
  await connector.succeedWith("session-1");

  supervisor.notifyClosed();
  assert.equal(supervisor.phase(), "reconnecting");
  assert.deepEqual(clock.pendingDelays(), [500], "断线后第一次退避从 baseDelayMs 开始");
  assert.equal(phases.at(-1)?.info.attempt, 0, "刚断线时「已失败次数」为 0，覆盖层显示第 1 次尝试");

  // 重复上报（socket 的 close/error 可能各触发一次）不应叠加退避。
  supervisor.notifyClosed();
  assert.deepEqual(clock.pendingDelays(), [500]);

  await clock.runPending();
  await connector.succeedWith("session-2");
  assert.equal(supervisor.phase(), "connected");
  assert.deepEqual(
    sessions,
    ["session-1", "session-2"],
    "重连成功必须重新回调会话（应用据此重新挂载）",
  );
});

test("连续失败到上限：进入 failed、停止自动重连；用户重试后恢复预算", async () => {
  const { clock, connector, phases, supervisor } = createHarness({ maxAttempts: 2 });
  supervisor.start();
  await connector.failWith(new Error("1"));
  await clock.runPending();
  await connector.failWith(new Error("2"));
  assert.equal(supervisor.phase(), "failed");
  assert.deepEqual(clock.pendingDelays(), [], "进入 failed 后不得留有待触发的重连");

  await clock.runPending();
  assert.equal(connector.calls(), 2, "failed 状态下不得再自动连接");

  supervisor.retryNow();
  await flush();
  assert.equal(connector.calls(), 3, "用户重试必须立刻发起新连接");
  await connector.succeedWith("session-after-retry");
  assert.equal(supervisor.phase(), "connected");
  assert.equal(phases.at(-1)?.phase, "connected");
});

test("stop()：取消挂起的重连", async () => {
  const { clock, connector, supervisor } = createHarness();
  supervisor.start();
  await connector.failWith(new Error("boom"));
  assert.deepEqual(clock.pendingDelays(), [500]);
  supervisor.stop();
  assert.deepEqual(clock.pendingDelays(), [], "stop 必须清掉挂起的定时器");
  await clock.runPending();
  assert.equal(connector.calls(), 1, "stop 后不得再连接");
});

test("契约版本比对：一致放行、不一致或缺失明确报错（不静默降级）", () => {
  assert.deepEqual(evaluateServerCompatibility({ protocolVersion: 1, version: "3.14.3-ce.2" }, 1), {
    compatible: true,
  });

  const mismatch = evaluateServerCompatibility({ protocolVersion: 2, version: "9.9.9" }, 1);
  assert.equal(mismatch.compatible, false);
  assert.match(mismatch.compatible === false ? mismatch.reason : "", /1/);
  assert.match(mismatch.compatible === false ? mismatch.reason : "", /2/);
  assert.match(mismatch.compatible === false ? mismatch.reason : "", /9\.9\.9/);

  const missing = evaluateServerCompatibility(undefined, 1);
  assert.equal(missing.compatible, false);
  assert.match(missing.compatible === false ? missing.reason : "", /protocolVersion/);
});
