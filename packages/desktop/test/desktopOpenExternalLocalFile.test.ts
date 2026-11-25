/**
 * OpenExternal 对本地 file: URL 的路由(X5,移植上游 v3.15.1)。
 *
 * 钉住的契约:OpenExternal IPC 处理器在 URL 通过协议白名单后,必须把 file: 协议
 * 路由到 openFileUrlInDefaultApp(fileURLToPath → openPath),而不是 shell.openExternal ——
 * 后者对本地文件 URL 在多数平台失败或无效,导致「用默认应用打开本地文件」入口失败。
 *
 * 同一入口还要先确认可执行类文件（4.0.0 第二道防线）:取消时不调用 shell.openPath,
 * 确认后才交给系统;file: URL 与 OpenExternalFile 两条路径都走同一个确认器。
 *
 * 运行:cd packages/desktop && node --import tsx --test test/desktopOpenExternalLocalFile.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
import test from "node:test";
import { PlatformChannels } from "@zcode/shared";

register(new URL("./support/stubResolver.mjs", import.meta.url));

const { registerRemoteIpcHandlers } = await import("../src/main/desktopMainIpcRemote.js");
const { stubShell } = await import("./support/electronStub.mjs");

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function createStubOptions(confirmExecutableFileOpen = async () => true) {
  return {
    logger,
    confirmExecutableFileOpen,
    createRemoteWorkspaceSession: async () => "stub-session",
    disposeRemoteWorkspaceSession: () => undefined,
    cancelPendingRemoteWorkspaceSessionsForWindow: () => undefined,
    bindRemoteWorkspaceSessionContext: async () => undefined,
    confirmRendererAttachmentReady: () => undefined,
    isDockerDaemonAvailable: async () => false,
    listAvailableWSLDistros: async () => [],
    listAvailableDockerContainers: async () => [],
    listSSHConfigAliases: async () => [],
  };
}

test("file: URL 经 openFileUrlInDefaultApp 打开而不是 shell.openExternal", async () => {
  // 桩注入:直接从模块拿 ipcMain 命名导出后取监听器表。
  const { ipcMain } = await import("./support/electronStub.mjs");
  const listeners = /** @type {Map<string, Function>} */ (ipcMain.onListeners);
  const handler = listeners.get(PlatformChannels.OpenExternal);
  if (!handler) {
    // registerRemoteIpcHandlers 负责注册;未注册时先注册一次。
    registerRemoteIpcHandlers(createStubOptions());
  }
  const registered = /** @type {Function} */ (
    /** @type {Map<string, Function>} */ (ipcMain.onListeners).get(PlatformChannels.OpenExternal)
  );
  assert.ok(registered, "OpenExternal 监听器已注册");

  const tempDir = await mkdtemp(join(tmpdir(), "zcode-x5-"));
  const target = join(tempDir, "report.txt");
  await writeFile(target, "hello");
  stubShell.resetShellCalls();
  const event = {
    sender: { getURL: () => "https://app.zcode.dev/desktop", loadURL: undefined },
  };
  registered(event, { url: `file://${target}` });

  // openPathInDefaultApp 内含 realpath 真实异步 IO,轮询等它落定。
  const deadline = Date.now() + 2_000;
  while (stubShell.openPathCalls.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(stubShell.openExternalCalls.length, 0, "不得走 openExternal");
  assert.equal(stubShell.openPathCalls.length, 1, "应走 openPath");
  assert.equal(stubShell.openPathCalls[0], target);

  // http URL 行为不变:仍走 openExternal。
  stubShell.resetShellCalls();
  registered(event, { url: "https://example.com/page" });
  while (stubShell.openExternalCalls.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(stubShell.openExternalCalls.length, 1);
  assert.equal(stubShell.openPathCalls.length, 0);

  // 无效协议直接拒绝,两者都不调用。
  stubShell.resetShellCalls();
  registered(event, { url: "javascript:alert(1)" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(stubShell.openExternalCalls.length, 0);
  assert.equal(stubShell.openPathCalls.length, 0);

  await rm(tempDir, { recursive: true, force: true });
});

// 可执行类后缀取当前平台真正会命中的那个：测试机换成 macOS/Windows 时也走同一条确认分支。
const EXECUTABLE_SUFFIX =
  process.platform === "darwin" ? "terminal" : process.platform === "win32" ? "bat" : "sh";

test("默认打开可执行类文件：取消不执行，确认后才交给系统", async () => {
  const { ipcMain } = await import("./support/electronStub.mjs");
  const tempDir = await mkdtemp(join(tmpdir(), "zcode-x5-exec-"));
  const target = join(tempDir, `payload.${EXECUTABLE_SUFFIX}`);
  await writeFile(target, "#!/bin/sh\necho pwned\n");
  try {
    const confirmations: string[] = [];
    registerRemoteIpcHandlers(
      createStubOptions(async (path: string) => {
        confirmations.push(path);
        return false;
      }),
    );
    const cancelled = await /** @type {Function} */ (
      /** @type {Map<string, Function>} */ (ipcMain.handlers).get(PlatformChannels.OpenExternalFile)
    )({}, target);
    assert.deepEqual(cancelled, { success: true, cancelled: true }, "取消不是失败");
    assert.deepEqual(confirmations, [target], "确认器收到用户要点开的真实路径");
    assert.deepEqual(stubShell.openPathCalls, [], "取消后不得交给系统打开");

    registerRemoteIpcHandlers(createStubOptions(async () => true));
    stubShell.resetShellCalls();
    const opened = await /** @type {Function} */ (
      /** @type {Map<string, Function>} */ (ipcMain.handlers).get(PlatformChannels.OpenExternalFile)
    )({}, target);
    assert.deepEqual(opened, { success: true });
    assert.deepEqual(stubShell.openPathCalls, [target], "确认后才打开");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("file: URL 打开可执行类文件同样先确认", async () => {
  const { ipcMain } = await import("./support/electronStub.mjs");
  const tempDir = await mkdtemp(join(tmpdir(), "zcode-x5-exec-url-"));
  const target = join(tempDir, `payload.${EXECUTABLE_SUFFIX}`);
  await writeFile(target, "#!/bin/sh\necho pwned\n");
  try {
    const confirmations: string[] = [];
    registerRemoteIpcHandlers(
      createStubOptions(async (path: string) => {
        confirmations.push(path);
        return false;
      }),
    );
    const listener = /** @type {Function} */ (
      /** @type {Map<string, Function>} */ (ipcMain.onListeners).get(PlatformChannels.OpenExternal)
    );
    assert.ok(listener, "OpenExternal 监听器已注册");
    stubShell.resetShellCalls();
    listener(
      { sender: { getURL: () => "https://app.zcode.dev/desktop" } },
      { url: `file://${target}` },
    );

    const deadline = Date.now() + 2_000;
    while (confirmations.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // 给 fire-and-forget 链路留出落定时间：取消后仍不得出现 openPath 调用。
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(confirmations.length, 1);
    assert.deepEqual(stubShell.openPathCalls, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
