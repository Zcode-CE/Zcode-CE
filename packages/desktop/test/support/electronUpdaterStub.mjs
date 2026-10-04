/**
 * electron-updater 模块的测试桩（autoUpdaterDarwinSkip.test.ts 专用）。
 *
 * 被测链路真实加载 packages/desktop/src/main/manifestUpdateProvider.ts（其静态导入
 * "electron-updater"），因此桩必须提供该模块在类定义期需要的值导出：
 * Provider（被 extends）、四个 *Updater（instanceof 用）、以及 autoUpdater.ts
 * 使用的默认导出 autoUpdater 实例与 CancellationToken。
 *
 * 注意本文件必须是纯 JS（.mjs 由 Node 原生编译，不能含任何 TS 类型语法）。
 * 桩的 autoUpdater 继承 EventEmitter：真实 init 会 .on("checking-for-update") 等，
 * 但桩从不主动 emit —— 被测断言只关心 checkForUpdates 是否被调用（发起请求的事实），
 * 不关心 electron-updater 内部事件流（那属于上游库的行为，不在本仓库测试范围内）。
 */
import { EventEmitter } from "node:events";

export class CancellationToken {
  constructor() {
    this.cancelled = false;
  }
  cancel() {
    this.cancelled = true;
  }
  dispose() {}
}

export class Provider {
  constructor(runtimeOptions) {
    this.runtimeOptions = runtimeOptions;
  }
}

export class AppImageUpdater {}
export class DebUpdater {}
export class RpmUpdater {}
export class PacmanUpdater {}

class StubAutoUpdater extends EventEmitter {
  constructor() {
    super();
    this.checkForUpdatesCalls = 0;
    this.feedConfigs = [];
    this.autoDownload = true;
    this.autoInstallOnAppQuit = true;
    this.logger = null;
  }

  checkForUpdates() {
    this.checkForUpdatesCalls += 1;
    return Promise.resolve(null);
  }

  setFeedURL(config) {
    this.feedConfigs.push(config);
  }

  quitAndInstall() {}

  async downloadUpdate(_token) {
    return Promise.resolve([]);
  }
}

export const stubAutoUpdater = new StubAutoUpdater();

const electronUpdater = {
  autoUpdater: stubAutoUpdater,
  CancellationToken,
  Provider,
  AppImageUpdater,
  DebUpdater,
  RpmUpdater,
  PacmanUpdater,
};

export default electronUpdater;
