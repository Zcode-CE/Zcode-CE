/* eslint-disable max-lines -- desktop runtime/env 解析需要集中维护 main/host/remote assets 的启动边界，拆分会扩大远程连接回归面。 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, win32 } from "node:path";
import type { ConnectOptions } from "@zcode/server/remote";
import { listSSHConfigAliasesFromLocalConfig } from "@zcode/services/node";
import { DEV_HELPER_APP_NAME, HELPER_APP_NAME } from "@zcode/zcode-cua/broker/helperConstants";
import {
  ZCODE_APP_VERSION_ENV,
  ZCODE_AGENT_RUNTIME,
  ZCODE_DYNAMIC_WORKFLOW_MODE_ENV,
  ZCODE_ENV,
  ZCODE_PRODUCT_FLAVOR,
  ZCODE_RUNTIME_ENV_KEY,
  ZCODE_VERSION,
  buildZCodeToolEnvPassthroughEnv,
  resolveRuntimeZCodeEndpointOrigin,
  readProductEndpointEnv,
  pickProductEndpointEnv,
  resolveZaiBusinessBaseUrl,
  resolveZaiOAuthClientId,
  resolveZaiOAuthOrigin,
  normalizeDynamicWorkflowMode,
  sanitizeZCodeRuntimeEnv,
  type ZCodeRuntimeEnv,
} from "@zcode/shared";
import { resolvePlatformKeyForPackagedApp } from "../../scripts/target-platform.mjs";
import {
  getAppConfigDir,
  getDataBaseDir,
  ZCODE_CUA_BUNDLED_HELPER_APP_PATH_ENV,
  ZCODE_WINDOWS_APP_INSTALL_DIR_ENV,
} from "@zcode/services/node";
import { normalizeRemoteAssetCdnBaseUrl } from "@zcode/shared";
import type { ResolveRemoteCdnOptions } from "./remoteCdn.js";
import { resolveRemoteCdnBaseUrlsWithOverrides } from "./remoteCdnOverrides.js";
import { getElectronAppPath, isElectronAppPackaged } from "./desktopElectronApp.js";

const isLocalDevelopmentRuntime = !isElectronAppPackaged();
export const desktopRuntimeEnv: ZCodeRuntimeEnv = isLocalDevelopmentRuntime
  ? "development"
  : "production";
// 身份看编译期 flavor 而不是 ZCODE_ENV：ZCODE_PREVIEW_IDENTITY=1 的生产后端构建同样是 Preview，
// 需要独立的应用名、Electron 数据目录和 Helper 安装子目录才能与正式版并排运行。
const isPreviewPackagedRuntime = !isLocalDevelopmentRuntime && ZCODE_PRODUCT_FLAVOR === "preview";

function readRuntimeEnvOverride(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function isTruthyRuntimeEnvOverride(name: string): boolean {
  const value = readRuntimeEnvOverride(name)?.toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

// e2e 运行的是生产构建，默认会和本机正式版 ZCode 共用 app name / userData，
// 触发 Electron 单实例锁后只激活已有窗口，Chromedriver 无法接管测试进程。
// 这里允许测试显式隔离运行时身份，正常桌面/远控路径保持原来的默认值。
export const runtimeApplicationName =
  readRuntimeEnvOverride("ZCODE_DESKTOP_APPLICATION_NAME") ??
  (isLocalDevelopmentRuntime
    ? "ZCode Dev"
    : isPreviewPackagedRuntime
      ? "ZCode-CE Preview"
      : "ZCode-CE");
// 注意：这个名字同时决定 Electron 的 `userData` 目录（`join(appData, runtimeApplicationName)`）
// 与 `requestSingleInstanceLock` 的单实例身份。用 `ZCode-CE` 而不是 `ZCode` 的原因：
//   1. 与官方 ZCode 并存安装时不能共用 `SingletonLock`，否则先启动的那个会拦下另一个；
//   2. `userData` 里只有 Electron 运行时状态（session / 缓存），业务数据在 `~/.zcode/v2`（硬编码，
//      不随应用名变化），所以改名不会丢用户数据。
// 开发态仍用 `ZCode Dev`、Preview 仍用独立名，保持既有 e2e 隔离语义不变。
// Electron 的 app.getPath("home") 不一定跟随测试进程里的 HOME 覆盖。
// e2e 默认工作区依赖 home 路径，因此提供显式覆盖，避免测试写到开发者真实 ~/ZCodeProject。
export const runtimeHomePath = readRuntimeEnvOverride("ZCODE_DESKTOP_HOME_DIR");
// Chromedriver 管理 Electron 时会注入临时 userData；e2e 默认路径模式下导入期不能提前读取 appData。
export const shouldUseElectronDefaultUserDataPath = isTruthyRuntimeEnvOverride(
  "ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA",
);
export const runtimeUserDataPath =
  readRuntimeEnvOverride("ZCODE_DESKTOP_USER_DATA_DIR") ??
  (shouldUseElectronDefaultUserDataPath
    ? undefined
    : join(getElectronAppPath("appData"), runtimeApplicationName));
export const runtimeSessionDataPath =
  readRuntimeEnvOverride("ZCODE_DESKTOP_SESSION_DATA_DIR") ??
  (runtimeUserDataPath ? join(runtimeUserDataPath, "session") : undefined);
// Chromedriver 会注入临时 --user-data-dir，并在该目录等待 DevToolsActivePort。
// e2e 如果再用 app.setPath 覆盖 userData/sessionData，端口文件会被写到另一个目录，
// 导致 Electron 已启动但 WebDriver session 一直创建失败。测试态打开该开关后保留 Chromedriver 的目录。
export const hostModulePath = join(import.meta.dirname, "../host/index.js");
export const schedulerModulePath = join(import.meta.dirname, "../scheduler/index.js");
export function getCredentialsDir() {
  return getAppConfigDir();
}

export type RemoteAssetDirs = Pick<
  ConnectOptions,
  "mockCdnDir" | "remoteCdnBaseUrl" | "remoteCdnBaseUrls" | "remoteCacheDir"
>;
type LocalRuntimeEnv = Record<string, string | undefined>;

export async function isDockerDaemonAvailable(): Promise<boolean> {
  const { isDockerAvailable } = await import("@zcode/server/remote");
  return isDockerAvailable();
}

export async function listAvailableWSLDistros() {
  const { listWSLDistros } = await import("@zcode/server/remote");
  return listWSLDistros();
}

export async function listAvailableDockerContainers() {
  const { listDockerContainers } = await import("@zcode/server/remote");
  return listDockerContainers();
}

export async function listSSHConfigAliases() {
  return await listSSHConfigAliasesFromLocalConfig();
}

function parseDotenv(content: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }

    const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const equalsIndex = normalized.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }

    const key = normalized.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    let value = normalized.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    values[key] = value;
  }

  return values;
}

function resolveWorkspaceRootForEnvFiles(): string | null {
  const workspaceRootCandidate = resolve(import.meta.dirname, "../../../..");
  return existsSync(join(workspaceRootCandidate, "pnpm-workspace.yaml"))
    ? workspaceRootCandidate
    : null;
}

export function loadHostProcessEnvFromLocalFiles(): Record<string, string> {
  if (isElectronAppPackaged()) {
    // 遥测移除（P1）：打包态原本只回填 ZCODE_TELEMETRY_RUNTIME_DISTRIBUTION 作为上报身份元数据
    // （安装包不内嵌 OTLP 端点或鉴权，避免 CI 凭据随产物公开）。现在没有任何遥测变量需要注入，
    // 打包态直接返回空 patch，连接配置仍由运行时环境提供。
    return {};
  }

  const desktopRoot = resolve(import.meta.dirname, "../..");
  const workspaceRoot = resolveWorkspaceRootForEnvFiles();
  const fileCandidates = [
    ...(workspaceRoot
      ? [resolve(workspaceRoot, ".env"), resolve(workspaceRoot, ".env.local")]
      : []),
    // 开发态 host process 不经过 Vite，自行加载相同的 .env 文件以保持 OAuth 配置一致。
    ...(workspaceRoot && isLocalDevelopmentRuntime
      ? [
          resolve(workspaceRoot, ".env.development"),
          resolve(workspaceRoot, ".env.development.local"),
        ]
      : []),
    resolve(desktopRoot, ".env"),
    resolve(desktopRoot, ".env.local"),
    ...(isLocalDevelopmentRuntime
      ? [resolve(desktopRoot, ".env.development"), resolve(desktopRoot, ".env.development.local")]
      : []),
  ];

  const merged: Record<string, string> = {};
  const seen = new Set<string>();

  for (const candidate of fileCandidates) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);

    if (!existsSync(candidate)) {
      continue;
    }

    // 之前按 cwd 向上级目录泛搜 .env，容易误读到工作区外的同名文件。
    // 这里将加载范围收敛为 workspace 根与 desktop 包目录，避免配置来源漂移。
    const parsed = parseDotenv(readFileSync(candidate, "utf-8"));
    Object.assign(merged, parsed);
  }

  return applySelectedZCodeEnvLinks(merged);
}

function resolveDevelopmentMockCdnDir(): string {
  return join(import.meta.dirname, "../../mock-cdn");
}

function resolveAvailableDevelopmentMockCdnDir(): string | undefined {
  const mockCdnDir = resolveDevelopmentMockCdnDir();
  const releaseDir = join(mockCdnDir, "releases", ZCODE_VERSION);
  // 开发态 mock-cdn 是可选离线缓存。当前版本目录不存在时继续传 mockCdnDir，
  // 会让 WSL/SSH 重连先命中一个必然缺失的本地路径，遮蔽已有的 CDN/cache fallback。
  return existsSync(releaseDir) ? mockCdnDir : undefined;
}

function isTruthyEnvFlag(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function shouldUseRemoteCdnInDevelopment(localEnv: LocalRuntimeEnv = {}): boolean {
  return isTruthyEnvFlag(resolveEnvValue("ZCODE_DEV_REMOTE_ASSET_USE_CDN", localEnv));
}

/**
 * 远程资产基址的**唯一组合点**（desktop 侧）。
 *
 * 优先级（与 docs/development/remote-workspace.md §3.1 一致）：
 *   1. 运行期 env `ZCODE_REMOTE_ASSET_CDN_BASE_URL`（运维/调试，最高）
 *   2. 用户设置 `AppSettings.remoteAssetCdnBaseUrl`（设置页，唯一所有者）
 *   3. 构建期 `ZCODE_CDN_BASE_URL` / `__ZCODE_CDN_BASE_URL__`（由 remoteCdn.ts 处理）
 *   4. 官方默认
 *
 * 两个自定义值都走**同一个** `overrideBaseUrl` 槽位：`remoteCdn.ts` 对它的语义是
 * 「按字面值当发布根」，env 与设置因此不可能出现两套拼接规则。env 非空即短路，
 * 保证"运维排障时能临时覆盖用户设置"这条既有契约不变。
 */
function resolveRemoteCdnBaseUrls(
  options: ResolveRemoteCdnOptions = {},
  localEnv: LocalRuntimeEnv = {},
): string[] {
  // 优先级组合收在 remoteCdnOverrides.ts（纯函数、可被 node:test 真跑）——本模块会拉进 electron，
  // 在这层写逻辑等于让最易错的排序没有可执行测试。
  return resolveRemoteCdnBaseUrlsWithOverrides(
    { ...options, version: ZCODE_VERSION },
    {
      envBaseUrl: resolveEnvValue("ZCODE_REMOTE_ASSET_CDN_BASE_URL", localEnv),
      settingsBaseUrl: remoteAssetCdnBaseUrlSetting,
    },
    ZCODE_ENV,
  );
}

/**
 * 用户设置里的自定义 CDN 基址（`AppSettings.remoteAssetCdnBaseUrl`）在本进程内的缓存。
 *
 * 为什么用缓存而不是每次去读 setting.json：`resolveRemoteAssetDirs` 是**同步**接口
 * （`desktopRemoteSessions.ts:78` 的契约），而设置读取是异步的。
 * 读取点只有两个：main 启动时的 bootstrap（`index.ts` 与其它 AppSettings 字段同一处）
 * 与设置变更事件（`syncImmediateAppSettings`）—— 两者都调 `setRemoteAssetCdnBaseUrlSetting`。
 */
let remoteAssetCdnBaseUrlSetting: string | undefined;

/** 由 main 在启动读取与设置更新时写入；传空串/undefined 表示"用户选择用默认"。 */
export function setRemoteAssetCdnBaseUrlSetting(value: string | undefined): void {
  const normalized = normalizeRemoteAssetCdnBaseUrl(value);
  remoteAssetCdnBaseUrlSetting = normalized.kind === "valid" ? normalized.value : undefined;
}

function resolveEnvValue(envName: string, localEnv: LocalRuntimeEnv = {}): string | undefined {
  return process.env[envName]?.trim() || localEnv[envName]?.trim() || undefined;
}

export function resolveZCodeEndpointEnvBaseOrigin(
  localEnv: LocalRuntimeEnv = {},
): string | undefined {
  const buildEnv = readProductEndpointEnv();
  // main 进程临时验证更新服务时不会重新写 .env，命令行传入的 endpoint 必须优先于本地文件。
  return (
    process.env["ZCODE_BASE_URL"]?.trim() ||
    process.env["ZCODE_ENDPOINT_ORIGIN"]?.trim() ||
    localEnv.ZCODE_BASE_URL?.trim() ||
    localEnv.ZCODE_ENDPOINT_ORIGIN?.trim() ||
    buildEnv.ZCODE_BASE_URL?.trim() ||
    buildEnv.ZCODE_ENDPOINT_ORIGIN?.trim() ||
    undefined
  );
}

function readDefinedProcessEnv(): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      values[key] = value;
    }
  }
  return values;
}

function applySelectedZCodeEnvLinks(env: Record<string, string>): Record<string, string> {
  const endpointEnv = {
    ...readProductEndpointEnv(),
    ...env,
    ZCODE_ENV,
  };

  return {
    ...pickProductEndpointEnv(endpointEnv),
    ...env,
    ZCODE_BASE_URL: env.ZCODE_BASE_URL ?? resolveRuntimeZCodeEndpointOrigin(endpointEnv),
    ZAI_OAUTH_ORIGIN: env.ZAI_OAUTH_ORIGIN ?? resolveZaiOAuthOrigin(endpointEnv),
    ZAI_BUSINESS_BASE_URL: env.ZAI_BUSINESS_BASE_URL ?? resolveZaiBusinessBaseUrl(endpointEnv),
    ZAI_OAUTH_CLIENT_ID: env.ZAI_OAUTH_CLIENT_ID ?? resolveZaiOAuthClientId(endpointEnv),
  };
}

function resolveHostProcessNodeEnv(): ZCodeRuntimeEnv {
  return desktopRuntimeEnv;
}

function resolveRemoteAssetCacheDir(localEnv: LocalRuntimeEnv = {}): string {
  const overrideCacheDir = resolveEnvValue("ZCODE_REMOTE_ASSET_CACHE_DIR", localEnv);
  if (overrideCacheDir) {
    // 开发态需要复用正式版 remote cache 验证下载判断，但不能整体切换 Electron userData。
    // 因此只允许覆盖 remote assets cache 目录，避免污染登录态、窗口状态等其它开发数据。
    return resolve(overrideCacheDir);
  }

  return join(getElectronAppPath("userData"), "remote-assets-cache");
}

export function resolveRemoteAssetDirs(
  options: ResolveRemoteCdnOptions = {},
  localEnv: LocalRuntimeEnv = {},
): RemoteAssetDirs {
  const remoteCdnBaseUrls = resolveRemoteCdnBaseUrls(options, localEnv);
  const remoteCdnBaseUrl = remoteCdnBaseUrls[0];

  // remote 资源之前和 desktop 本地 provider 资源共用安装包内路径，
  // 结果打包后会把整套 Linux 远程运行时一起塞进 .app，和“remote 资源走 CDN / mock-cdn”的职责边界冲突。
  // 这里改成显式分流：开发态只读仓库里的 mock-cdn；生产态统一走 CDN + 本地缓存目录，
  // 不再暴露任何安装包内 remote-assets 路径，避免 remote 资源再次被塞回安装包。
  // 功能开关：开发态默认继续走 mock-cdn，只有显式打开开关才切到公网 CDN。
  // 这样能兼容离线开发场景，同时允许在开发环境提前验证真实 CDN 下载链路。
  if (isElectronAppPackaged() || shouldUseRemoteCdnInDevelopment(localEnv)) {
    return {
      remoteCdnBaseUrl,
      remoteCdnBaseUrls,
      remoteCacheDir: resolveRemoteAssetCacheDir(localEnv),
    };
  }

  const developmentMockCdnDir = resolveAvailableDevelopmentMockCdnDir();
  return {
    ...(developmentMockCdnDir ? { mockCdnDir: developmentMockCdnDir } : {}),
    remoteCdnBaseUrl,
    remoteCdnBaseUrls,
    remoteCacheDir: resolveRemoteAssetCacheDir(localEnv),
  };
}

function resolveBundledZCodeAgentBinaryPath(): string | undefined {
  const runtime = ZCODE_AGENT_RUNTIME;
  const entrySegments = runtime.resolveEntrySegments(process.platform);
  const platformKey = resolvePlatformKeyForPackagedApp();
  const candidates = [
    isElectronAppPackaged()
      ? join(process.resourcesPath, runtime.bundledResourceDir, ...entrySegments)
      : null,
    // desktop 开发态的启动 cwd 可能是 packages/desktop，也可能是仓库根，
    // 之前这里只按 import.meta.dirname 的相对路径推导 bundled-agents，
    // 这里补齐和 services 侧一致的多候选根目录，避免开发/构建/重启入口不同导致资源解析漂移。
    join(
      process.cwd(),
      "bundled-agents",
      platformKey,
      runtime.bundledResourceDir,
      ...entrySegments,
    ),
    join(
      process.cwd(),
      "packages",
      "desktop",
      "bundled-agents",
      platformKey,
      runtime.bundledResourceDir,
      ...entrySegments,
    ),
    join(
      import.meta.dirname,
      "../../bundled-agents",
      platformKey,
      runtime.bundledResourceDir,
      ...entrySegments,
    ),
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => existsSync(candidate));
}

function resolveBundledRuntimeToolBinaryPath(
  toolDir: string,
  binaryName: string,
): string | undefined {
  const candidateBinaryName = process.platform === "win32" ? `${binaryName}.exe` : binaryName;
  const candidates = [
    isElectronAppPackaged()
      ? join(process.resourcesPath, "tools", toolDir, candidateBinaryName)
      : null,
    join(
      import.meta.dirname,
      "../../bundled-tools",
      resolvePlatformKeyForPackagedApp(),
      toolDir,
      candidateBinaryName,
    ),
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => existsSync(candidate));
}

function resolveBundledLarkCliBinaryPath(): string | undefined {
  return resolveBundledRuntimeToolBinaryPath("lark-cli", "lark-cli");
}

export function resolveBundledGlmBinaryPath(): string | undefined {
  return resolveBundledZCodeAgentBinaryPath();
}

function resolveHostProcessBinaryEnv(
  envVar: string,
  hostProcessLocalEnv: Record<string, string>,
  bundledPath: string | undefined,
): string | undefined {
  // ZCode Agent 与 app 协议适配强绑定版本，生产包必须优先使用随包携带的固定 runtime。
  // 用户机器或本地 .env 里残留的 GLM_BINARY_PATH 即使存在，也可能版本不兼容。
  // 只有 bundled runtime 缺失时才把显式路径作为兜底，避免用户本机 CLI 覆盖内嵌版本。
  if (bundledPath) {
    return bundledPath;
  }
  const explicitPath = process.env[envVar]?.trim() || hostProcessLocalEnv[envVar]?.trim();
  if (explicitPath && existsSync(explicitPath)) {
    return explicitPath;
  }
  return undefined;
}

function resolveWindowsAppInstallDirForDataBaseDirGuard(
  options: {
    platform?: NodeJS.Platform | string;
    isPackaged?: boolean;
    resourcesPath?: string;
  } = {},
): string | undefined {
  const platform = options.platform ?? process.platform;
  const packaged = options.isPackaged ?? isElectronAppPackaged();
  const resourcesPath = options.resourcesPath ?? process.resourcesPath;
  if (platform !== "win32" || !packaged) {
    return undefined;
  }

  const trimmedResourcesPath = resourcesPath?.trim();
  if (!trimmedResourcesPath) {
    return undefined;
  }

  return win32.dirname(trimmedResourcesPath);
}

/**
 * Dynamic Workflow 灰度的本地覆盖按构建档位分三层
 *
 *   - 未打包 dev：透传 shell 里的合法取值，方便手工切档；非法值直接丢弃而不是转发给 Host，
 *     Host 因此不必再判一次来源；
 *   - 打包 preview：固定写入 `alwaysOn`，忽略 shell，preview 用户始终拥有该功能；
 *   - 打包 production：不写入，且继承值必须被删除，否则本机环境变量就能自行打开灰度。
 * Main 是唯一决策者：对这个键只有「写」和「删」两种动作，绝不原样透传，
 * Host 端的 resolveDynamicWorkflowClientConfig 才能无条件相信读到的值。
 */
function resolveDynamicWorkflowModeHostEnv(options: {
  inheritedValue: string | undefined;
  isPackaged: boolean;
  isPreview: boolean;
}): Record<string, string> {
  if (!options.isPackaged) {
    const mode = normalizeDynamicWorkflowMode(options.inheritedValue);
    return mode ? { [ZCODE_DYNAMIC_WORKFLOW_MODE_ENV]: mode } : {};
  }
  if (options.isPreview) {
    return { [ZCODE_DYNAMIC_WORKFLOW_MODE_ENV]: "alwaysOn" };
  }
  return {};
}

export function buildHostProcessEnv(hostProcessLocalEnv: Record<string, string>) {
  const glmBinaryPath = resolveBundledGlmBinaryPath();
  const larkCliBinaryPath = resolveBundledLarkCliBinaryPath();
  const resolvedGlmBinaryPath = resolveHostProcessBinaryEnv(
    "GLM_BINARY_PATH",
    hostProcessLocalEnv,
    glmBinaryPath,
  );
  const resolvedLarkCliBinaryPath = resolveHostProcessBinaryEnv(
    "ZCODE_LARK_CLI_BINARY",
    hostProcessLocalEnv,
    larkCliBinaryPath,
  );
  const dataBaseDir = getDataBaseDir();
  const rawInheritedEnv = {
    ...hostProcessLocalEnv,
    ...readDefinedProcessEnv(),
  };
  const packagedDesktop = isElectronAppPackaged();
  const bundledCuaHelperAppPath =
    process.platform !== "darwin"
      ? undefined
      : packagedDesktop
        ? join(process.resourcesPath, "cua-helper", HELPER_APP_NAME)
        : // Truthy grammar must match the producer's isUnsignedHelperLocalDevRequested
          // (1|true|on, case-insensitive). Accepting only the literal "1" silently
          // ignored `true`/`on` set by scripts following the documented dev flow.
          ["1", "true", "on"].includes(
              rawInheritedEnv.ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL?.trim().toLowerCase() ?? "",
            )
          ? rawInheritedEnv.ZCODE_CUA_BUNDLED_HELPER_APP_PATH?.trim() ||
            join(
              rawInheritedEnv.ZCODE_HOME?.trim() || join(homedir(), ".zcode"),
              "computer-use",
              "dev",
              DEV_HELPER_APP_NAME,
            )
          : undefined;
  const windowsAppInstallDir = resolveWindowsAppInstallDirForDataBaseDirGuard();
  // 遥测移除（P1）：这里原有 readZCodeAgentTelemetryEnv(rawInheritedEnv) 采集 OTLP 端点/鉴权
  // 与身份变量，再剔除可伪造的 ZCODE_TELEMETRY_* 字段后定向传给 Host（见下方 return）。
  // 该链路已整体删除；这些变量现在由 sanitizeZCodeRuntimeEnv 直接拒绝进入子进程 env。
  const inheritedEnv = applySelectedZCodeEnvLinks({
    ...sanitizeZCodeRuntimeEnv(rawInheritedEnv),
    ...buildZCodeToolEnvPassthroughEnv(rawInheritedEnv),
  });
  // A release app must never inherit the local unsigned-Helper escape hatch.
  // Otherwise a developer shell/launchctl variable can make the signed app
  // reject its verified bundled Helper and route onboarding to a stale dev app.
  if (packagedDesktop) {
    delete inheritedEnv.ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL;
  }
  const dynamicWorkflowModeHostEnv = resolveDynamicWorkflowModeHostEnv({
    inheritedValue: rawInheritedEnv[ZCODE_DYNAMIC_WORKFLOW_MODE_ENV],
    isPackaged: packagedDesktop,
    isPreview: isPreviewPackagedRuntime,
  });
  // 三层里有两层不写这个键，空对象无法覆盖 inheritedEnv，所以先无条件删掉继承值再按决策 spread 回去。
  // 少了这一行，production 包和 dev 的非法取值都会原样穿透到 Host。
  delete inheritedEnv[ZCODE_DYNAMIC_WORKFLOW_MODE_ENV];

  return {
    ...inheritedEnv,
    // ZCode 运行时不再使用 NODE_ENV；它会被用户 shell、包管理器和测试框架复用。
    // 这里显式下发 ZCODE_RUNTIME_ENV，并在继承环境里清掉 NODE_ENV，避免 host/agent/Bash 被污染。
    [ZCODE_RUNTIME_ENV_KEY]: resolveHostProcessNodeEnv(),
    // 显式注入编译期产品身份，保证主进程与 host 的身份语义一致；地址独立解析。
    // inheritedEnv 从 .env 通用变量补齐 ZCode/ZAI 链接，未覆盖时统一使用线上默认值。
    ZCODE_ENV,
    // Preview 与生产版共享任务、配置和凭据，但不同版本的 Helper 不能互相覆盖或触发降级保护。
    // 只隔离 computer-use 下的运行组件，不改写 ZCODE_HOME / ZCODE_DATA_BASE_DIR 业务数据根。
    ...(isPreviewPackagedRuntime ? { ZCODE_CUA_HELPER_INSTALL_VARIANT: "preview" } : {}),
    // Dynamic Workflow 灰度的本地覆盖：Main 决策后写入，production 包为空对象（继承值已在上面删除）。
    ...dynamicWorkflowModeHostEnv,
    // 模型请求默认 header 由 agent 进程构造，过去只继承 shell env 导致桌面启动时拿不到 app 版本。
    // 这里从 main 进程显式下发，agent 子进程继承 host env 后即可稳定写入请求 header。
    [ZCODE_APP_VERSION_ENV]: ZCODE_VERSION,
    ...(dataBaseDir !== homedir() ? { ZCODE_DATA_BASE_DIR: dataBaseDir } : {}),
    ...(windowsAppInstallDir ? { [ZCODE_WINDOWS_APP_INSTALL_DIR_ENV]: windowsAppInstallDir } : {}),
    ...(bundledCuaHelperAppPath
      ? { [ZCODE_CUA_BUNDLED_HELPER_APP_PATH_ENV]: bundledCuaHelperAppPath }
      : {}),
    ...(resolvedGlmBinaryPath ? { GLM_BINARY_PATH: resolvedGlmBinaryPath } : {}),
    ...(resolvedLarkCliBinaryPath ? { ZCODE_LARK_CLI_BINARY: resolvedLarkCliBinaryPath } : {}),
  };
}
