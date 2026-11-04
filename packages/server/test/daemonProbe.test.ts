import assert from "node:assert/strict";
import test from "node:test";
import { Readable, Writable } from "node:stream";
import { Emitter } from "@zcode/rpc";
import type { IRemoteBackend, StdioStream } from "../src/remote/backend.js";
import {
  classifyDaemonStatus,
  describeDaemonProbeOutcome,
  parseDaemonStatusJson,
  probeDaemonServer,
  resolveDaemonServerCandidates,
  resolveDaemonServerRoot,
} from "../src/remote/daemon/probe.js";
import { startRemoteDaemon } from "../src/remote/daemon/start.js";

/**
 * 常驻 daemon 的探测三态与降级判据（Lead 决策 #1/#2 + port-cli 的 status schema）。
 *
 * 钉住四件事：
 *   1. 候选顺序固定为 ZCODE_SERVER_BIN → ~/.zcode/server/bin/zcode-server → PATH；
 *   2. 三态只从 `status --json` 的 JSON 字段判断（该命令一律退出码 0，退出码不能当判据）；
 *   3. 未安装 / unusable 都返回可读原因 + core log 路径 ⇒ 调用方回退 stdio（现有链路零变化）；
 *   4. 拉起 daemon 必须带 ZCODE_SERVER_SKIP_SERVICE_REGISTRATION=1（裸 SSH 服务注册不可用）。
 */

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

function fakeBackend(handlers: {
  exec: (command: string) => StdioStream | Promise<StdioStream>;
  supportsChannel?: boolean;
}): IRemoteBackend {
  const backend: IRemoteBackend = {
    detect: async () => ({ platform: "linux", arch: "x64" }),
    upload: async () => undefined,
    exists: async () => false,
    readFile: async () => "",
    dispose: () => undefined,
    exec: async (command: string) => await handlers.exec(command),
  };
  if (handlers.supportsChannel !== false) {
    backend.openTcpipChannel = async () => {
      throw new Error("fake backend: channel not used in probe tests");
    };
  }
  return backend;
}

const STATUS_READY =
  '{"state":"ready","installed":true,"pid":42,"port":42545,"host":"127.0.0.1","generation":3,"version":"3.17.2","protocolVersion":1}';
const STATUS_STOPPED = '{"state":"stopped","installed":true,"version":"3.17.2"}';
const STATUS_NOT_INSTALLED = '{"state":"stopped","installed":false}';
const STATUS_CRASHED =
  '{"state":"crashed","installed":true,"lastExitReason":"core exited code=1 signal=none (core log: /root/run/core.log)"}';

test("候选顺序：显式 env → 安装器默认路径 → PATH；server-root 有默认值", () => {
  assert.deepEqual(resolveDaemonServerCandidates({ env: {}, homeDir: "/home/u" }), [
    "/home/u/.zcode/server/bin/zcode-server",
    "zcode-server",
  ]);
  assert.deepEqual(
    resolveDaemonServerCandidates({
      env: { ZCODE_SERVER_BIN: "/opt/zs/bin/zcode-server" },
      homeDir: "/home/u/",
    }),
    ["/opt/zs/bin/zcode-server", "/home/u/.zcode/server/bin/zcode-server", "zcode-server"],
    "显式覆盖排第一，且 home 末尾斜杠不会产生双斜杠",
  );
  assert.equal(resolveDaemonServerRoot({}), "$HOME/.zcode/server");
  assert.equal(
    resolveDaemonServerRoot({ ZCODE_REMOTE_DAEMON_SERVER_ROOT: "/data/zs" }),
    "/data/zs",
  );
});

test("status --json 解析：容忍 banner，保留 version/protocolVersion/lastExitReason", () => {
  const ready = parseDaemonStatusJson("Welcome to host\r\n" + STATUS_READY + "\n");
  assert.equal(ready.ok, true);
  if (ready.ok) {
    assert.equal(ready.status.installed, true);
    assert.equal(ready.status.port, 42545);
    assert.equal(ready.status.generation, 3);
    assert.equal(ready.status.protocolVersion, 1);
  }
  const crashed = parseDaemonStatusJson(STATUS_CRASHED);
  assert.equal(crashed.ok, true);
  if (crashed.ok) assert.match(crashed.status.lastExitReason ?? "", /core log: /u);

  assert.equal(parseDaemonStatusJson("not json at all").ok, false);
  assert.equal(parseDaemonStatusJson("[1,2,3]").ok, false, "根节点不是对象必须拒绝");
  assert.equal(parseDaemonStatusJson('{"port":1}').ok, false, "没有 state 必须拒绝");
});

test("三态归类：ready / stopped / 其它一律不进 daemon", () => {
  const ready = parseDaemonStatusJson(STATUS_READY);
  assert.ok(ready.ok);
  if (ready.ok) {
    const classified = classifyDaemonStatus(ready.status);
    assert.equal(classified?.kind, "ready");
  }
  const stopped = parseDaemonStatusJson(STATUS_STOPPED);
  assert.ok(stopped.ok);
  if (stopped.ok) assert.equal(classifyDaemonStatus(stopped.status)?.kind, "stopped");

  const readyNoPort = parseDaemonStatusJson('{"state":"ready","installed":true}');
  assert.ok(readyNoPort.ok);
  if (readyNoPort.ok) {
    assert.equal(classifyDaemonStatus(readyNoPort.status), null, "ready 但没有端口不能进 daemon");
  }
});

test("无 direct-tcpip 能力（WSL/Docker）⇒ unsupported", async () => {
  const backend = fakeBackend({ supportsChannel: false, exec: () => fakeStdioStream("", 0) });
  const result = await probeDaemonServer(backend, { env: {}, homeDir: "/home/u" });
  assert.equal(result.kind, "unsupported");
  assert.match(describeDaemonProbeOutcome(result), /direct-tcpip/u);
});

test("installed:false ⇒ not-installed（带 core log 路径），可用于 UI 提示安装", async () => {
  const backend = fakeBackend({ exec: () => fakeStdioStream(STATUS_NOT_INSTALLED, 0) });
  const result = await probeDaemonServer(backend, { env: {}, homeDir: "/home/u" });
  assert.equal(result.kind, "not-installed");
  if (result.kind === "not-installed") {
    assert.equal(result.coreLogPath, "$HOME/.zcode/server/run/core.log");
  }
});

test("installed + stopped ⇒ stopped（可以现场拉起）", async () => {
  const backend = fakeBackend({ exec: () => fakeStdioStream(STATUS_STOPPED, 0) });
  const result = await probeDaemonServer(backend, { env: {}, homeDir: "/home/u" });
  assert.equal(result.kind, "stopped");
  if (result.kind === "stopped") {
    assert.equal(result.bin, "/home/u/.zcode/server/bin/zcode-server");
    assert.match(result.coreLogPath, /run\/core\.log$/u);
  }
});

test("ready ⇒ 直接用 status 报的端口；崩溃态 ⇒ unusable 并带 lastExitReason", async () => {
  const readyBackend = fakeBackend({ exec: () => fakeStdioStream(STATUS_READY, 0) });
  const ready = await probeDaemonServer(readyBackend, { env: {}, homeDir: "/home/u" });
  assert.equal(ready.kind, "ready");
  if (ready.kind === "ready") {
    assert.equal(ready.status.port, 42545);
    assert.equal(ready.status.generation, 3);
  }

  const crashedBackend = fakeBackend({ exec: () => fakeStdioStream(STATUS_CRASHED, 0) });
  const crashed = await probeDaemonServer(crashedBackend, { env: {}, homeDir: "/home/u" });
  assert.equal(crashed.kind, "unusable");
  if (crashed.kind === "unusable") {
    assert.match(crashed.reason, /core exited/u);
    assert.match(crashed.coreLogPath, /run\/core\.log$/u);
  }
});

test("第一个候选不存在时继续试下一个（退出码只用于「候选不可执行」）", async () => {
  const commands: string[] = [];
  const backend = fakeBackend({
    exec: (command) => {
      commands.push(command);
      if (command.includes("/home/u/.zcode/server/bin/zcode-server")) {
        return fakeStdioStream("", 127);
      }
      return fakeStdioStream(STATUS_READY, 0);
    },
  });
  const result = await probeDaemonServer(backend, { env: {}, homeDir: "/home/u" });
  assert.equal(result.kind, "ready");
  if (result.kind === "ready") assert.equal(result.bin, "zcode-server");
  assert.equal(commands.length, 2, "先试安装器默认路径（127），再试 PATH");
});

test("全部候选都不可执行 ⇒ not-installed 且原因里列出每个候选", async () => {
  const backend = fakeBackend({ exec: () => fakeStdioStream("", 127) });
  const result = await probeDaemonServer(backend, { env: {}, homeDir: "/home/u" });
  assert.equal(result.kind, "not-installed");
  if (result.kind === "not-installed") assert.match(result.reason ?? "", /127/u);
});

test("拉起 daemon：必须带 SKIP_SERVICE_REGISTRATION，并按 --server-root 起", async () => {
  const commands: string[] = [];
  const backend = fakeBackend({
    exec: (command) => {
      commands.push(command);
      return fakeStdioStream("ZCode Server ready at 127.0.0.1:42545", 0);
    },
  });
  const result = await startRemoteDaemon(backend, {
    bin: "/home/u/.zcode/server/bin/zcode-server",
    serverRoot: "$HOME/.zcode/server",
  });
  assert.equal(result.ok, true);
  assert.equal(commands.length, 1);
  assert.match(
    commands[0] ?? "",
    /ZCODE_SERVER_SKIP_SERVICE_REGISTRATION=1/u,
    "裸 SSH 上服务注册不可用，必须跳过",
  );
  assert.match(commands[0] ?? "", /serve --daemon --server-root/u);
  assert.match(commands[0] ?? "", /\$HOME/u, "server-root 里的 ~ 交给远端 shell 展开");
});

test("拉起失败：返回 stderr 摘要（不静默）", async () => {
  const backend = fakeBackend({ exec: () => fakeStdioStream("boom", 1) });
  const result = await startRemoteDaemon(backend, { bin: "zcode-server", serverRoot: "/root/zs" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /exited 1: boom/u);
});
