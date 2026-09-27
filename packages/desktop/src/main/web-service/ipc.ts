import { PlatformChannels } from "@zcode/shared";
import type { WebServiceConnectionPlane } from "./remoteControlClient.js";
import type { WebServiceController, WebServiceStatus } from "./service.js";

/**
 * 八条 IPC 通道（契约 §5）：七条 `handle` + 一条广播。
 *
 * 分两组：
 * - 服务面（进程/监听/端口/令牌）五条：status / start / stop / connectionInfo / changed；
 * - 连接面（谁连着）三条：connections（读）/ revokeConnection（写）/ rotateToken（写，桌面专属）。
 *
 * 安全不变式（两组都适用）：**令牌只经 `connectionInfo` 的 `linkWithToken` 交给渲染进程**；
 * 其余任何一条通道的载荷都不含令牌 ——
 * `status`/`changed` 的载荷一律是 `WebServiceStatus`（广播路径只拿 `controller.status()`）；
 * 连接面的载荷由 `remoteControlClient.ts` 逐字段重建（那一层是结构性保证：
 * 即使服务端将来多返回一个凭据字段，也漏不过来）。main 侧请求服务端时确实会带令牌，
 * 但那是进程内部行为，令牌不跨 IPC 边界。
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
  connections: PlatformChannels.WebServiceConnections,
  revokeConnection: PlatformChannels.WebServiceRevokeConnection,
  rotateToken: PlatformChannels.WebServiceRotateToken,
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
  /**
   * 连接面客户端（真的去调本机服务端）。
   *
   * 可选是刻意的：它让只关心服务面接线的既有测试与调用点不必被迫构造一个假的 HTTP 客户端。
   * 不传 ⇒ 只注册服务面五条通道，连接面三条不注册 ——
   * 渲染进程对未注册通道的 `invoke` 会 reject，而 preload/renderer 侧只会在
   * `IPlatformService` 上暴露它（生产接线处一定传，见 `main/index.ts`）。
   */
  connectionPlane?: WebServiceConnectionPlane;
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

  // ── 连接面（谁连着）三条 ────────────────────────────────────────────────────
  // 未注入 connectionPlane 时不注册（见 WebServiceIpcDeps 的说明）。
  const plane = deps.connectionPlane;
  if (plane) {
    /**
     * 读连接清单。不广播：连接数变化不是"探活结论"变化，
     * 且广播需要一个服务端的推送源（今天没有）—— UI 侧的取数时机是
     * "服务进入 running 时 / 打开面板时 / 每次撤销结算后"，不轮询。
     *
     * 返回 null（不知道）不报错：那是正常结论，不是失败。
     */
    deps.ipcMain.handle(WEB_SERVICE_CHANNELS.connections, () => plane.list());

    /**
     * 断开连接（写动作）。失败要上抛 —— 与 start/stop 的处理刻意不同：
     * start/stop 失败仍返回真实状态，因为"没起来"本身就是一个可展示的结论；
     * 而撤销失败没有任何状态可回显，静默成功会让面板显示"已断开"而连接还在。
     */
    deps.ipcMain.handle(WEB_SERVICE_CHANNELS.revokeConnection, async (_event, input?: unknown) => {
      const payload = parseRevokeInput(input);
      if (!payload) {
        // 畸形载荷直接拒绝，不做"就近猜一个"的兜底：猜错会让"断开全部"变成
        // "断开某一个"（或反之），两者后果差一个数量级。
        throw new Error("invalid revoke payload: expected { id } or { all: true }");
      }
      try {
        return await plane.revoke(payload);
      } catch (error) {
        report(error, WEB_SERVICE_CHANNELS.revokeConnection);
        throw error;
      }
    });

    /** 轮换令牌（写动作，桌面专属）。同样失败即上抛。 */
    deps.ipcMain.handle(WEB_SERVICE_CHANNELS.rotateToken, async () => {
      try {
        return await plane.rotateToken();
      } catch (error) {
        report(error, WEB_SERVICE_CHANNELS.rotateToken);
        throw error;
      }
    });
  }
}

/**
 * 校验撤销载荷：恰好 `{ id: string }` 或 `{ all: true }` 之一（spec §6.4）。
 *
 * 校验放在 IPC 边界而不是只靠服务端：跨进程载荷是不可信输入（渲染进程可被注入脚本），
 * 而服务端那条 400 会变成一次没有上下文的失败。这里先挡住，错误信息也更可操作。
 * 同时给或都不给、`id` 非字符串/空串、`all` 非字面 true —— 一律 null。
 */
function parseRevokeInput(input: unknown): { id: string } | { all: true } | null {
  if (typeof input !== "object" || input === null) return null;
  const candidate = input as { id?: unknown; all?: unknown };
  const hasId = candidate.id !== undefined;
  const hasAll = candidate.all !== undefined;
  if (hasId === hasAll) return null;
  if (hasId) {
    return typeof candidate.id === "string" && candidate.id.length > 0
      ? { id: candidate.id }
      : null;
  }
  return candidate.all === true ? { all: true } : null;
}
