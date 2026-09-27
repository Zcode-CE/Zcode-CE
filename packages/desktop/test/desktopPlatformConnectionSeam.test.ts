import assert from "node:assert/strict";
import test from "node:test";
import { resolveRemoteControlConnectionsSource } from "../../ui/src/remoteControlConnectionsSource.js";

/**
 * 接缝的端到端验收：真实 desktopPlatform → 真实 UI 能力探测。
 *
 * 为什么这一条必须有（task-84 §2 记过的形态）：
 * "preload 暴露了、但 desktopPlatform 没映射进 IPlatformService" 会让 UI 的能力探测
 * 判成"能力缺失" ⇒ 面板整块不渲染且无报错。单看任一侧都是绿的，只有把两侧接起来才验得到。
 *
 * 这里不 mock 探测函数，而是真的造一个 window.zcode 再跑真实的 createDesktopPlatform，
 * 把它的输出喂给真实 的 resolveRemoteControlConnectionsSource（UI 侧唯一的探测入口）。
 *
 * 为什么要动态 import：desktopBrowserPlatformBridge 在模块加载时就读 window.zcode
 * （见它第 34 行的条件定义），所以必须先把假 window 装好再 import。
 * createDesktopPlatform 则在每次调用时读 window，所以同一个模块可以逐档换 window 重跑。
 *
 * 运行：cd packages/desktop && node --import tsx --test test/desktopPlatformConnectionSeam.test.ts
 */

const FAKE_ZCODE_BASE: Record<string, unknown> = {
  selectDirectory: async () => null,
  selectFile: async () => null,
  selectFiles: async () => [],
  createTempTextAttachment: async () => ({ ok: true, path: "/tmp/x" }),
  getWebServiceStatus: async () => ({ state: "stopped", adopted: false, loopback: true }),
  startWebService: async () => ({ state: "stopped", adopted: false, loopback: true }),
  stopWebService: async () => ({ state: "stopped", adopted: false, loopback: true }),
  getWebServiceConnectionInfo: async () => null,
  onWebServiceChanged: () => () => {},
  onRemoteConnectionLog: () => () => {},
  onRemoteSessionClosed: () => () => {},
  connectRemote: async () => ({ success: true }),
  disposeRemoteSession: async () => {},
  isDockerAvailable: async () => false,
  listWSLDistros: async () => [],
  listDockerContainers: async () => [],
  listSSHConfigAliases: async () => [],
  loadMcpFromUserDirectory: async () => ({ success: true }),
  saveMcpToUserDirectory: async () => ({ success: true }),
  migrateLegacyCommonMcp: async () => ({ success: true }),
  openExternal: async () => {},
  executeDesktopCommand: async () => undefined,
  canOpenCommunity: async () => false,
  openInFileManager: async () => ({ success: true }),
  openExternalFile: async () => ({ success: true }),
  registerOAuthState: () => {},
  onOAuthCallback: () => () => {},
  onPaymentCallback: () => () => {},
  notifyRendererReady: () => {},
  showTaskNotification: () => {},
  syncWindowTabs: () => {},
  syncWindowUnreadCount: () => {},
  syncActiveTaskSession: () => {},
  onFocusTab: () => () => {},
  onNewTab: () => () => {},
  onNewTask: () => () => {},
  onOpenWorkspace: () => () => {},
  onOpenWorkspacePath: () => () => {},
  onOpenFeedbackDialog: () => () => {},
  onOpenTicketsPanel: () => () => {},
  onWindowFullscreenChanged: () => () => {},
  onTaskNotificationClick: () => () => {},
  exportLogs: async () => ({ success: true }),
  onUpdateReady: () => () => {},
  onUpdateCheckResult: () => () => {},
  onPostUpdateReleaseNotes: () => () => {},
  acknowledgePostUpdateReleaseNotes: async () => {},
  quitAndInstallUpdate: async () => {},
  getInstalledEditors: async () => [],
  openInEditor: async () => ({ success: true }),
  setApplicationLocale: async () => {},
  setTitleBarTheme: () => {},
  getWindowControlsOverlayMetrics: () => null,
};

/** 装一个假 window；返回后 createDesktopPlatform 会按当前 window 重新取值。 */
function installWindowZcode(extra: Record<string, unknown>): void {
  const globals = globalThis as unknown as { window?: unknown };
  globals.window = {
    zcode: { ...FAKE_ZCODE_BASE, ...extra },
    addEventListener: () => {},
    navigator: { language: "zh-CN" },
  };
}

// 桥模块在 import 时读 window：先装一份完整的，避免加载期就崩。
installWindowZcode({});
const { createDesktopPlatform } = await import("../src/renderer/src/desktopPlatform.js");

const CONNECTIONS = [
  {
    id: "conn-1",
    address: "192.168.1.20",
    role: "terminal-client",
    userAgent: "Mozilla/5.0 (iPhone)",
    connectedAt: 1_700_000_000_000,
  },
];

test("★正向：preload 有连接面 ⇒ 真实 desktopPlatform 上能力探测全部命中", () => {
  installWindowZcode({
    getWebServiceConnections: async () => ({ connections: CONNECTIONS, revision: 3 }),
    revokeWebServiceConnection: async () => ({ revoked: 1 }),
    rotateWebServiceToken: async () => ({ rotatedAt: 1 }),
  });
  const platform = createDesktopPlatform({ isLocalDevelopmentRuntime: false });
  const source = resolveRemoteControlConnectionsSource(platform);
  assert.equal(typeof source.read, "function", "设备清单能力必须命中");
  assert.equal(typeof source.revoke, "function", "断开能力必须命中");
  assert.equal(typeof source.rotateToken, "function", "轮换能力必须命中（桌面专属）");
});

test("★反向验证：preload 缺连接面 ⇒ UI 能力探测必须判成缺失（三个区块都不渲染）", () => {
  // 这条就是 task-84 §2 那个静默失效形态的反向：
  // 若 desktopPlatform 无条件转发（写成 () => window.zcode.getWebServiceConnections()），
  // 那么 window.zcode 上即使没有这个方法，IPlatformService 上也会永远有，
  // 探测恒判成"有能力" ⇒ 面板渲染出来、点一下才抛 TypeError。
  // 用条件定义后，缺失如实反映成 undefined，UI 判成能力缺失 ⇒ 对应区块不渲染。
  installWindowZcode({});
  const platform = createDesktopPlatform({ isLocalDevelopmentRuntime: false });
  const source = resolveRemoteControlConnectionsSource(platform);
  assert.equal(source.read, undefined, "preload 没有 ⇒ 设备清单能力必须缺失");
  assert.equal(source.revoke, undefined, "preload 没有 ⇒ 断开能力必须缺失");
  assert.equal(source.rotateToken, undefined, "preload 没有 ⇒ 轮换能力必须缺失");
  // 分档：服务面仍然在（连接面缺失不得连累服务面，否则整个面板消失）。
  assert.equal(typeof platform.getWebServiceStatus, "function", "服务面必须不受影响");
  assert.equal(typeof platform.getWebServiceConnectionInfo, "function");
});

test("★分档验证：只缺 rotateToken ⇒ 只有轮换入口不出现，读与断开仍在", () => {
  // 三个方法分档探测的可断言形式：合成一档的话，这里会三项全失。
  installWindowZcode({
    getWebServiceConnections: async () => ({ connections: [], revision: 0 }),
    revokeWebServiceConnection: async () => ({ revoked: 0 }),
    // 刻意不提供 rotateWebServiceToken（模拟 Web 形态：面板只显示连接面）。
  });
  const platform = createDesktopPlatform({ isLocalDevelopmentRuntime: false });
  const source = resolveRemoteControlConnectionsSource(platform);
  assert.equal(typeof source.read, "function", "读能力不受轮换缺失影响");
  assert.equal(typeof source.revoke, "function", "断开能力不受轮换缺失影响");
  assert.equal(source.rotateToken, undefined, "轮换入口必须不出现（决策④：Web 不暴露）");
});

test("★载荷穿透：UI 探测到的 read 真的把 desktopPlatform 的返回值原样带出", async () => {
  installWindowZcode({
    getWebServiceConnections: async () => ({ connections: CONNECTIONS, revision: 3 }),
    revokeWebServiceConnection: async () => ({ revoked: 1 }),
    rotateWebServiceToken: async () => ({ rotatedAt: 1 }),
  });
  const platform = createDesktopPlatform({ isLocalDevelopmentRuntime: false });
  const source = resolveRemoteControlConnectionsSource(platform);
  const payload = (await source.read?.()) as { connections: unknown[]; revision: number };
  assert.deepEqual(payload, { connections: CONNECTIONS, revision: 3 });
  // 断开与轮换的返回值被 UI 层刻意吞掉（真相源在服务端，结算后一律重拉清单）。
  await source.revoke?.({ all: true });
  await source.rotateToken?.();
});
