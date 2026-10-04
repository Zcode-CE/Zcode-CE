/**
 * macOS 自动更新 darwin 跳过：接线层集成测试（electron 桩）。
 *
 * 钉的是 autoUpdater.ts 三个入口是否真的执行跳过 / 保持行为，而不只是判定函数对不对：
 * 1. initAutoUpdater：darwin 正式包（无 feed 覆盖）不发起 checkForUpdates（= 不发 HTTP 请求）、
 *    不注册更新相关 IPC；win/linux 正式包照常发起启动检查并注册 IPC；
 * 2. checkForUpdateMenuClick：darwin 正式包回传 { kind: "unsupported-platform" }；
 * 3. requestForceAutoUpdate：darwin 正式包复用 dev-skipped 通道回传原因，不发请求；
 * 4. 豁免路径不回退：darwin + 自建 feed、darwin + 开发态（ZCODE_AUTO_UPDATE_DEV）都照常检查。
 *
 * 为什么用桩而不是真实 electron：node:test 进程里无法 require 真实 electron
 * （其 main 导出是二进制路径字符串）。桩经 node:module register 的 resolve 钩子注入，
 * 只替换 electron / electron-updater 两个说明符；被测的 autoUpdater.ts /
 * manifestUpdateProvider.ts / logger.ts 全部是仓库真实源码（仅日志目录重定向到临时目录）。
 *
 * 运行：cd packages/desktop && node --import tsx --test test/autoUpdaterDarwinSkip.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
import test from "node:test";
import { PlatformChannels } from "@zcode/shared";

// 桩必须在 import 被测模块之前注册（ESM 先 link 后 evaluate）。
register(new URL("./support/stubResolver.mjs", import.meta.url));

// main/logger.ts 模块加载期就 mkdirSync 日志目录并清理过期日志；
// 重定向到临时目录避免污染真实用户配置目录，用后即清。
const logDir = await mkdtemp(join(tmpdir(), "zcode-autoupdate-"));
process.env.ZCODE_ENV = "test";
process.env.ZCODE_E2E_RUNTIME_LOG_DIR = logDir;

const { initAutoUpdater, checkForUpdateMenuClick, requestForceAutoUpdate } =
  await import("../src/main/autoUpdater.js");
const { stubApp, stubIpcMain } = await import("./support/electronStub.mjs");
const { stubAutoUpdater } = await import("./support/electronUpdaterStub.mjs");

test.after(async () => {
  await rm(logDir, { recursive: true, force: true });
});

interface SentMessage {
  channel: string;
  payload: unknown;
}

function createFakeWindow() {
  const sent: SentMessage[] = [];
  const window = {
    isDestroyed: () => false,
    webContents: {
      id: 42,
      send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
    },
  };
  return { window, sent };
}

function resetStubState(): void {
  stubApp.isPackaged = false;
  stubAutoUpdater.checkForUpdatesCalls = 0;
  stubAutoUpdater.feedConfigs = [];
  stubIpcMain.reset();
}

// 切到指定平台跑用例；process.platform 在 Node 里可写，用例结束恢复。
async function withPlatform(platform: string, body: () => Promise<void> | void): Promise<void> {
  const previous = process.platform;
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
    writable: true,
  });
  try {
    await body();
  } finally {
    Object.defineProperty(process, "platform", {
      value: previous,
      configurable: true,
      writable: true,
    });
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("darwin 正式包无 feed 覆盖：init 不发请求、不注册 IPC，手动检查回传 unsupported-platform", async () => {
  resetStubState();
  stubApp.isPackaged = true;
  await withPlatform("darwin", async () => {
    await initAutoUpdater({});
    assert.equal(
      stubAutoUpdater.checkForUpdatesCalls,
      0,
      "darwin 正式包不得发起 checkForUpdates（对 github provider 请求 latest-mac.yml 必然 404）",
    );
    assert.equal(stubIpcMain.handlers.size, 0, "跳过态不得注册任何更新 IPC handler");
    assert.equal(stubIpcMain.onListeners.size, 0, "跳过态不得注册任何更新 IPC listener");

    const { window, sent } = createFakeWindow();
    checkForUpdateMenuClick(window);
    assert.deepEqual(
      sent,
      [{ channel: PlatformChannels.UpdateCheckResult, payload: { kind: "unsupported-platform" } }],
      "手动检查必须回传 unsupported-platform，而不是把请求打到打不通的地址",
    );

    let forceState: unknown = undefined;
    requestForceAutoUpdate((state) => {
      forceState = state;
    });
    assert.deepEqual(forceState, {
      kind: "dev-skipped",
      message: "macOS 正式包暂不支持自动更新，请使用手动升级",
    });
    assert.equal(stubAutoUpdater.checkForUpdatesCalls, 0, "强更入口同样不得发请求");
  });
});

test("win/linux 正式包：init 照常发起启动检查并注册 IPC（既有行为不变）", async () => {
  for (const platform of ["linux", "win32"]) {
    resetStubState();
    stubApp.isPackaged = true;
    await withPlatform(platform, async () => {
      await initAutoUpdater({});
      // 启动检查的 promise 链（.catch/.finally 里才会清 inFlight）需要微任务刷新；
      // 不等待就点击会命中「检查已在进行中」分支，测不到手动检查真实发请求。
      await tick();
      assert.equal(stubAutoUpdater.checkForUpdatesCalls, 1, `${platform} 正式包必须保留启动检查`);
      assert.ok(
        stubIpcMain.handlers.has(PlatformChannels.DownloadUpdate),
        `${platform} 正式包必须注册下载更新 IPC`,
      );

      const { window, sent } = createFakeWindow();
      checkForUpdateMenuClick(window);
      await tick();
      assert.equal(
        stubAutoUpdater.checkForUpdatesCalls,
        2,
        `${platform} 手动检查必须真的发起 checkForUpdates`,
      );
      assert.deepEqual(
        sent,
        [],
        `${platform} 检查结果由 electron-updater 事件回传，桩不 emit 故为空`,
      );
    });
  }
});

test("豁免：darwin 正式包配了自建 feed ⇒ 跳过判定不生效，照常走 manifest provider 检查", async () => {
  resetStubState();
  stubApp.isPackaged = true;
  await withPlatform("darwin", async () => {
    await initAutoUpdater({ updateFeedSource: { url: "https://updates.example/feed" } });
    await tick();
    assert.equal(
      stubAutoUpdater.checkForUpdatesCalls,
      1,
      "自建 feed 路径保持原行为：照常发起更新检查",
    );
    assert.equal(stubAutoUpdater.feedConfigs.length, 1);
    const feedConfig = stubAutoUpdater.feedConfigs[0] as { manifestUrl?: string };
    assert.equal(feedConfig.manifestUrl, "https://updates.example/feed");

    const { window } = createFakeWindow();
    checkForUpdateMenuClick(window);
    await tick();
    assert.equal(stubAutoUpdater.checkForUpdatesCalls, 2, "自建 feed 下手动检查也走正常链路");
  });
});

test("豁免：darwin 未打包 + ZCODE_AUTO_UPDATE_DEV ⇒ 本地验证链路保持可用", async () => {
  resetStubState();
  stubApp.isPackaged = false;
  process.env.ZCODE_AUTO_UPDATE_DEV = "1";
  await withPlatform("darwin", async () => {
    await initAutoUpdater({});
    assert.equal(
      stubAutoUpdater.checkForUpdatesCalls,
      1,
      "开发态（未打包）不命中 darwin 跳过分支，启动检查照常",
    );
  });
  delete process.env.ZCODE_AUTO_UPDATE_DEV;
});

test("win/linux 注册的更新 IPC 与 HEAD 一致（4 个 handle + 1 个 on）", async () => {
  resetStubState();
  stubApp.isPackaged = true;
  await withPlatform("linux", async () => {
    await initAutoUpdater({});
    assert.deepEqual(
      [...stubIpcMain.handlers.keys()].sort(),
      [
        PlatformChannels.CancelUpdateDownload,
        PlatformChannels.DownloadUpdate,
        PlatformChannels.QuitAndInstallUpdate,
        PlatformChannels.SkipUpdateVersion,
      ].sort(),
    );
    assert.deepEqual([...stubIpcMain.onListeners.keys()], [PlatformChannels.QuitAndInstallUpdate]);
  });
});
