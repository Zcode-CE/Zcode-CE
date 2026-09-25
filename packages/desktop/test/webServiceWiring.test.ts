import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PlatformChannels } from "@zcode/shared";
import { WEB_SERVICE_CHANNELS, registerWebServiceIpc } from "../src/main/web-service/ipc.js";
import { createWebServiceController } from "../src/main/web-service/service.js";
import { readWebServiceState } from "../src/main/web-service/state.js";
import {
  readTokenForTest,
  createRealDeps,
  pickFreePort,
  waitForProcessGone,
} from "./support/webServiceRealDeps.js";
import {
  buildRemoteControlWiring,
  parseRemoteControlConnectionInfo,
  resolveRemoteControlEntryStatus,
} from "../../ui/src/remoteControlWiring.js";

/**
 * 切片 4 的接线验收：**真实五条通道 → 真实子进程 → 映射层 → 面板 props**。
 *
 * 为什么这样切：Electron 端到端本机不可行（无 xvfb，见 TASK80-STEP4-IPC.md §4），
 * 但"渲染进程能拿到什么"这件事**不需要 Electron 就能验到最终消费点** ——
 * 只要把 `registerWebServiceIpc` 注册的 **真实 handler** 当成 preload 的角色来调用，
 * 拿到的东西与 preload 转交给渲染进程的**逐字段一致**（同一份 `controller.status()` 载荷）。
 *
 * 本文件钉三件事：
 * 1. **通道名单一来源**：`WEB_SERVICE_CHANNELS` 与 `PlatformChannels` 必须逐字段相等
 *    （两处各写一份字符串会让广播**静默**收不到）；
 * 2. **令牌只经 connectionInfo**：走完四条 handle 后，status/start/stop 的载荷里都不含令牌，
 *    只有 connectionInfo 带（契约 §5）；
 * 3. **映射层吃到真实载荷**：真实 running 状态下 `buildRemoteControlWiring` 给出
 *    `entry.status === "running"` + 带令牌链接 → 面板可渲染二维码；陈旧条目给出 `"off"`。
 *
 * 运行：cd packages/desktop && node --import tsx --test test/webServiceWiring.test.ts
 */

interface FakeIpcMain {
  handlers: Map<string, (...args: unknown[]) => unknown>;
  handle(channel: string, listener: (...args: unknown[]) => unknown): void;
}

function createFakeIpcMain(): FakeIpcMain {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    handle(channel, listener) {
      handlers.set(channel, listener);
    },
  };
}

async function withHarness(
  body: (harness: {
    dir: string;
    statePath: string;
    tokenPath: string;
    ipcMain: FakeIpcMain;
    broadcasts: { channel: string; payload: unknown }[];
    call: (channel: string, ...args: unknown[]) => Promise<unknown>;
    killAll: () => void;
  }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-wswiring-"));
  const statePath = join(dir, "web-service.json");
  const tokenPath = join(dir, "token");
  const real = createRealDeps({ statePath, tokenPath, readyTimeoutMs: 10_000, stopGraceMs: 3_000 });
  const ipcMain = createFakeIpcMain();
  const broadcasts: { channel: string; payload: unknown }[] = [];
  const controller = createWebServiceController(real.deps);
  registerWebServiceIpc({
    ipcMain,
    controller,
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
  });
  const call = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const handler = ipcMain.handlers.get(channel);
    assert.ok(handler, "通道未注册：" + channel);
    return await handler({}, ...args);
  };
  try {
    await body({ dir, statePath, tokenPath, ipcMain, broadcasts, call, killAll: real.killAll });
  } finally {
    real.killAll();
    await rm(dir, { recursive: true, force: true });
  }
}

test("通道名单一来源：main 侧常量与 shared 的 PlatformChannels 逐字段相等", () => {
  // 两处各写一份字符串的后果是**静默**的：preload 订阅的通道名与 main 广播的不一致时，
  // 没有报错，只是"状态永远不更新"。所以用断言钉住两者相等。
  assert.equal(WEB_SERVICE_CHANNELS.status, PlatformChannels.WebServiceStatus);
  assert.equal(WEB_SERVICE_CHANNELS.start, PlatformChannels.WebServiceStart);
  assert.equal(WEB_SERVICE_CHANNELS.stop, PlatformChannels.WebServiceStop);
  assert.equal(WEB_SERVICE_CHANNELS.connectionInfo, PlatformChannels.WebServiceConnectionInfo);
  assert.equal(WEB_SERVICE_CHANNELS.changed, PlatformChannels.WebServiceChanged);
});

test("★真实子进程：start → status → connectionInfo 走完，令牌只出现在 connectionInfo", async () => {
  await withHarness(async (harness) => {
    const port = await pickFreePort();
    const started = (await harness.call(WEB_SERVICE_CHANNELS.start, {
      scope: "loopback",
      port,
    })) as { state: string; port?: number };
    assert.equal(started.state, "running", "真实子进程应起来");

    const token = await readTokenForTest(harness.tokenPath);
    assert.ok(token && token.length >= 32, "令牌文件必须含足够长的令牌");

    // ① status：不得含令牌。
    const status = await harness.call(WEB_SERVICE_CHANNELS.status);
    assert.equal(
      JSON.stringify(status).includes(token),
      false,
      "status 载荷绝不能携带令牌（契约 §5）",
    );
    // ② stop/start 的返回值同样不得含令牌（它们也是 WebServiceStatus）。
    assert.equal(
      JSON.stringify(await harness.call(WEB_SERVICE_CHANNELS.stop)),
      JSON.stringify(await harness.call(WEB_SERVICE_CHANNELS.status)),
      "stop 返回的也是 status 形状",
    );

    // ③ 重新起来，走 connectionInfo：**这里**才该有令牌。
    const restarted = (await harness.call(WEB_SERVICE_CHANNELS.start, {
      scope: "loopback",
      port,
    })) as { state: string };
    assert.equal(restarted.state, "running");
    const info = (await harness.call(WEB_SERVICE_CHANNELS.connectionInfo)) as {
      url: string;
      linkWithToken: string;
    } | null;
    assert.ok(info, "running 时 connectionInfo 必须有值");
    assert.match(info.linkWithToken, /\?token=/, "带令牌链接必须含 ?token=");

    // ④ 广播：changed 是广播而非 handle，且载荷不含令牌。
    assert.equal(harness.ipcMain.handlers.has(WEB_SERVICE_CHANNELS.changed), false);
    assert.ok(harness.broadcasts.length > 0, "动作之后必须广播（否则入口不回显）");
    for (const item of harness.broadcasts) {
      assert.equal(item.channel, PlatformChannels.WebServiceChanged);
      assert.equal(JSON.stringify(item.payload).includes(token), false, "广播载荷绝不能携带令牌");
    }
  });
});

test("★真实载荷 → 映射层：running 给出 running 入口 + 可渲染二维码", async () => {
  await withHarness(async (harness) => {
    const port = await pickFreePort();
    await harness.call(WEB_SERVICE_CHANNELS.start, { scope: "loopback", port });
    const status = await harness.call(WEB_SERVICE_CHANNELS.status);
    const info = await harness.call(WEB_SERVICE_CHANNELS.connectionInfo);

    // 把**真实**载荷喂给映射层（渲染进程侧的第一段逻辑）。
    const wiring = buildRemoteControlWiring({
      status: status as never,
      connectionInfo: info,
      servicePlane: true,
    });
    assert.equal(wiring.renderable, true, "桌面端有能力 ⇒ 可渲染");
    assert.equal(wiring.entry?.status, "running", "真实 running 状态 ⇒ 入口显示运行中");
    assert.ok(wiring.panel, "面板 props 必须有值");
    assert.equal(
      wiring.panel.connection?.linkWithToken,
      (info as { linkWithToken: string }).linkWithToken,
    );
    assert.equal(wiring.panel.status.state, "running");

    // 同一份真实 status 在 web 能力下 ⇒ 两者都不渲染（能力缺失 ⇒ 不渲染，不是禁用）。
    const onWeb = buildRemoteControlWiring({
      status: status as never,
      connectionInfo: info,
      servicePlane: false,
    });
    assert.equal(onWeb.renderable, false);
    assert.equal(onWeb.entry, null);
    assert.equal(onWeb.panel, null);
  });
});

test("★真实 kill -9 ⇒ 陈旧条目：入口回到 off，且面板能看到 staleReason", async () => {
  await withHarness(async (harness) => {
    const port = await pickFreePort();
    await harness.call(WEB_SERVICE_CHANNELS.start, { scope: "loopback", port });
    const record = await readWebServiceState(harness.statePath);
    assert.ok(record);
    process.kill(record.pid, "SIGKILL");
    // 与 webServiceAdoption.test.ts 同一处竞态（CI run 36151161461）：只等「端口关了」不够 ——
    // 端口在进程退出的 exit_files 阶段就释放，而僵尸要等本进程回收才离开进程表，
    // 窗口内 process.kill(pid, 0) 仍成功 ⇒ 探活会判成 port-closed。必须等 pid 真的消失。
    await waitForProcessGone(record.pid);

    const status = (await harness.call(WEB_SERVICE_CHANNELS.status)) as {
      state: string;
      staleReason?: string;
    };
    assert.equal(status.state, "stopped", "进程已死 ⇒ 对外是 stopped（可重新开启）");
    assert.equal(status.staleReason, "pid-dead", "task-83：必须如实带出 reason");

    const wiring = buildRemoteControlWiring({
      status: status as never,
      connectionInfo: await harness.call(WEB_SERVICE_CHANNELS.connectionInfo),
      servicePlane: true,
    });
    assert.equal(wiring.entry?.status, "off", "服务没在跑 ⇒ 入口不得显示运行中");
    assert.equal(wiring.panel?.status.staleReason, "pid-dead", "面板要能显示'上一次的服务已不在'");
    // 没有在跑 ⇒ connectionInfo 为 null ⇒ 不渲染二维码。
    assert.equal(wiring.panel?.connection, null, "没有链接 ⇒ 不渲染二维码");
  });
});

test("映射层的判据：只有 running 才算运行中；web 能力下两者都不渲染", () => {
  const base = { adopted: false, loopback: true } as const;
  assert.equal(resolveRemoteControlEntryStatus({ ...base, state: "running" }), "running");
  assert.equal(resolveRemoteControlEntryStatus({ ...base, state: "stopped" }), "off");
  assert.equal(
    resolveRemoteControlEntryStatus({ ...base, state: "stopped", staleReason: "pid-dead" }),
    "off",
  );
  // running-untrusted 是"端口上别人的服务" ⇒ 我们的远控没开起来，不得显示运行中。
  assert.equal(resolveRemoteControlEntryStatus({ ...base, state: "running-untrusted" }), "off");
  assert.equal(
    resolveRemoteControlEntryStatus({
      ...base,
      state: "failed",
      error: { code: "port-taken", message: "x" },
    }),
    "off",
  );
});

test("跨进程载荷必须校验：畸形/空白链接一律当作没有链接", () => {
  // 不校验的后果：把 undefined/空白当凭据渲染成二维码（假入口）。
  assert.equal(parseRemoteControlConnectionInfo(null), null);
  assert.equal(parseRemoteControlConnectionInfo(undefined), null);
  assert.equal(parseRemoteControlConnectionInfo("http://x"), null);
  assert.equal(parseRemoteControlConnectionInfo({}), null);
  assert.equal(parseRemoteControlConnectionInfo({ url: "http://x" }), null);
  assert.equal(parseRemoteControlConnectionInfo({ url: "http://x", linkWithToken: "   " }), null);
  assert.equal(parseRemoteControlConnectionInfo({ url: 1, linkWithToken: "http://x" }), null);
  const ok = parseRemoteControlConnectionInfo({
    url: "http://x",
    linkWithToken: "http://x/?token=t",
  });
  assert.deepEqual(ok, { url: "http://x", linkWithToken: "http://x/?token=t" });
});
