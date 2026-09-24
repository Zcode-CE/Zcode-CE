import assert from "node:assert/strict";
import test from "node:test";
import {
  registerWebServiceIpc,
  WEB_SERVICE_CHANNELS,
  type WebServiceIpcMainLike,
} from "../src/main/web-service/ipc.js";
import type { WebServiceController, WebServiceStatus } from "../src/main/web-service/service.js";

const TOKEN = "secret-token-must-not-leak-into-status";

function createFakeIpcMain() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const fake: WebServiceIpcMainLike = {
    handle(channel, listener) {
      assert.ok(!handlers.has(channel), `通道被注册了两次：${channel}`);
      handlers.set(channel, listener as (...args: unknown[]) => unknown);
    },
  };
  return { fake, handlers };
}

interface FakeController extends WebServiceController {
  setState: (state: WebServiceStatus) => void;
  started: number;
  stopped: number;
}

function createFakeController(initial: WebServiceStatus): FakeController {
  let current = initial;
  const controller: FakeController = {
    started: 0,
    stopped: 0,
    setState: (state) => {
      current = state;
    },
    status: async () => current,
    start: async () => {
      controller.started += 1;
      current = {
        state: "running",
        adopted: false,
        loopback: true,
        host: "127.0.0.1",
        port: 3030,
        url: "http://127.0.0.1:3030",
      };
      return current;
    },
    stop: async () => {
      controller.stopped += 1;
      current = { state: "stopped", adopted: false, loopback: true };
      return current;
    },
    connectionInfo: async () =>
      current.state === "running"
        ? { url: "http://127.0.0.1:3030", linkWithToken: `http://127.0.0.1:3030/?token=${TOKEN}` }
        : null,
  };
  return controller;
}

function setup(initial: WebServiceStatus) {
  const { fake, handlers } = createFakeIpcMain();
  const controller = createFakeController(initial);
  const broadcasts: { channel: string; payload: WebServiceStatus }[] = [];
  registerWebServiceIpc({
    ipcMain: fake,
    controller,
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
  });
  return { handlers, controller, broadcasts };
}

test("注册集合：四条 handle 都在，changed 走广播而不是 handle", () => {
  const { handlers } = setup({ state: "stopped", adopted: false, loopback: true });
  assert.deepEqual(
    [...handlers.keys()].sort(),
    [
      WEB_SERVICE_CHANNELS.connectionInfo,
      WEB_SERVICE_CHANNELS.start,
      WEB_SERVICE_CHANNELS.status,
      WEB_SERVICE_CHANNELS.stop,
    ].sort(),
  );
  assert.ok(
    !handlers.has(WEB_SERVICE_CHANNELS.changed),
    "changed 是主→渲染广播，不应注册成 handle",
  );
});

test("changed 载荷与 status 同形，且绝不含令牌", async () => {
  const { handlers, broadcasts } = setup({ state: "stopped", adopted: false, loopback: true });
  const start = handlers.get(WEB_SERVICE_CHANNELS.start);
  assert.ok(start);
  const returned = (await start({}, { scope: "loopback" })) as WebServiceStatus;

  assert.equal(broadcasts.length, 1, "start 之后必须广播一次");
  const [{ channel, payload }] = broadcasts;
  assert.equal(channel, WEB_SERVICE_CHANNELS.changed);
  assert.deepEqual(payload, returned, "广播载荷必须与 start 返回的 status 同形");
  assert.ok(
    !JSON.stringify(payload).includes(TOKEN),
    "status/changed 载荷里不得出现令牌（令牌只走 connectionInfo.linkWithToken）",
  );
  assert.deepEqual(
    Object.keys(payload).sort(),
    Object.keys(returned).sort(),
    "载荷键集合必须与 status 一致",
  );
});

test("令牌只从 connectionInfo 出来（对照：那里必须有令牌）", async () => {
  const { handlers, broadcasts } = setup({ state: "stopped", adopted: false, loopback: true });
  const start = handlers.get(WEB_SERVICE_CHANNELS.start);
  const info = handlers.get(WEB_SERVICE_CHANNELS.connectionInfo);
  assert.ok(start && info);
  await start({}, { scope: "loopback" });
  const connection = (await info({})) as { linkWithToken: string } | null;
  assert.ok(connection, "running 时 connectionInfo 必须有值");
  assert.ok(connection.linkWithToken.includes(TOKEN));
  assert.ok(broadcasts.every((item) => !JSON.stringify(item.payload).includes(TOKEN)));
});

test("探活结论变化才广播：同样的 status 读两次只推一次，状态变了再推", async () => {
  const { handlers, controller, broadcasts } = setup({
    state: "stopped",
    adopted: false,
    loopback: true,
  });
  const status = handlers.get(WEB_SERVICE_CHANNELS.status);
  assert.ok(status);
  await status({});
  assert.equal(broadcasts.length, 1, "第一次读状态 → 广播一次");
  await status({});
  assert.equal(broadcasts.length, 1, "结论没变 ⇒ 不重复广播");
  controller.setState({
    state: "running",
    adopted: true,
    loopback: false,
    host: "0.0.0.0",
    port: 3030,
  });
  await status({});
  assert.equal(broadcasts.length, 2, "结论变了 ⇒ 必须广播");
  assert.equal(broadcasts[1].payload.state, "running");
  assert.equal(broadcasts[1].payload.loopback, false, "非回环要让面板能显示安全提示");
});

test("stop 之后也广播（状态回到 stopped）", async () => {
  const { handlers, broadcasts } = setup({ state: "stopped", adopted: false, loopback: true });
  const start = handlers.get(WEB_SERVICE_CHANNELS.start);
  const stop = handlers.get(WEB_SERVICE_CHANNELS.stop);
  assert.ok(start && stop);
  await start({}, { scope: "loopback" });
  await stop({});
  assert.equal(broadcasts.at(-1)?.payload.state, "stopped");
});
