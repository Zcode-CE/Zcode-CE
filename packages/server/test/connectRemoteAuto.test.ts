import assert from "node:assert/strict";
import test from "node:test";
import type { IRemoteBackend } from "../src/remote/backend.js";
import type { RemoteConnection } from "../src/remote/connect.js";
import { connectRemoteAuto } from "../src/remote/connect-auto.js";
import { DaemonAdmissionError } from "../src/remote/daemon/transport.js";

/**
 * 传输分派：有可用 daemon 用 daemon，否则完全保持现有 stdio 链路（Lead 决策 #1）。
 *
 * 这里只测「分派逻辑」本身（注入 probe/daemon/stdio 三个实现），真实的 SSHD→daemon
 * 链路在 daemonTransport.test.ts 用回环假 daemon 覆盖。
 */

function stdioConnection(): RemoteConnection {
  return {
    services: {} as RemoteConnection["services"],
    client: {} as RemoteConnection["client"],
    dispose: () => undefined,
    disposeAndWait: async () => undefined,
  };
}

function backend(supportsChannel: boolean): IRemoteBackend {
  const created: IRemoteBackend = {
    detect: async () => ({ platform: "linux", arch: "x64" }),
    upload: async () => undefined,
    exists: async () => false,
    readFile: async () => "",
    dispose: () => undefined,
    exec: async () => {
      throw new Error("not used");
    },
  };
  if (supportsChannel) {
    created.openTcpipChannel = async () => {
      throw new Error("not used");
    };
  }
  return created;
}

test("没有 direct-tcpip 能力 ⇒ 直接 stdio，且不探测 daemon", async () => {
  let probed = false;
  const connection = await connectRemoteAuto(backend(false), {
    connectStdio: async () => stdioConnection(),
    probeDaemon: async () => {
      probed = true;
      throw new Error("probe must not run");
    },
  });
  assert.equal(probed, false, "WSL/Docker 不该浪费一次远端探测");
  assert.equal(connection.transport, "stdio");
  assert.match(connection.daemonFallbackReason ?? "", /direct-tcpip/u);
});

test("daemonTransport: disabled ⇒ 立即 stdio（回滚开关）", async () => {
  let probed = false;
  const connection = await connectRemoteAuto(backend(true), {
    daemonTransport: "disabled",
    connectStdio: async () => stdioConnection(),
    probeDaemon: async () => {
      probed = true;
      return { kind: "unsupported", reason: "x" };
    },
  });
  assert.equal(probed, false);
  assert.equal(connection.transport, "stdio");
  assert.match(connection.daemonFallbackReason ?? "", /disabled/u);
});

test("未安装 daemon ⇒ stdio，并把「装上可得常驻会话」作为回退原因", async () => {
  let daemonConnectCalls = 0;
  const connection = await connectRemoteAuto(backend(true), {
    connectStdio: async () => stdioConnection(),
    probeDaemon: async () => ({
      kind: "not-installed",
      serverRoot: "$HOME/.zcode/server",
      coreLogPath: "$HOME/.zcode/server/run/core.log",
    }),
    connectDaemon: async () => {
      daemonConnectCalls += 1;
      throw new Error("must not connect");
    },
  });
  assert.equal(daemonConnectCalls, 0, "未安装时不该尝试连接 daemon");
  assert.equal(connection.transport, "stdio");
  assert.match(connection.daemonFallbackReason ?? "", /常驻会话/u);
  assert.equal(connection.daemonFallbackCode, "daemon-not-installed");
});

test("daemon ready ⇒ 用 daemon 传输，不碰 stdio", async () => {
  let stdioCalls = 0;
  const connection = await connectRemoteAuto(backend(true), {
    connectStdio: async () => {
      stdioCalls += 1;
      return stdioConnection();
    },
    probeDaemon: async () => ({
      kind: "ready",
      bin: "zcode-server",
      serverRoot: "$HOME/.zcode/server",
      status: { state: "ready", installed: true, host: "127.0.0.1", port: 1 },
    }),
    connectDaemon: async () => ({
      available: true,
      connection: { ...stdioConnection(), transport: "daemon", serverId: "srv-1" },
    }),
  });
  assert.equal(stdioCalls, 0, "既然 daemon 可用，就不该再起 stdio 进程");
  assert.equal(connection.transport, "daemon");
  assert.equal(connection.serverId, "srv-1");
});

test("daemon 连接失败（取票/升级等）⇒ 回退 stdio 且保留原因", async () => {
  const connection = await connectRemoteAuto(backend(true), {
    connectStdio: async () => stdioConnection(),
    probeDaemon: async () => ({
      kind: "ready",
      bin: "zcode-server",
      serverRoot: "$HOME/.zcode/server",
      status: { state: "ready", installed: true, host: "127.0.0.1", port: 1 },
    }),
    connectDaemon: async () => {
      throw new Error("取 host capability 失败");
    },
  });
  assert.equal(connection.transport, "stdio");
  assert.match(connection.daemonFallbackReason ?? "", /host capability/u);
});

test("旧版 daemon（准入版本不一致）⇒ 回退 stdio，原因码 daemon-incompatible", async () => {
  let stdioCalls = 0;
  const connection = await connectRemoteAuto(backend(true), {
    connectStdio: async () => {
      stdioCalls += 1;
      return stdioConnection();
    },
    probeDaemon: async () => ({
      kind: "ready",
      bin: "zcode-server",
      serverRoot: "$HOME/.zcode/server",
      status: { state: "ready", installed: true, host: "127.0.0.1", port: 1 },
    }),
    connectDaemon: async () => {
      throw new DaemonAdmissionError("桌面与远端 daemon 的协议版本不一致：桌面期望 1，远端为 2");
    },
  });
  assert.equal(stdioCalls, 1, "旧版 daemon 不该让工作区变成不可用：必须回退 stdio");
  assert.equal(connection.transport, "stdio");
  assert.equal(connection.daemonFallbackCode, "daemon-incompatible");
  assert.match(
    connection.daemonFallbackReason ?? "",
    /协议版本不一致/u,
    "版本差异要写进 reason 供 UI 展示（不解析字符串出文案，但原因必须在）",
  );
});

test("daemon 起不来 ⇒ 回退 stdio，原因码 daemon-start-failed", async () => {
  const connection = await connectRemoteAuto(backend(true), {
    connectStdio: async () => stdioConnection(),
    probeDaemon: async () => ({
      kind: "stopped",
      bin: "zcode-server",
      serverRoot: "$HOME/.zcode/server",
      coreLogPath: "$HOME/.zcode/server/run/core.log",
    }),
    connectDaemon: async () => ({
      available: false,
      kind: "start-failed",
      reason: "serve --daemon exited 1",
    }),
  });
  assert.equal(connection.transport, "stdio");
  assert.equal(connection.daemonFallbackCode, "daemon-start-failed");
});
