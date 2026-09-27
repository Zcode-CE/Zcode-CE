import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PlatformChannels } from "@zcode/shared";
import { WEB_SERVICE_CHANNELS, registerWebServiceIpc } from "../src/main/web-service/ipc.js";
import { createWebServiceConnectionPlane } from "../src/main/web-service/remoteControlClient.js";
import { createWebServiceController } from "../src/main/web-service/service.js";
import { createRealDeps, pickFreePort, readTokenForTest } from "./support/webServiceRealDeps.js";

/**
 * 连接面（谁连着）的桌面接线验收：真实八条通道 → 真实子进程 → 真实 HTTP 端点。
 *
 * 为什么这样切（与 webServiceWiring.test.ts 同一判据）：Electron 端到端本机不可行，
 * 但"渲染进程能拿到什么、main 到底调了哪个端点"这两件事不需要 Electron 就能验到最终消费点 ——
 * 把 `registerWebServiceIpc` 注册的真实 handler 当成 preload 的角色来调用，
 * 拿到的东西与 preload 转交给渲染进程的逐字段一致；
 * 而 main 发出的 HTTP 请求由真实替身服务逐条记录，不是靠假 fetch 断言"我以为会这样调"。
 *
 * 本文件钉四件事：
 * 1. 通道名单一来源：新三条也必须与 `PlatformChannels` 逐字段相等；
 * 2. 令牌不跨 IPC 边界：新载荷逐字段穷尽核对，没有任何一个字段含令牌（否定式断言）；
 * 3. 写动作走正确端点：撤销/轮换各自打到 spec §6.4 的那条路径与那个方法；
 * 4. 能力缺失 ⇒ 不注册：不注入连接面时三条通道不存在（反向验证的接线侧一半）。
 *
 * 运行：cd packages/desktop && node --import tsx --test test/webServiceConnectionWiring.test.ts
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

interface RecordedRequest {
  method?: string;
  path?: string;
  query?: string;
  body?: string;
  status?: number;
}

/** 逐行解析替身服务写下的请求记录（方法/路径/查询串/体）。 */
async function readRecordedRequests(path: string): Promise<RecordedRequest[]> {
  try {
    const raw = await readFile(path, "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as RecordedRequest);
  } catch {
    return [];
  }
}

async function withHarness(
  body: (harness: {
    dir: string;
    tokenPath: string;
    recordPath: string;
    ipcMain: FakeIpcMain;
    call: (channel: string, ...args: unknown[]) => Promise<unknown>;
    requests: () => Promise<RecordedRequest[]>;
  }) => Promise<void>,
  options: { connectionsJson?: string; rotateStatus?: number } = {},
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-connwiring-"));
  const statePath = join(dir, "web-service.json");
  const tokenPath = join(dir, "token");
  const recordPath = join(dir, "requests.jsonl");
  const real = createRealDeps({
    statePath,
    tokenPath,
    readyTimeoutMs: 10_000,
    stopGraceMs: 3_000,
    recordPath,
    ...(options.connectionsJson ? { connectionsJson: options.connectionsJson } : {}),
    ...(options.rotateStatus ? { rotateStatus: options.rotateStatus } : {}),
  });
  const ipcMain = createFakeIpcMain();
  const controller = createWebServiceController(real.deps);
  const plane = createWebServiceConnectionPlane({ status: () => controller.status(), tokenPath });
  registerWebServiceIpc({
    ipcMain,
    controller,
    connectionPlane: plane,
    broadcast: () => {},
  });
  const call = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const handler = ipcMain.handlers.get(channel);
    assert.ok(handler, "通道未注册：" + channel);
    return await handler({}, ...args);
  };
  try {
    await body({
      dir,
      tokenPath,
      recordPath,
      ipcMain,
      call,
      requests: () => readRecordedRequests(recordPath),
    });
  } finally {
    real.killAll();
    await rm(dir, { recursive: true, force: true });
  }
}

test("通道名单一来源：连接面三条也与 PlatformChannels 逐字段相等", () => {
  // 两处各写一份字符串的后果是静默的：preload 与 main 不一致时没有报错，
  // 只是"这条通道永远不工作"。用断言钉住两者相等。
  assert.equal(WEB_SERVICE_CHANNELS.connections, PlatformChannels.WebServiceConnections);
  assert.equal(WEB_SERVICE_CHANNELS.revokeConnection, PlatformChannels.WebServiceRevokeConnection);
  assert.equal(WEB_SERVICE_CHANNELS.rotateToken, PlatformChannels.WebServiceRotateToken);
  // 服务面五条也必须仍然相等（本单元不得改动它们）。
  assert.equal(WEB_SERVICE_CHANNELS.status, PlatformChannels.WebServiceStatus);
  assert.equal(WEB_SERVICE_CHANNELS.connectionInfo, PlatformChannels.WebServiceConnectionInfo);
});

test("反向验证：不注入连接面 ⇒ 三条通道都不注册（能力缺失，不是空实现）", () => {
  // 这是"能力缺失 ⇒ 不渲染"在接线侧的对应事实：没有实现就没有通道，
  // 而不是"有通道但永远返回空"—— 后者会让 UI 把"接不上"误读成"没有设备"。
  const ipcMain = createFakeIpcMain();
  registerWebServiceIpc({
    ipcMain,
    controller: {
      status: async () => ({ state: "stopped", adopted: false, loopback: true }),
      start: async () => ({ state: "stopped", adopted: false, loopback: true }),
      stop: async () => ({ state: "stopped", adopted: false, loopback: true }),
      connectionInfo: async () => null,
    },
    broadcast: () => {},
  });
  for (const channel of [
    WEB_SERVICE_CHANNELS.connections,
    WEB_SERVICE_CHANNELS.revokeConnection,
    WEB_SERVICE_CHANNELS.rotateToken,
  ]) {
    assert.equal(ipcMain.handlers.has(channel), false, "不该注册：" + channel);
  }
  // 服务面仍然照常注册（连接面缺失不得影响服务面）。
  assert.equal(ipcMain.handlers.has(WEB_SERVICE_CHANNELS.status), true);
  assert.equal(ipcMain.handlers.has(WEB_SERVICE_CHANNELS.connectionInfo), true);
});

test("服务没在跑 ⇒ 连接清单是 null（不知道），不是空数组", async () => {
  await withHarness(async (harness) => {
    const payload = await harness.call(WEB_SERVICE_CHANNELS.connections);
    assert.equal(payload, null, "服务没起来 ⇒ 必须返回 null（不知道），不得假装 0 台");
  });
});

test("★真实子进程：空清单是 200 + 空数组（确定 0 台），不是 null", async () => {
  await withHarness(async (harness) => {
    const port = await pickFreePort();
    const started = (await harness.call(WEB_SERVICE_CHANNELS.start, {
      scope: "loopback",
      port,
    })) as { state: string };
    assert.equal(started.state, "running", "真实子进程应起来");

    const payload = (await harness.call(WEB_SERVICE_CHANNELS.connections)) as {
      connections: unknown[];
      revision: number;
    } | null;
    assert.ok(payload, "服务在跑且端点 200 ⇒ 必须是有值载荷");
    assert.deepEqual(payload.connections, [], "空数组 = 确定 0 台（UI 据此显示等待连接）");
    assert.equal(typeof payload.revision, "number");
  });
});

test("★令牌不跨 IPC 边界：连接面载荷逐字段穷尽核对，没有任何字段含令牌", async () => {
  // 这是一条否定式断言：不能只看"没有 token 字段"（那只覆盖想到的字段名），
  // 而要 (a) 值域穷尽 —— 载荷里每个字符串值都不等于令牌；
  //     (b) 键集穷尽 —— 键集合恰好是契约声明的那些，多一个就失败。
  await withHarness(
    async (harness) => {
      const port = await pickFreePort();
      await harness.call(WEB_SERVICE_CHANNELS.start, { scope: "loopback", port });
      const token = await readTokenForTest(harness.tokenPath);
      assert.ok(token && token.length >= 32, "令牌文件必须含足够长的令牌");

      const payload = (await harness.call(WEB_SERVICE_CHANNELS.connections)) as {
        connections: Record<string, unknown>[];
        revision: number;
      } | null;
      assert.ok(payload, "必须拿到载荷才谈得上核对");

      // (a) 值域穷尽：整个序列化载荷不得含令牌串。
      assert.equal(
        JSON.stringify(payload).includes(token),
        false,
        "连接清单载荷绝不能携带令牌（契约 §5）",
      );
      // 也不得含任何"令牌的片段"（前/后各 8 字符）—— 部分泄露同样不可接受。
      for (const slice of [token.slice(0, 8), token.slice(-8)]) {
        assert.equal(
          JSON.stringify(payload).includes(slice),
          false,
          "载荷不得含令牌片段：" + slice,
        );
      }

      // (b) 键集穷尽：顶层恰好两个键。
      assert.deepEqual(Object.keys(payload).sort(), ["connections", "revision"]);
      // 每一行的键集必须落在契约字段里 —— 服务端多返回一个凭据字段时，
      // remoteControlClient 的逐字段重建会让它根本不出现（结构性保证）。
      const allowedRowKeys = ["address", "connectedAt", "id", "role", "userAgent", "workspace"];
      for (const row of payload.connections) {
        for (const key of Object.keys(row)) {
          assert.ok(allowedRowKeys.includes(key), "载荷里出现契约外的字段：" + key);
        }
      }

      // 撤销/轮换的返回值同样不得含令牌。
      const revoked = await harness.call(WEB_SERVICE_CHANNELS.revokeConnection, { all: true });
      assert.equal(JSON.stringify(revoked).includes(token), false, "撤销返回值不得含令牌");
      const rotated = await harness.call(WEB_SERVICE_CHANNELS.rotateToken);
      assert.equal(JSON.stringify(rotated).includes(token), false, "轮换返回值不得含令牌");
    },
    {
      // 故意让服务端多返回一个 token 字段：逐字段重建必须把它挡在 IPC 边界之外。
      connectionsJson: JSON.stringify([
        {
          id: "conn-1",
          address: "192.168.1.20",
          role: "terminal-client",
          userAgent: "Mozilla/5.0 (iPhone)",
          connectedAt: 1_700_000_000_000,
          workspace: "/abs/ws",
          token: "LEAKED-TOKEN-MUST-NOT-REACH-RENDERER",
        },
      ]),
    },
  );
});

test("★生产形态：workspace 省略时解析成功（升级时刻服务端不知道工作区）", async () => {
  // task-16 实测确认：服务端大概率省略 workspace —— 客户端是连上之后才按 server-info
  // 选工作区的，升级时刻服务端并不知道它选了哪个，而 task-16 不编假值。
  //
  // 这条为什么必须单独钉：本文件里"成功路径"的 fixture 一直带着 workspace
  // （令牌不变式那条用的就是带 workspace 的行），于是最可能的真实形态从没被测过。
  // 若 parser 把 workspace 当必填（或 UI 侧解析器如此），生产上会整份判成"不知道" ⇒
  // 设备清单永远不显示，而本地测试全绿。这正是"中间产物全绿、最终消费点失败"。
  await withHarness(
    async (harness) => {
      const port = await pickFreePort();
      await harness.call(WEB_SERVICE_CHANNELS.start, { scope: "loopback", port });
      const payload = (await harness.call(WEB_SERVICE_CHANNELS.connections)) as {
        connections: Record<string, unknown>[];
        revision: number;
      } | null;
      assert.ok(payload, "省略 workspace 是合法载荷，不得整份判成不知道");
      assert.equal(payload.connections.length, 1);
      const [row] = payload.connections;
      assert.equal(row?.id, "conn-no-ws");
      assert.equal(row?.role, "terminal-client");
      assert.equal(row?.connectedAt, 1_700_000_000_000, "epoch 毫秒原样透传");
      // workspace 缺失时不得被补成空串/undefined 键 —— 那会让 UI 显示一个空工作区。
      assert.equal("workspace" in (row ?? {}), false, "缺失就是缺失，不得补键");
    },
    {
      connectionsJson: JSON.stringify([
        {
          id: "conn-no-ws",
          address: "10.1.2.3",
          role: "terminal-client",
          userAgent: "Mozilla/5.0 (Android)",
          connectedAt: 1_700_000_000_000,
        },
      ]),
    },
  );
});

test("★rotate-token 返回 409 ⇒ 上抛且带状态码（不静默当成功）", async () => {
  // task-16 实测：没有配置文件令牌的部署下 rotate-token 返回 409，
  // 不是静默 no-op、也不是 200。桌面 spawn 走 ZCODE_SERVER_AUTH_TOKENS_FILE（service.ts:264），
  // 所以正常桌面链路可轮换；但 409 这条路径必须让 UI 看到失败 ——
  // 静默成功会让面板宣称"已轮换、所有人需重连"，而令牌其实没动（用户以为旧链接失效了，其实没有）。
  await withHarness(
    async (harness) => {
      const port = await pickFreePort();
      await harness.call(WEB_SERVICE_CHANNELS.start, { scope: "loopback", port });
      await assert.rejects(
        () => harness.call(WEB_SERVICE_CHANNELS.rotateToken),
        /rotate token failed \(HTTP 409\)/,
        "必须上抛且带上状态码，便于归因",
      );
    },
    { rotateStatus: 409 },
  );
});

test("★写动作走正确端点：撤销 → connections/revoke，轮换 → rotate-token", async () => {
  await withHarness(async (harness) => {
    const port = await pickFreePort();
    await harness.call(WEB_SERVICE_CHANNELS.start, { scope: "loopback", port });
    const token = await readTokenForTest(harness.tokenPath);

    await harness.call(WEB_SERVICE_CHANNELS.revokeConnection, { id: "conn-9" });
    const revoked = (await harness.call(WEB_SERVICE_CHANNELS.revokeConnection, {
      all: true,
    })) as { revoked: number };
    assert.equal(revoked.revoked, 2, "替身服务对 all:true 返回 2");
    const rotated = (await harness.call(WEB_SERVICE_CHANNELS.rotateToken)) as {
      rotatedAt: number;
    };
    assert.equal(rotated.rotatedAt, 1_700_000_000_000);

    const requests = await harness.requests();
    const revokeCalls = requests.filter(
      (entry) => entry.path === "/api/remote-control/connections/revoke",
    );
    assert.equal(revokeCalls.length, 2, "两次撤销各自打一次该端点");
    assert.ok(
      revokeCalls.every((entry) => entry.method === "POST"),
      "撤销必须是 POST（写动作）",
    );
    assert.deepEqual(
      revokeCalls.map((entry) => JSON.parse(entry.body ?? "{}")),
      [{ id: "conn-9" }, { all: true }],
      "载荷必须原样是 { id } 与 { all: true }（恰好其一）",
    );

    const rotateCalls = requests.filter(
      (entry) => entry.path === "/api/remote-control/rotate-token",
    );
    assert.equal(rotateCalls.length, 1, "轮换打一次 rotate-token");
    assert.equal(rotateCalls[0]?.method, "POST");

    // 鉴权口径：main 用 ?token= 而不是 Bearer（服务端只认 ?token= 与 cookie）。
    assert.ok(
      rotateCalls[0]?.query?.includes("token="),
      "main 必须用服务端认识的鉴权来源（?token=）",
    );
    assert.ok(token && rotateCalls[0]?.query?.includes(token), "查询串里带的应是真实令牌");
  });
});

test("畸形撤销载荷在 IPC 边界就被拒（不做就近猜一个的兜底）", async () => {
  await withHarness(async (harness) => {
    const port = await pickFreePort();
    await harness.call(WEB_SERVICE_CHANNELS.start, { scope: "loopback", port });
    for (const bad of [
      {},
      { id: "a", all: true },
      { id: 1 },
      { id: "" },
      { all: "true" },
      { all: false },
      null,
      "all",
    ]) {
      await assert.rejects(
        () => harness.call(WEB_SERVICE_CHANNELS.revokeConnection, bad),
        /invalid revoke payload/,
        "必须拒绝：" + JSON.stringify(bad),
      );
    }
    // 一个请求都不该发出去（拒绝发生在边界，不是打到服务端拿 400）。
    const requests = await harness.requests();
    assert.equal(
      requests.filter((entry) => entry.path?.includes("revoke")).length,
      0,
      "畸形载荷不得打到服务端",
    );
  });
});

test("畸形服务端响应 ⇒ 整份判成不知道（不给出半份清单）", async () => {
  await withHarness(
    async (harness) => {
      const port = await pickFreePort();
      await harness.call(WEB_SERVICE_CHANNELS.start, { scope: "loopback", port });
      const payload = await harness.call(WEB_SERVICE_CHANNELS.connections);
      assert.equal(payload, null, "一行缺字段 ⇒ 整份 null；丢掉坏行给出半份清单会让 UI 少报设备数");
    },
    {
      // 第二行缺 address：必须触发整份拒绝（而不是丢掉它、给出只剩 1 台的清单）。
      connectionsJson: JSON.stringify([
        {
          id: "ok-1",
          address: "10.0.0.5",
          role: "trusted-host",
          userAgent: "desktop",
          connectedAt: 1,
        },
        { id: "bad-2", userAgent: "x", connectedAt: 1, role: "terminal-client" },
      ]),
    },
  );
});

test("撤销失败要上抛（静默成功会让面板显示已断开而连接还在）", async () => {
  await withHarness(async (harness) => {
    // 服务没在跑 ⇒ 端点不可用 ⇒ 写动作必须抛错，不得返回 { revoked: 0 }。
    await assert.rejects(
      () => harness.call(WEB_SERVICE_CHANNELS.revokeConnection, { all: true }),
      /revoke connection failed/,
    );
    await assert.rejects(
      () => harness.call(WEB_SERVICE_CHANNELS.rotateToken),
      /rotate token failed/,
    );
  });
});
