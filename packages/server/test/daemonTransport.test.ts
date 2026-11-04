import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { Duplex, Readable, Writable } from "node:stream";
import test from "node:test";
import { Emitter } from "@zcode/rpc";
import { WebSocketServer, type WebSocket } from "ws";
import type { IRemoteBackend, StdioStream } from "../src/remote/backend.js";
import { checkDaemonAdmission, evaluateDaemonAdmission } from "../src/remote/daemon/admission.js";
import { requestDaemonHostCapabilityTicket } from "../src/remote/daemon/hostCapability.js";
import { connectDaemonRemote } from "../src/remote/daemon/transport.js";
import { openDaemonHostWebSocket } from "../src/remote/daemon/websocket.js";

/**
 * daemon 传输：鉴权、准入、三态判据与断开语义（SPIKE §3、§4.4、§4.8）。
 *
 * 用回环上的假 daemon（真 http + 真 ws）而不是 mock 掉 HTTP：这条链的价值就在
 * 「HTTP 状态码 / 升级握手 / ticket 一次性」这些真实协议细节上，mock 掉等于什么都没测。
 * 通道用 net.connect 模拟 SSH direct-tcpip（真实实现是 ssh2 forwardOut，形状同为 Duplex）。
 *
 * 真机 SSH + 真 daemon 的 E2E 由 Lead 用自建 sshd 验证（本机起不了 sshd）。
 */

interface FakeDaemon {
  port: number;
  ticketIssueCount: () => number;
  acceptedUpgrades: () => number;
  close: () => Promise<void>;
}

async function startFakeDaemon(overrides?: {
  protocolVersion?: number;
  serverId?: string;
}): Promise<FakeDaemon> {
  const serverInfo = {
    protocolVersion: overrides?.protocolVersion ?? 1,
    serverId: overrides?.serverId ?? "srv-abc",
    version: "9.9.9-test",
  };
  const tickets = new Set<string>();
  const webSockets = new Set<WebSocket>();
  let issued = 0;
  let accepted = 0;
  const server = http.createServer((request, response) => {
    if (request.url === "/api/server-info") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(serverInfo));
      return;
    }
    if (request.url === "/api/rpc-host-capability" && request.method === "POST") {
      issued += 1;
      const capability = "ticket-" + issued;
      tickets.add(capability);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ capability, expiresAt: Date.now() + 30_000 }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const capability = request.headers["x-zcode-rpc-host-capability"];
    const ok = typeof capability === "string" && tickets.delete(capability);
    if (!ok) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    accepted += 1;
    wss.handleUpgrade(request, socket, head, (webSocket) => {
      webSockets.add(webSocket);
      webSocket.on("close", () => webSockets.delete(webSocket));
      webSocket.on("message", (data) => webSocket.send(data));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as net.AddressInfo;
  return {
    port: address.port,
    ticketIssueCount: () => issued,
    acceptedUpgrades: () => accepted,
    close: async () => {
      // upgraded 的 socket 已从 http server 摘除，closeAllConnections 管不到它们：
      // 不主动 terminate 会让 server.close() 永远等不到回调（测试挂死的直接原因）。
      for (const webSocket of webSockets) webSocket.terminate();
      webSockets.clear();
      wss.close();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * 把真 TCP socket 包成只有 Duplex 语义的通道：隐藏 setTimeout/setNoDelay/ref/address 等
 * net.Socket 方法，复现 ssh2 `forwardOut()` 返回的 Channel 形状。
 *
 * 这条用例的价值：真机 E2E 就是在第一跳 HTTP 崩在 `sock.setTimeout is not a function`——
 * 而普通回环 socket 有这些方法，测不出来。用 stripped Duplex 才能把 shim 的缺失钉成红灯。
 */
function stripSocketMethods(socket: net.Socket): Duplex {
  const duplex = new Duplex({
    read() {
      socket.resume();
    },
    write(chunk, _encoding, callback) {
      socket.write(chunk, callback);
    },
    final(callback) {
      socket.end();
      callback();
    },
    destroy(error, callback) {
      socket.destroy(error ?? undefined);
      callback(error);
    },
  });
  socket.on("data", (chunk) => duplex.push(chunk));
  socket.on("end", () => duplex.push(null));
  socket.on("error", (error) => duplex.destroy(error));
  socket.on("close", () => duplex.push(null));
  return duplex;
}

function fakeStdioStream(stdoutText: string, code: number): StdioStream {
  const onClose = new Emitter<number>();
  const stdout = Readable.from([Buffer.from(stdoutText, "utf-8")]);
  const stderr = Readable.from([Buffer.alloc(0)]);
  stdout.once("end", () => setImmediate(() => onClose.fire(code)));
  return {
    stdin: new Writable({ write: (_c, _e, cb) => cb() }),
    stdout,
    stderr,
    onClose: onClose.event,
  };
}

interface FakeBackendHandle {
  backend: IRemoteBackend;
  commands: string[];
  disposeCalled: () => boolean;
}

/** 状态可编程的假 backend：status 报什么由 started 决定，便于验证「stopped → 拉起 → 连上」。 */
function fakeDaemonBackend(options: {
  port: number;
  installed: boolean;
  initiallyRunning: boolean;
  /** "net" = 真 socket（有 Socket 方法）；"channel" = ssh2 Channel 形状（只有 Duplex）。 */
  channelKind?: "net" | "channel";
}): FakeBackendHandle {
  const commands: string[] = [];
  let running = options.initiallyRunning;
  let disposed = false;
  const statusJson = () =>
    JSON.stringify(
      options.installed
        ? running
          ? {
              state: "ready",
              installed: true,
              host: "127.0.0.1",
              port: options.port,
              pid: 4242,
              generation: 7,
            }
          : { state: "stopped", installed: true }
        : { state: "stopped", installed: false },
    );
  const backend: IRemoteBackend = {
    detect: async () => ({ platform: "linux", arch: "x64" }),
    upload: async () => undefined,
    exists: async () => false,
    readFile: async () => "",
    dispose: () => {
      disposed = true;
    },
    exec: async (command: string) => {
      commands.push(command);
      if (command.includes("serve --daemon")) {
        running = true;
        return fakeStdioStream("ZCode Server ready at 127.0.0.1:" + options.port, 0);
      }
      return fakeStdioStream(statusJson(), 0);
    },
    openTcpipChannel: async (destination) => {
      assert.equal(destination.host, "127.0.0.1", "daemon 只监听回环");
      assert.equal(destination.port, options.port, "端口必须来自 status --json");
      const channel = net.connect(options.port, "127.0.0.1");
      await new Promise<void>((resolve, reject) => {
        channel.once("connect", () => resolve());
        channel.once("error", reject);
      });
      return options.channelKind === "channel" ? stripSocketMethods(channel) : channel;
    },
  };
  return { backend, commands, disposeCalled: () => disposed };
}

test("准入判定：版本一致才放行；不一致/缺 serverId/缺版本一律拒绝", () => {
  const ok = evaluateDaemonAdmission({ protocolVersion: 1, serverId: "srv-1", version: "3.17" }, 1);
  assert.equal(ok.admitted, true);
  if (ok.admitted) assert.equal(ok.serverId, "srv-1");

  const mismatch = evaluateDaemonAdmission({ protocolVersion: 2, serverId: "srv-1" }, 1);
  assert.equal(mismatch.admitted, false);
  if (!mismatch.admitted) assert.match(mismatch.reason, /协议版本不一致/u);

  assert.equal(evaluateDaemonAdmission({ serverId: "srv-1" }, 1).admitted, false);
  const noId = evaluateDaemonAdmission({ protocolVersion: 1 }, 1);
  assert.equal(noId.admitted, false);
  if (!noId.admitted) assert.match(noId.reason, /serverId/u);
});

test("经通道的准入：真实 /api/server-info 往返", async () => {
  const daemon = await startFakeDaemon();
  try {
    const admitted = await checkDaemonAdmission({
      openChannel: async () => net.connect(daemon.port, "127.0.0.1"),
      expectedProtocolVersion: 1,
    });
    assert.equal(admitted.admitted, true);
    if (admitted.admitted) assert.equal(admitted.serverId, "srv-abc");
  } finally {
    await daemon.close();
  }
});

test("ticket 一次性且不缓存：两次取两张，重放必 401", async () => {
  const daemon = await startFakeDaemon();
  try {
    const openChannel = async () => net.connect(daemon.port, "127.0.0.1");
    const first = await requestDaemonHostCapabilityTicket({ openChannel });
    const second = await requestDaemonHostCapabilityTicket({ openChannel });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(daemon.ticketIssueCount(), 2, "每次调用都必须重新取票（禁止缓存复用）");
    if (first.ok && second.ok) {
      assert.notEqual(first.ticket.capability, second.ticket.capability);
    }
    if (!first.ok) return;

    const webSocket = await openDaemonHostWebSocket({
      openChannel,
      capability: first.ticket.capability,
    });
    webSocket.close();
    assert.equal(daemon.acceptedUpgrades(), 1);

    await assert.rejects(
      () => openDaemonHostWebSocket({ openChannel, capability: first.ticket.capability }),
      /401/u,
      "重放票据必须被拒绝（SPIKE §4.8 实测）",
    );
    assert.equal(daemon.acceptedUpgrades(), 1, "重放不得产生第二次升级");
  } finally {
    await daemon.close();
  }
});

test("ready ⇒ 直连：拿 serverId/generation，dispose 只断 WS 且不 dispose backend", async () => {
  const daemon = await startFakeDaemon();
  const handle = fakeDaemonBackend({ port: daemon.port, installed: true, initiallyRunning: true });
  try {
    const result = await connectDaemonRemote(handle.backend, {
      env: { ZCODE_SERVER_BIN: "/usr/local/bin/zcode-server" },
      homeDir: "/home/u",
    });
    assert.equal(result.available, true, "运行中的 daemon 必须直连");
    if (!result.available) return;
    assert.equal(result.connection.transport, "daemon");
    assert.equal(result.connection.serverId, "srv-abc");
    assert.equal(result.connection.daemon?.port, daemon.port);
    assert.equal(result.connection.daemon?.generation, 7, "generation 必须带出（daemon 重启判据）");
    assert.equal(
      handle.commands.filter((command) => command.includes("serve --daemon")).length,
      0,
      "已经在跑时不得再起一次",
    );

    await result.connection.disposeAndWait({ timeoutMs: 1_000 });
    assert.equal(
      handle.disposeCalled(),
      false,
      "daemon 传输不得 dispose backend（SSH 由窗口 registry 管理）",
    );
    const stillAlive = await checkDaemonAdmission({
      openChannel: async () => net.connect(daemon.port, "127.0.0.1"),
    });
    assert.equal(stillAlive.admitted, true, "客户端断开后 daemon 必须仍可用（常驻语义）");
  } finally {
    await daemon.close();
  }
});

test("installed + stopped ⇒ 用 skip-registration 拉起，拉完重新读端口再连", async () => {
  const daemon = await startFakeDaemon();
  const handle = fakeDaemonBackend({ port: daemon.port, installed: true, initiallyRunning: false });
  try {
    const result = await connectDaemonRemote(handle.backend, { env: {}, homeDir: "/home/u" });
    assert.equal(result.available, true);
    const startCommands = handle.commands.filter((command) => command.includes("serve --daemon"));
    assert.equal(startCommands.length, 1, "已安装未运行必须现场拉起一次");
    assert.match(startCommands[0] ?? "", /ZCODE_SERVER_SKIP_SERVICE_REGISTRATION=1/u);
    if (result.available) await result.connection.disposeAndWait({ timeoutMs: 1_000 });
  } finally {
    await daemon.close();
  }
});

test("installed:false ⇒ not-installed（回退 stdio 的判据，带 core log 路径）", async () => {
  const handle = fakeDaemonBackend({ port: 1, installed: false, initiallyRunning: false });
  const result = await connectDaemonRemote(handle.backend, { env: {}, homeDir: "/home/u" });
  assert.equal(result.available, false);
  if (!result.available) {
    assert.equal(result.kind, "not-installed");
    assert.match(result.coreLogPath ?? "", /run\/core\.log$/u);
  }
  assert.equal(
    handle.commands.filter((command) => command.includes("serve --daemon")).length,
    0,
    "未安装时不得尝试起 daemon（远端没有可执行文件）",
  );
});

test("ssh2 Channel 形状（无 net.Socket 方法）也能跑通完整链：shim 必须补齐 setTimeout 等", async () => {
  const daemon = await startFakeDaemon();
  const handle = fakeDaemonBackend({
    port: daemon.port,
    installed: true,
    initiallyRunning: true,
    channelKind: "channel",
  });
  try {
    const result = await connectDaemonRemote(handle.backend, { env: {}, homeDir: "/home/u" });
    assert.equal(
      result.available,
      true,
      "缺 net.Socket 方法的通道必须也能取 ticket 并升级 /ws/host（否则真机首跳必崩）",
    );
    if (result.available) {
      assert.equal(result.connection.transport, "daemon");
      await result.connection.disposeAndWait({ timeoutMs: 1_000 });
    }
  } finally {
    await daemon.close();
  }
});

test("协议版本不一致 ⇒ 返回 incompatible（交回 faltback 决策，不抛硬错）", async () => {
  const daemon = await startFakeDaemon({ protocolVersion: 2 });
  const handle = fakeDaemonBackend({ port: daemon.port, installed: true, initiallyRunning: true });
  try {
    const result = await connectDaemonRemote(handle.backend, { env: {}, homeDir: "/home/u" });
    assert.equal(result.available, false);
    if (!result.available) {
      assert.equal(result.kind, "incompatible");
      assert.match(result.reason, /协议版本不一致/u);
    }
  } finally {
    await daemon.close();
  }
});
