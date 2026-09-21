/* eslint-disable max-lines -- 远程连接、OAuth 回调和通知 IPC 共用窗口级上下文，集中注册避免跨文件状态漂移。 */
import { app, BrowserWindow, ipcMain, shell } from "electron";
import {
  formatZodError,
  normalizeUnknownError,
  InternalChannels,
  isTrustedCodingPlanWebviewOrigin,
  resolveZaiBusinessBaseUrl,
  PlatformChannels,
  remoteTargetSchema,
  type RemoteTarget,
} from "@zcode/shared";
import { dispatchTaskNotification } from "./desktopNotifications.js";
import {
  clearOAuthRoutesForWindow,
  deliverPendingDeepLink,
  parseOAuthStateRegistration,
  registerOAuthState,
} from "./desktopOAuthDeepLink.js";
import { openPathInDefaultApp } from "./desktopMainIpcHelpers.js";

function isAllowedExternalOpenUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "file:";
  } catch {
    return false;
  }
}

interface OpenExternalRequest {
  sourceUrl?: string;
  url: string;
}

function parseOpenExternalRequest(payload: unknown): OpenExternalRequest | null {
  if (typeof payload === "string") {
    return { url: payload };
  }
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.url !== "string") {
    return null;
  }
  return {
    sourceUrl: typeof record.sourceUrl === "string" ? record.sourceUrl : undefined,
    url: record.url,
  };
}

function isPaypalHostname(hostname: string): boolean {
  return hostname === "paypal.com" || hostname.endsWith(".paypal.com");
}

function isCodingPlanPaypalNavigationUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    if (isPaypalHostname(parsed.hostname)) return true;
    return (
      ["https://api.z.ai", resolveZaiBusinessBaseUrl()].includes(parsed.origin) &&
      parsed.pathname.startsWith("/api/pay/paypal/")
    );
  } catch {
    return false;
  }
}

function isCodingPlanWebviewUrl(src: string | undefined): boolean {
  if (!src) return false;
  try {
    const url = new URL(src);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (
      !isTrustedCodingPlanWebviewOrigin(url.origin, {
        e2eStoreBridgeEnabled: process.env.VITE_ZCODE_E2E_STORE_BRIDGE === "1",
      })
    ) {
      return false;
    }
    if (!url.pathname.includes("coding-plan")) return false;
    return url.searchParams.get("embedded") === "app";
  } catch {
    return false;
  }
}

function isCodingPlanPaymentCallbackUrl(src: string | undefined): boolean {
  if (!src) return false;
  try {
    const url = new URL(src);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (
      !isTrustedCodingPlanWebviewOrigin(url.origin, {
        e2eStoreBridgeEnabled: process.env.VITE_ZCODE_E2E_STORE_BRIDGE === "1",
      })
    ) {
      return false;
    }
    if (!url.pathname.endsWith("/coding-plan/payment/callback")) return false;
    const returnTo = url.searchParams.get("returnTo");
    if (!returnTo) return false;
    const target = new URL(returnTo, url.origin);
    return target.origin === url.origin && isCodingPlanWebviewUrl(target.toString());
  } catch {
    return false;
  }
}

function isAllowedCodingPlanEmbeddedNavigationUrl(url: string): boolean {
  return (
    isCodingPlanWebviewUrl(url) ||
    isCodingPlanPaypalNavigationUrl(url) ||
    isCodingPlanPaymentCallbackUrl(url)
  );
}

function shouldKeepCodingPlanOpenExternalInWebview(currentUrl: string, targetUrl: string): boolean {
  return (
    (isCodingPlanWebviewUrl(currentUrl) || isCodingPlanPaypalNavigationUrl(currentUrl)) &&
    isAllowedCodingPlanEmbeddedNavigationUrl(targetUrl)
  );
}

export function registerRemoteIpcHandlers(options: {
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  // 遥测移除（P1）：这里原有 appTelemetryRuntime / onOAuthCallbackHandledSideEffect /
  // appTelemetryCore / reportRemoteUsageEvent / armsCustomContext / finalArmsCustomEventE2EEnabled
  // 六个上报相关选项，随 TelemetryCore 与 ARMS 一并删除。
  createRemoteWorkspaceSession: (
    win: BrowserWindow,
    target: RemoteTarget,
    requestId?: string,
    context?: { workspacePath: string; workspaceIdentity?: string },
    lifecycle?: { remoteUsageTelemetryEligible?: boolean },
  ) => Promise<string>;
  disposeRemoteWorkspaceSession: (
    sessionId: string,
    reason: string,
    signalGracePeriodMs?: number,
  ) => void;
  cancelPendingRemoteWorkspaceSessionsForWindow: (
    wcId: number,
    reason: string,
    requestId?: string,
  ) => void;
  bindRemoteWorkspaceSessionContext: (
    sessionId: string,
    context: { workspacePath: string; workspaceIdentity?: string },
    expectedWebContentsId?: number,
  ) => Promise<void>;
  confirmRendererAttachmentReady: (
    webContentsId: number,
    payload: { sessionId: string; attachmentId: string },
  ) => void;
  isDockerDaemonAvailable: () => Promise<boolean>;
  listAvailableWSLDistros: () => Promise<unknown[]>;
  listAvailableDockerContainers: () => Promise<unknown[]>;
  listSSHConfigAliases: () => Promise<unknown[]>;
}) {
  ipcMain.on(InternalChannels.ScopedServicePortReady, (event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== "object") return;
    const payload = rawPayload as { sessionId?: unknown; attachmentId?: unknown };
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
    const attachmentId =
      typeof payload.attachmentId === "string" ? payload.attachmentId.trim() : "";
    if (!sessionId || !attachmentId) return;
    options.confirmRendererAttachmentReady(event.sender.id, { sessionId, attachmentId });
  });
  // 遥测移除（P1）：这里原有 finalArmsCustomEventE2E 控制器与三个 E2E IPC
  // （Read/Clear/ConfigureFinalArmsCustomEventsE2E），随 desktopArmsCustomEvent 删除。

  ipcMain.on(PlatformChannels.OAuthRegisterState, (event, payload: unknown) => {
    const registration = parseOAuthStateRegistration(payload);
    if (!registration) {
      options.logger.warn("[oauth-register-state] invalid payload", payload);
      return;
    }

    registerOAuthState(event.sender.id, registration);
  });

  ipcMain.on(PlatformChannels.OpenExternal, (event, payload: unknown) => {
    const request = parseOpenExternalRequest(payload);
    if (!request) {
      options.logger.warn("[open-external] blocked unsupported request", payload);
      return;
    }
    const { url } = request;
    if (!isAllowedExternalOpenUrl(url)) {
      options.logger.warn("[open-external] blocked unsupported url", url);
      return;
    }
    const sender = event.sender;
    const senderUrl = typeof sender?.getURL === "function" ? sender.getURL() : "";
    const senderFrameUrl =
      typeof event.senderFrame?.url === "string" ? event.senderFrame.url : undefined;
    const sourceUrl = senderFrameUrl ?? request.sourceUrl ?? senderUrl;
    if (
      typeof sender?.loadURL === "function" &&
      shouldKeepCodingPlanOpenExternalInWebview(sourceUrl, url)
    ) {
      // 官网 embedded bridge 的 openExternal 会绕过 webview 导航守卫；
      // PayPal 授权完成后的可信回调仍需回到当前 webview，不能拉起系统默认浏览器。
      void sender.loadURL(url).catch((error: unknown) => {
        options.logger.warn("[open-external] failed to load coding-plan callback in webview", {
          error: error instanceof Error ? error.message : String(error),
          url,
        });
      });
      return;
    }
    void Promise.resolve(shell.openExternal(url)).catch((error: unknown) => {
      options.logger.warn("[open-external] 外部 URL 打开失败", {
        url,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  ipcMain.handle(PlatformChannels.OpenExternalFile, async (_event, rawPath: string) =>
    openPathInDefaultApp(rawPath, options.logger),
  );

  ipcMain.on(PlatformChannels.RendererReady, (event) => {
    // 遥测移除（P1）：这里原有 appTelemetryRuntime.onRendererReady 上报；
    // 补投启动期待处理 deep link 的本地行为必须保留。
    deliverPendingDeepLink(event.sender);
  });

  // 遥测移除（P1）：这里原有 SyncTelemetryContext / ReportTelemetryEvent /
  // ReportArmsCustomEvent 三个上报 IPC handler（renderer → main → TelemetryCore / ARMS SDK）。
  // 对应 PlatformChannels 与 preload 桥已删除，handler 一并移除。

  // OAuth 回调已处理：原本这里还会通知 appTelemetryRuntime 并刷新 ARMS user.id，
  // 遥测删除后本 handler 无副作用，但 IPC 契约保留（renderer 仍会发这个通知）。
  ipcMain.on(PlatformChannels.OAuthCallbackHandled, () => {});

  ipcMain.on(PlatformChannels.ShowTaskNotification, (event, payload: unknown) => {
    dispatchTaskNotification({ event, payload, logger: options.logger });
  });
  ipcMain.handle(PlatformChannels.ShowTaskNotification, (event, payload: unknown) =>
    dispatchTaskNotification({ event, payload, logger: options.logger }),
  );

  app.on("browser-window-created", (_, win) => {
    const windowWebContentsId = win.webContents.id;
    win.on("closed", () => {
      // BrowserWindow 的 closed 阶段里 webContents 可能已被 Electron 释放。
      // 之前这里直接读取 win.webContents.id，会把正常关窗流程变成主进程未捕获异常。
      // 提前缓存 id 后再做清理，避免访问已经销毁的对象。
      clearOAuthRoutesForWindow(windowWebContentsId);
    });
  });

  ipcMain.handle(PlatformChannels.ConnectRemote, async (event, rawPayload: unknown) => {
    const wrappedPayload: {
      target: unknown;
      requestId?: unknown;
      workspacePath?: unknown;
      workspaceIdentity?: unknown;
      connectTrigger?: unknown;
    } =
      rawPayload && typeof rawPayload === "object" && "target" in rawPayload
        ? (rawPayload as {
            target: unknown;
            requestId?: unknown;
            workspacePath?: unknown;
            workspaceIdentity?: unknown;
            connectTrigger?: unknown;
          })
        : { target: rawPayload, requestId: undefined };
    const result = remoteTargetSchema.safeParse(wrappedPayload.target);
    if (!result.success) {
      const error = `Invalid connect-remote payload: ${formatZodError(result.error)}`;
      options.logger.warn("[connect-remote]", error);
      return { success: false, error };
    }
    const requestId =
      typeof wrappedPayload.requestId === "string" && wrappedPayload.requestId.trim().length > 0
        ? wrappedPayload.requestId.trim()
        : undefined;
    const workspacePath =
      typeof wrappedPayload.workspacePath === "string" &&
      wrappedPayload.workspacePath.trim().length > 0
        ? wrappedPayload.workspacePath
        : undefined;
    const workspaceIdentity =
      typeof wrappedPayload.workspaceIdentity === "string" &&
      wrappedPayload.workspaceIdentity.trim().length > 0
        ? wrappedPayload.workspaceIdentity
        : undefined;
    // 遥测移除（P1）：connectTrigger 原本只用于 buildRemoteWorkspaceConnectResultTelemetry /
    // reportRemoteConnectResultToArms 的事件维度，已随上报链路删除。renderer 仍会带上这个字段，
    // 但 main 不再需要归一化它。

    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) {
        throw new Error("未找到当前窗口，无法创建远程 session");
      }

      // 遥测移除（P1）：这里原有 lifecycle 选项 { remoteUsageTelemetryEligible: true } 以及
      // 成功分支的 reportRemoteUsageEvent / reportRemoteConnectResultToArmsSafely 两次上报。
      const sessionId = await options.createRemoteWorkspaceSession(
        win,
        result.data,
        requestId,
        workspacePath ? { workspacePath, workspaceIdentity } : undefined,
      );
      return { success: true, sessionId };
    } catch (error) {
      const normalizedError = normalizeUnknownError(error);
      // 这里之前直接把 Error 对象交给 logger，落盘时会被 JSON.stringify 压成 `{}`。
      // 改成显式展开 message/code/stack，保证远程建连失败时主进程日志里能看到真实上下文。
      options.logger.error("[connect-remote] caught error:", {
        message: normalizedError.message,
        code: normalizedError.code,
        stack: error instanceof Error ? error.stack : undefined,
      });
      return { success: false, error: normalizedError.message };
    }
  });

  ipcMain.handle(
    PlatformChannels.CancelPendingRemoteConnection,
    async (event, rawPayload: unknown) => {
      const payload =
        rawPayload && typeof rawPayload === "object" ? (rawPayload as { requestId?: unknown }) : {};
      const requestId =
        typeof payload.requestId === "string" && payload.requestId.trim().length > 0
          ? payload.requestId.trim()
          : undefined;
      // 连接建立前没有 sessionId，renderer 之前无法精准通知 main 取消正在进行的连接。
      // 现在优先按 requestId 精确取消当前弹窗发起的连接，避免误伤同窗口其他并发连接。
      // 若 requestId 缺失则回退到按窗口取消，兼容旧调用端。
      options.cancelPendingRemoteWorkspaceSessionsForWindow(
        event.sender.id,
        `cancel-pending-remote-connection:${event.sender.id}`,
        requestId,
      );
    },
  );

  ipcMain.handle(
    PlatformChannels.BindRemoteWorkspaceSessionContext,
    async (event, rawPayload: unknown) => {
      if (!rawPayload || typeof rawPayload !== "object") {
        throw new Error("远程 workspace context payload 无效");
      }
      const payload = rawPayload as {
        remoteSessionId?: unknown;
        workspacePath?: unknown;
        workspaceIdentity?: unknown;
      };
      const remoteSessionId =
        typeof payload.remoteSessionId === "string" ? payload.remoteSessionId.trim() : "";
      const workspacePath = typeof payload.workspacePath === "string" ? payload.workspacePath : "";
      const workspaceIdentity =
        typeof payload.workspaceIdentity === "string" ? payload.workspaceIdentity.trim() : "";
      if (!remoteSessionId || !workspacePath.trim()) {
        throw new Error("远程 workspace context 缺少 sessionId 或 workspacePath");
      }
      await options.bindRemoteWorkspaceSessionContext(
        remoteSessionId,
        {
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
        },
        event.sender.id,
      );
    },
  );

  ipcMain.handle(PlatformChannels.DisposeRemoteSession, async (_event, sessionId: string) => {
    options.disposeRemoteWorkspaceSession(sessionId, `dispose-remote-session:${sessionId}`, 150);
  });

  ipcMain.handle(PlatformChannels.IsDockerAvailable, async () => {
    try {
      return await options.isDockerDaemonAvailable();
    } catch (error) {
      options.logger.warn("[is-docker-available] detect failed:", error);
      return false;
    }
  });

  ipcMain.handle(PlatformChannels.ListWSLDistros, async () => {
    try {
      return await options.listAvailableWSLDistros();
    } catch (error) {
      options.logger.warn("[list-wsl-distros] detect failed:", error);
      return [];
    }
  });

  ipcMain.handle(PlatformChannels.ListDockerContainers, async () => {
    try {
      return await options.listAvailableDockerContainers();
    } catch (error) {
      options.logger.warn("[list-docker-containers] detect failed:", error);
      return [];
    }
  });

  ipcMain.handle(PlatformChannels.ListSSHConfigAliases, async () => {
    try {
      return await options.listSSHConfigAliases();
    } catch (error) {
      const normalizedError = normalizeUnknownError(error);
      // Error 对象直接落盘会被序列化成 `{}`，SSH config 解析失败时无法定位具体 pattern。
      // 显式展开错误字段，保留 UI 返回空列表的兼容行为，同时让日志能看到根因。
      options.logger.warn("[list-ssh-config-aliases] detect failed:", {
        message: normalizedError.message,
        code: normalizedError.code,
        name: error instanceof Error ? error.name : undefined,
        stack: error instanceof Error ? error.stack : undefined,
      });
      return [];
    }
  });
}
