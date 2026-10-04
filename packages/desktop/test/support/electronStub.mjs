/**
 * electron 模块的测试桩（autoUpdaterDarwinSkip.test.ts 专用）。
 *
 * autoUpdater.ts 顶部静态导入 electron 的 app / BrowserWindow / ipcMain / Menu，
 * 在 node:test 里真实 electron 不可用（其 main 导出是二进制路径字符串，命名导入必然失败）。
 * 由 stubResolver.mjs 把 "electron" 说明符重定向到本文件后，这些导入全部落到桩上。
 *
 * 注意本文件必须是纯 JS（.mjs 由 Node 原生编译，不能含任何 TS 类型语法）。
 * 桩是"最小够用"的：只实现被测路径真正会调到的成员；断言用计数器暴露调用事实。
 */

export const stubApp = {
  isPackaged: false,
  getVersion: () => "3.14.3-ce.4",
};

export const stubBrowserWindow = {
  getAllWindows: () => [],
  getFocusedWindow: () => null,
};

export const stubIpcMain = {
  handlers: new Map(),
  onListeners: new Map(),
  handle(channel, listener) {
    this.handlers.set(channel, listener);
  },
  on(channel, listener) {
    this.onListeners.set(channel, listener);
  },
  reset() {
    this.handlers.clear();
    this.onListeners.clear();
  },
};

export const stubMenu = {
  getApplicationMenu: () => null,
};

// autoUpdater.ts 用的是命名导入（具名 import），因此桩必须同时导出这些名字，
// 而不是只给一个 default 对象。
export const app = stubApp;
export const BrowserWindow = stubBrowserWindow;
export const ipcMain = stubIpcMain;
export const Menu = stubMenu;

const electron = {
  app: stubApp,
  BrowserWindow: stubBrowserWindow,
  ipcMain: stubIpcMain,
  Menu: stubMenu,
};

export default electron;
