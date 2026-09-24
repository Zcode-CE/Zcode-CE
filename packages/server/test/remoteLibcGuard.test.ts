import assert from "node:assert/strict";
import test from "node:test";
import type { IRemoteBackend, RemoteEnvironment } from "../src/remote/backend.js";
import { connectRemote } from "../src/remote/connect.js";
import { assertSupportedRemoteLibc, probeRemoteLibc } from "../src/remote/remoteLibcSupport.js";

/**
 * 只实现 libc 判定 + "到底有没有真的发起部署/启动"需要的那部分接口；
 * `upload`/`exec` 一旦被调用就记数 —— 用来钉住"拦截发生在部署之前"这条契约。
 */
function createProbeBackend(options: { env: RemoteEnvironment; paths: string[] }) {
  const uploadCalls: string[] = [];
  const execCommands: string[] = [];
  const backend: IRemoteBackend = {
    detect: async () => options.env,
    upload: async (_localPath, remotePath) => {
      uploadCalls.push(remotePath);
    },
    exec: async (command) => {
      execCommands.push(command);
      throw new Error("libc 判定通过前不允许启动远端 server");
    },
    exists: async (remotePath) => options.paths.includes(remotePath),
    readFile: async () => {
      throw new Error("libc 判定不该读文件内容");
    },
    dispose: () => undefined,
  };
  return { backend, uploadCalls, execCommands };
}

const X64: RemoteEnvironment = { platform: "linux", arch: "x64" };

test("远端是 musl（loader 证据）：连接前拦断，且不部署、不启动", async () => {
  const fake = createProbeBackend({ env: X64, paths: ["/lib/ld-musl-x86_64.so.1"] });
  await assert.rejects(
    () => connectRemote(fake.backend),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /musl libc/u, "必须给出判定");
      assert.match(message, /段错误|exit 139/u, "必须说清失败模式是段错误");
      assert.match(message, /部署资产之前/u, "必须说明拦截时机");
      assert.match(message, /glibc 发行版/u, "必须给可操作修法");
      assert.match(message, /remote-workspace\.md/u, "必须指向文档");
      return true;
    },
  );
  assert.deepEqual(fake.uploadCalls, [], "musl 判定后不允许再上传任何资产");
  assert.deepEqual(fake.execCommands, [], "musl 判定后不允许启动远端 server");
});

test("远端是 musl（只有 Alpine 发行版标记）：同样拦断", async () => {
  const fake = createProbeBackend({ env: X64, paths: ["/etc/alpine-release"] });
  await assert.rejects(() => connectRemote(fake.backend), /musl libc/u);
  assert.deepEqual(fake.execCommands, []);
});

test("glibc 远端：放行（不误伤）", async () => {
  const fake = createProbeBackend({ env: X64, paths: ["/lib64/ld-linux-x86-64.so.2"] });
  const probe = await probeRemoteLibc(fake.backend, X64);
  assert.equal(probe.libc, "glibc");
  await assertSupportedRemoteLibc(fake.backend, X64);
});

test("glibc 远端（arm64 的 loader 路径不同）：仍然放行", async () => {
  const env: RemoteEnvironment = { platform: "linux", arch: "arm64" };
  const fake = createProbeBackend({ env, paths: ["/lib/ld-linux-aarch64.so.1"] });
  assert.equal((await probeRemoteLibc(fake.backend, env)).libc, "glibc");
});

test("判据不足：fail-open 放行，但必须留痕（不静默）", async () => {
  const logs: unknown[][] = [];
  const fake = createProbeBackend({ env: X64, paths: [] });
  await assertSupportedRemoteLibc(fake.backend, X64, (...args) => logs.push(args));
  assert.equal(logs.length, 1, "放行必须留日志");
  assert.match(String(logs[0][0]), /无法判定/u);
});

test("探测本身失败：不当作『不存在』，仍然 fail-open 且留痕", async () => {
  const logs: unknown[][] = [];
  const backend: IRemoteBackend = {
    detect: async () => X64,
    upload: async () => undefined,
    exec: async () => {
      throw new Error("不该执行命令");
    },
    exists: async () => {
      throw new Error("连接抖动");
    },
    readFile: async () => "",
    dispose: () => undefined,
  };
  const probe = await probeRemoteLibc(backend, X64, (...args) => logs.push(args));
  assert.equal(probe.libc, "unknown");
  assert.match(probe.evidence.join("；"), /探测失败：连接抖动/u);
  assert.ok(logs.length >= 1, "探测失败必须留痕");
});

test("非 Linux 远端（darwin）：不做 libc 判定，不误伤", async () => {
  const env: RemoteEnvironment = { platform: "darwin", arch: "arm64" };
  const fake = createProbeBackend({ env, paths: [] });
  const probe = await probeRemoteLibc(fake.backend, env);
  assert.equal(probe.libc, "unknown");
  await assertSupportedRemoteLibc(fake.backend, env);
});
