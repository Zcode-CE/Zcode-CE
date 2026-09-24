import { PlatformChannels } from "@zcode/shared";
import type { WebServiceController, WebServiceStatus } from "./service.js";

/**
 * 五条 IPC 通道（契约 §5）：四条 `handle` + 一条广播。
 *
 * 安全不变式：**令牌只经 `connectionInfo` 的 `linkWithToken` 交给渲染进程**；
 * `status` 与 `changed` 的载荷一律是 `WebServiceStatus`，**不含令牌**（本文件的广播路径只拿 `controller.status()`）。
 */
/**
 * 通道名**从 `@zcode/shared` 取，不在本文件重写字符串**。
 *
 * 原因：preload 必须订阅**完全相同**的字符串。两处各写一份的话，改一处忘一处会让
 * 渲染进程永远收不到广播 —— 而且**静默**（没有报错，只是"状态不更新"），
 * 这类漂移只能靠人工比对发现。集中到 shared 后，两处共用同一个常量。
 */
export const WEB_SERVICE_CHANNELS = {
  status: PlatformChannels.WebServiceStatus,
  start: PlatformChannels.WebServiceStart,
  stop: PlatformChannels.WebServiceStop,
  connectionInfo: PlatformChannels.WebServiceConnectionInfo,
  changed: PlatformChannels.WebServiceChanged,
} as const;

/**
 * 只用到 `handle`，便于测试注入假 ipcMain（也避免本模块依赖 electron）。
 * 用**方法简写**声明：TS 对方法参数是双变的，这样 Electron 的 `IpcMain` 可以直接结构化赋值，
 * 不需要在接线处写 `as` 断言。
 */
export interface WebServiceIpcMainLike {
  handle(channel: string, listener: (...args: unknown[]) => unknown): void;
}

export interface WebServiceIpcDeps {
  ipcMain: WebServiceIpcMainLike;
  controller: WebServiceController;
  /** 主进程→渲染进程的广播出口（生产实现：所有窗口的 `webContents.send`）。 */
  broadcast: (channel: string, payload: WebServiceStatus) => void;
  onError?: (error: unknown, channel: string) => void;
}

/**
 * 判定"探活结论是否变了"的稳定子集：state 或对外暴露的端点变了才广播，避免每次都刷 UI。
 *
 * `staleReason` 必须在里面：它变了而 state 仍是 `stopped`（例如 `pid-dead` → `port-closed`）
 * 时结论**确实变了**，不进指纹就会漏推，面板会停在上一个原因上。
 */
function statusFingerprint(status: WebServiceStatus): string {
  return JSON.stringify([
    status.state,
    status.adopted,
    status.loopback,
    status.host,
    status.port,
    status.staleReason,
  ]);
}

export function registerWebServiceIpc(deps: WebServiceIpcDeps): void {
  let lastFingerprint: string | undefined;

  const report = (error: unknown, channel: string) => {
    deps.onError?.(error, channel);
  };

  /** 广播**只**以 `controller.status()` 为载荷来源 ⇒ 结构上不可能带上令牌。 */
  const broadcastStatus = async (): Promise<WebServiceStatus> => {
    const status = await deps.controller.status();
    lastFingerprint = statusFingerprint(status);
    deps.broadcast(WEB_SERVICE_CHANNELS.changed, status);
    return status;
  };

  /** 读状态：结论变了（state/端点变化）才广播，一次变化只推一次。 */
  const readStatusAndBroadcastIfChanged = async (): Promise<WebServiceStatus> => {
    const status = await deps.controller.status();
    const fingerprint = statusFingerprint(status);
    if (fingerprint !== lastFingerprint) {
      lastFingerprint = fingerprint;
      deps.broadcast(WEB_SERVICE_CHANNELS.changed, status);
    }
    return status;
  };

  deps.ipcMain.handle(WEB_SERVICE_CHANNELS.status, () => readStatusAndBroadcastIfChanged());

  deps.ipcMain.handle(WEB_SERVICE_CHANNELS.start, async (_event, options?: unknown) => {
    try {
      await deps.controller.start((options ?? {}) as { scope?: "loopback" | "lan"; port?: number });
    } catch (error) {
      report(error, WEB_SERVICE_CHANNELS.start);
      // 启动失败也要让面板看到真实状态（failed/stopped），否则 UI 会停在"启动中"。
      return await broadcastStatus();
    }
    return await broadcastStatus();
  });

  deps.ipcMain.handle(WEB_SERVICE_CHANNELS.stop, async () => {
    try {
      await deps.controller.stop();
    } catch (error) {
      report(error, WEB_SERVICE_CHANNELS.stop);
      return await broadcastStatus();
    }
    return await broadcastStatus();
  });

  deps.ipcMain.handle(WEB_SERVICE_CHANNELS.connectionInfo, () => deps.controller.connectionInfo());
}
