/* eslint-disable max-lines -- Web 入口集中编排启动、路由与 workspace shell wiring，与 Root.tsx 同样先保持入口收口，避免跨层状态拆散。 */
import { createRoot } from "react-dom/client";
import {
  generateMobileDeviceFingerprint,
  playTaskNotificationSound,
  setStreamClientId,
  type Theme,
} from "@zcode/ui";
import "@zcode/ui/styles.css";
import { SERVER_REMOTE_PROTOCOL_VERSION } from "@zcode/shared";
import { evaluateServerCompatibility } from "./serverCompatibility.js";
import { WebAppRoot } from "./WebAppRoot.js";
import { buildUnauthorizedMessage, classifyServerInfoProbe } from "./authProbe.js";
import { WebCallbackPage } from "./auth/WebCallbackPage.js";
import { createWebAuthService } from "./auth/webAuthService.js";
import { WEB_ZAI_OAUTH_CONFIG, resolveWebAuthDevReturnTo } from "./auth/webZaiOAuthConfig.js";
import { parseOAuthState, resolveSafeAppReturnTo } from "./auth/oauthStateCodec.js";
import { resolveWebCommunityUrl, resolveWebHelpConfig } from "./communityUrl.js";
import {
  ConversationShareLandingLoader,
  ConversationShareLandingStatus,
} from "./share/ConversationShareLandingPage.js";
import {
  ConversationSharePreviewClient,
  resolveConversationShareRouteLocale,
} from "./share/conversationSharePreviewClient.js";
import {
  isConversationSharePath,
  resolveConversationShareCodeFromPath,
} from "./share/conversationShareRoute.js";
import type { IPlatformService, RemoteTarget, ServerRemoteInfo } from "@zcode/shared";
import { WEB_DEFAULT_THEME, resolveWebInitialTheme } from "./webThemeSeed.js";

function resolveWebThemePreference(defaultTheme: Theme = WEB_DEFAULT_THEME): Theme {
  const saved = localStorage.getItem("zcode-theme");
  return resolveWebInitialTheme({ storedTheme: saved, defaultTheme });
}

// 初始化主题：默认 Zai dark，后续由 useTheme hook 接管
// system 模式下需要查询系统偏好；非 system 模式直接用存储值
{
  // 分享页没有本地主题配置时使用浅色，已有配置仍然沿用；其他 Web 页面继续默认深色。
  const saved = resolveWebThemePreference(
    isConversationSharePath(window.location.pathname) ? "zai-light" : undefined,
  );
  const resolved =
    saved === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : saved === "dark" || saved === "zai-dark"
        ? "dark"
        : "light";
  const appliedTheme =
    saved === "system"
      ? resolved === "dark"
        ? "zai-dark"
        : "zai-light"
      : saved === "dark"
        ? "zai-dark"
        : saved === "light"
          ? "zai-light"
          : saved;
  document.documentElement.classList.toggle("dark", resolved === "dark");
  document.documentElement.classList.toggle("theme-zai-light", appliedTheme === "zai-light");
  document.documentElement.classList.toggle("theme-zai-dark", appliedTheme === "zai-dark");
}

async function resolveFeedbackUrl(): Promise<string | undefined> {
  return (await resolveWebHelpConfig()).feedback_url;
}

const root = createRoot(document.getElementById("root")!);
const webAuthService = createWebAuthService();

// 初始化 Web 端流式 clientId，确保所有 hook 在首次渲染前就使用稳定 ID
{
  setStreamClientId(generateMobileDeviceFingerprint());
}

interface WebBootstrapResult {
  wsUrl: string;
  initialWorkspaceAbsPath?: string;
  initialWorkspaceIdentity?: string;
  initialTaskId?: string;
  restoreSession?: boolean;
  allowOpenWorkspace?: boolean;
}

function isWebOAuthCallback(params: URLSearchParams): boolean {
  return (
    ["/cn/share/callback", "/share/callback"].includes(window.location.pathname) &&
    params.has("state") &&
    (params.has("code") || params.has("error"))
  );
}

function renderWebAuthCallbackPage(): void {
  document.title = "ZCode - Sign In";
  const callbackState = parseOAuthState(
    new URLSearchParams(window.location.search).get("state") ?? "",
  );
  const safeRetryTarget = resolveSafeAppReturnTo(callbackState?.app_return_to);
  root.render(
    <WebCallbackPage
      authService={webAuthService}
      onSuccess={({ appReturnTo }) => {
        window.location.replace(appReturnTo ?? "/");
      }}
      onRetry={() => {
        window.location.replace(safeRetryTarget ?? "/");
      }}
    />,
  );
}

async function renderConversationSharePage(): Promise<void> {
  // 页面语言跟随路径前缀：/cn/share 中文，裸 /share 英文。
  const routeLocale = resolveConversationShareRouteLocale(window.location.pathname);
  // index.html 固定 lang="en"；不同步会让中文分享页对无障碍与浏览器翻译都报错语言。
  document.documentElement.lang = routeLocale;
  // 分享页必须设置 title：否则浏览器标签只显示 index.html 的通用标题。
  // 会话标题要等 preview 加载完，先给一个语言正确的兜底。
  document.title = routeLocale === "zh-CN" ? "ZCode 会话分享" : "ZCode Conversation Share";
  const shareCode = resolveConversationShareCodeFromPath(window.location.pathname);
  if (!shareCode) {
    root.render(
      <ConversationShareLandingStatus
        state={{ kind: "error", error: "invalid_contract" }}
        locale={routeLocale}
      />,
    );
    return;
  }

  const endpointOrigin =
    import.meta.env.VITE_ZCODE_BASE_URL?.trim().replace(/\/+$/u, "") || window.location.origin;
  const mockMode =
    import.meta.env.DEV && import.meta.env.VITE_CONVERSATION_SHARE_PREVIEW_MOCK === "true";
  // Share 加载失败不能只有通用 network 文案：需要区分 mock、endpoint 配置或跨域 fetch。
  // 这里只记录运行时路由与 endpoint，不记录完整 pathname，避免把 share code 写入日志。
  console.info("[conversation-share-web]", "preview_runtime_initialized", {
    browserOrigin: window.location.origin,
    routeKind: "canonical",
    endpointOrigin,
    transport: mockMode ? "mock" : "fetch",
  });
  const client = mockMode
    ? new (
        await import("./share/mockConversationSharePreviewClient.js")
      ).MockConversationSharePreviewClient()
    : new ConversationSharePreviewClient({ baseUrl: `${endpointOrigin}/api/v1` });
  const getMockToken = () =>
    mockMode && window.sessionStorage.getItem("zcode:share:mock-auth") === "owner"
      ? "mock-owner-token"
      : null;
  const onLogout = () => {
    if (mockMode) {
      window.sessionStorage.removeItem("zcode:share:mock-auth");
      window.location.reload();
      return;
    }
    void webAuthService.logout();
  };
  root.render(
    <ConversationShareLandingLoader
      shareCode={shareCode}
      client={client}
      getAccessToken={() => getMockToken() ?? webAuthService.getZCodeJwtToken()}
      onLogin={(provider) => {
        if (mockMode) {
          window.sessionStorage.setItem("zcode:share:mock-auth", "owner");
          window.location.reload();
          return;
        }
        webAuthService.startLogin({
          provider,
          appReturnTo: window.location.href,
          redirectUri: WEB_ZAI_OAUTH_CONFIG.shareRedirectUri,
          devReturnTo: resolveWebAuthDevReturnTo(WEB_ZAI_OAUTH_CONFIG),
        });
      }}
      onLogout={onLogout}
      locale={routeLocale}
      theme={resolveWebThemePreference("zai-light")}
    />,
  );
}

function createWebPlatform(): IPlatformService {
  return {
    canSelectFilePath: false,
    // Web 端无法打开系统目录选择框
    selectDirectory: () => Promise.resolve(null),
    // Web 端无法打开系统文件选择框
    selectFile: () => Promise.resolve(null),
    selectFiles: () => Promise.resolve([]),
    getPathForFile: () => null,
    createTempTextAttachment: () =>
      Promise.reject(new Error("Temporary text attachments require a desktop host")),
    onRemoteConnectionLog: () => () => {},
    onRemoteSessionClosed: () => () => {},
    // Web 端无多窗口管理
    activateOrSetWorkspace: () => Promise.resolve({ activated: false }),
    // TODO(web-remote-workspace): 普通 Web 模式先只保证 server 本地工作区可用。
    // 远程 WebSocket 只暴露部分 service，与 Root/RemoteServiceAccess 需要的完整
    // accessor 不匹配，直接打开 ?remote=<id> 会在项目向导或首屏卡住。
    connectRemote(options: RemoteTarget) {
      return Promise.resolve({
        success: false,
        error: `Remote connect is not supported in Web mode yet: ${options.kind}`,
      });
    },
    cancelPendingRemoteConnection: (_requestId?: string) => Promise.resolve(),
    disposeRemoteSession: () => Promise.resolve(),
    isDockerAvailable: () => Promise.resolve(false),
    listWSLDistros: () => Promise.resolve([]),
    listDockerContainers: () => Promise.resolve([]),
    listSSHConfigAliases: () => Promise.resolve([]),
    loadMcpFromUserDirectory: () => Promise.resolve({ servers: [] }),
    saveMcpToUserDirectory: () =>
      Promise.resolve({
        success: false,
        error: "MCP native directory management requires a desktop attachment",
      }),
    migrateLegacyCommonMcp: () =>
      Promise.resolve({
        servers: {},
        totalCount: 0,
        importedCount: 0,
        skippedCount: 0,
      }),
    openExternal: (url) => {
      window.open(url, "_blank", "noopener,noreferrer");
    },
    openFeedback: async () => {
      const feedbackUrl = await resolveFeedbackUrl();
      if (!feedbackUrl) {
        return;
      }
      window.open(feedbackUrl, "_blank", "noopener,noreferrer");
    },
    openCommunity: async () => {
      const locale = document.documentElement.lang === "en-US" ? "en-US" : "zh-CN";
      const communityUrl = await resolveWebCommunityUrl(locale);
      if (!communityUrl) {
        return;
      }
      window.open(communityUrl, "_blank", "noopener,noreferrer");
    },
    canOpenCommunity: async (locale) => {
      const communityUrl = await resolveWebCommunityUrl(locale);
      return typeof communityUrl === "string" && communityUrl.length > 0;
    },
    openInFileManager: () =>
      Promise.resolve({ success: false, error: "Not supported in web mode" }),
    openExternalFile: () => Promise.resolve({ success: false, error: "Not supported in web mode" }),
    registerOAuthState: (_payload) => {},
    onOAuthCallback: () => () => {},
    onPaymentCallback: () => () => {},
    onShareImport: () => () => {},
    notifyRendererReady: () => {},
    showTaskNotification: (payload) => {
      if (document.hasFocus()) {
        return;
      }

      if (
        typeof window.Notification === "undefined" ||
        window.Notification.permission !== "granted"
      ) {
        return;
      }

      try {
        new window.Notification(payload.title, {
          body: payload.body,
          silent: true,
        });
        void playTaskNotificationSound();
      } catch {
        // 浏览器通知不可用时静默忽略，避免打断主流程
      }
    },
    // Web 端不需要跨窗口 tab 管理
    syncWindowTabs: () => {},
    // Web 端没有宿主层 Dock / 任务栏徽标，保持空实现以兼容统一平台接口
    syncWindowUnreadCount: () => {},
    syncActiveTaskSession: () => {},
    onFocusTab: () => () => {},
    onNewTab: () => () => {},
    onCloseActiveContextRequest: () => () => {},
    onOpenBrowserUrl: () => () => {},
    onNewTask: () => () => {},
    onOpenWorkspace: () => () => {},
    onWindowFullscreenChanged: () => () => {},
    onTaskNotificationClick: () => () => {},
    exportLogs: () => Promise.resolve({ success: false, error: "Not supported in web mode" }),
    captureWindowScreenshot: () => Promise.resolve(null),
    importChromeBrowserData: (_options) =>
      Promise.resolve({
        success: false,
        cookies: { imported: 0, skipped: 0, failed: 0 },
        localStorage: {
          originsImported: 0,
          entriesImported: 0,
          originsSkipped: 0,
          originsFailed: 0,
        },
        error: "chrome_import_not_supported" as const,
      }),
    clearEmbeddedBrowserData: () =>
      Promise.resolve({ success: false, error: "Not supported in web mode" }),
    // IPlatformService 新增更新提示能力后，Web fallback 没有同步补齐空实现，
    // 根级 typecheck 会直接失败，连与桌面端无关的改动都没法完成校验。
    // Web 端当前没有桌面更新器，先显式 no-op，保持接口完整且不改变现有行为。
    onUpdateReady: () => () => {},
    onUpdateCheckResult: () => () => {},
    onUpdateStateChanged: () => () => {},
    getUpdateState: () => Promise.resolve({ kind: "idle", enabled: true }),
    downloadUpdate: () => Promise.resolve(),
    cancelUpdateDownload: () => Promise.resolve(),
    getDesktopSessionActivity: () => Promise.resolve({ runningAgentSessionCount: 0 }),
    getDesktopZoomLevel: () => Promise.resolve({ zoomLevel: 0 }),
    onDesktopZoomLevelChanged: () => () => {},
    onPostUpdateReleaseNotes: () => () => {},
    acknowledgePostUpdateReleaseNotes: () => Promise.resolve(),
    skipUpdateVersion: () => Promise.resolve(),
    quitAndInstallUpdate: () => Promise.resolve(),
    getInstalledEditors: () => Promise.resolve([]),
    openInEditor: () => Promise.resolve({ success: false, error: "Not supported in web mode" }),
    executeDesktopCommand: () => Promise.resolve(),
    setApplicationLocale: (_locale) => Promise.resolve(),
    setTitleBarTheme: () => Promise.resolve(),
    getDeviceId: () => {
      const nav = globalThis.navigator as Navigator & { platform?: string };
      const platform = nav?.platform ?? "";
      const screenWidth = globalThis.screen?.width;
      const screenHeight = globalThis.screen?.height;
      const colorDepth = globalThis.screen?.colorDepth;
      const parts = [
        platform,
        screenWidth !== undefined ? String(screenWidth) : "",
        screenHeight !== undefined ? String(screenHeight) : "",
        colorDepth !== undefined ? String(colorDepth) : "",
      ];
      return parts.filter(Boolean).join("|");
    },
  };
}

function resolveDefaultWsOrigin(): string {
  return `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`;
}

async function resolveWebBootstrap(): Promise<WebBootstrapResult> {
  const params = new URLSearchParams(window.location.search);
  const remoteId = params.get("remote");
  const wsUrl = remoteId
    ? `${resolveDefaultWsOrigin()}/ws/remote/${remoteId}`
    : `${resolveDefaultWsOrigin()}/ws`;

  if (remoteId) {
    return { wsUrl };
  }

  let serverInfo: Partial<ServerRemoteInfo> | undefined;
  let probe: { status?: number; networkError?: boolean } = { networkError: true };
  try {
    const response = await fetch("/api/server-info", {
      cache: "no-store",
    });
    probe = { status: response.status };
    if (response.ok) {
      serverInfo = (await response.json()) as Partial<ServerRemoteInfo>;
    }
  } catch {
    // 网络层失败：交给连接监督器（覆盖层 + 退避重连）处理，这里不拦。
    probe = { networkError: true };
  }

  // 401/403 是**授权问题**，不是网络问题：直接渲染未授权屏并停止（不进 WS、不重试），
  // 否则用户会看到「正在重连」这种把授权说成网络问题的误导提示。见 authProbe.ts。
  if (classifyServerInfoProbe(probe) === "unauthorized") {
    throw new Error(
      buildUnauthorizedMessage(/^zh\b/i.test(navigator.language), window.location.origin),
    );
  }

  // 拿到 server-info 时**必须**校验契约版本：web 资产与服务器不同版本时不进入应用，
  // 也不静默降级（RPC 层不做版本协商）。见 docs/development/web-remote-control.md §5。
  if (serverInfo) {
    const compatibility = evaluateServerCompatibility(serverInfo, SERVER_REMOTE_PROTOCOL_VERSION);
    if (!compatibility.compatible) {
      throw new Error(compatibility.reason);
    }
  }

  const workspace = Array.isArray(serverInfo?.workspaces) ? serverInfo.workspaces[0] : undefined;
  return {
    wsUrl,
    ...(workspace?.path ? { initialWorkspaceAbsPath: workspace.path } : {}),
    ...(workspace?.workspaceIdentity
      ? { initialWorkspaceIdentity: workspace.workspaceIdentity }
      : {}),
  };
}

function WebBootstrapErrorScreen({ message }: { message: string }) {
  return (
    <div className="h-dvh min-h-dvh w-screen bg-background text-foreground">
      <div className="mx-auto flex h-full w-full max-w-lg items-center px-4">
        <section className="w-full rounded-xl border border-card-border bg-card p-5">
          <div className="flex items-center gap-3">
            <span className="size-2 rounded-full bg-destructive" />
            <h1 className="text-ui-xs font-medium">
              {/^zh\b/i.test(navigator.language) ? "Web 启动失败" : "Web bootstrap failed"}
            </h1>
          </div>
          <p className="mt-2 break-all text-ui-xs/relaxed text-foreground-subtle">{message}</p>
          <button
            type="button"
            className="mt-4 rounded-lg border border-border bg-surface px-3 py-2 text-ui-xs text-foreground-subtle hover:bg-surface-hover"
            onClick={() => {
              window.location.reload();
            }}
          >
            {/^zh\b/i.test(navigator.language) ? "重试" : "Retry"}
          </button>
        </section>
      </div>
    </div>
  );
}

function renderWebBootstrapError(error: unknown): void {
  document.title = "ZCode - Web";
  root.render(
    <WebBootstrapErrorScreen message={error instanceof Error ? error.message : String(error)} />,
  );
}

async function bootstrapWebApp() {
  const params = new URLSearchParams(window.location.search);
  if (isWebOAuthCallback(params)) {
    renderWebAuthCallbackPage();
    return;
  }

  if (isConversationSharePath(window.location.pathname)) {
    await renderConversationSharePage();
    return;
  }

  let bootstrap: WebBootstrapResult;
  try {
    bootstrap = await resolveWebBootstrap();
  } catch (error) {
    renderWebBootstrapError(error);
    return;
  }

  const platform = createWebPlatform();
  document.title = "ZCode - Web + Server";
  // 连接与断线自愈都在 WebAppRoot 内（覆盖层 + 退避重连 + 重连后重新挂载应用）；
  // 入口只负责路由、平台实现与启动期错误屏。
  root.render(<WebAppRoot bootstrap={bootstrap} platform={platform} />);
}

void bootstrapWebApp();
