import {
  createCodingPlanApiKeyResolver,
  createSharedZCodeCredentialStore,
  createCliOAuthClient,
  createCliOAuthPollToken,
  openUrlInBrowser,
  type BrowserOpenResult,
  type SharedZCodeCredentialStore,
  type CliOAuthClient,
  type CliOAuthInitData,
  type CliOAuthPollData,
  type CliOAuthUser,
} from "@zcode/adapters";
import { createConfig } from "@zcode/adapters/config";
import { createNodeHttpClientAdapter } from "@zcode/adapters/http";
import type { EnvRecord } from "@zcode/adapters/model";
import { buildZCodeEndpointUrls, resolveRuntimeZCodeEndpointOrigin } from "@zcode/shared";
import {
  NodeModelSelectionConfigRepository,
  NodePersonalProviderConfigRepository,
  PERSONAL_PROVIDER_CONFIG_FILE_NAME,
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
} from "@zcode/provider-node";
import { readLegacyCliPersonalProviderConfig } from "./app/legacy-cli-personal-provider-config-importer.js";
import { dirname, join } from "node:path";
import {
  createStandaloneAccountIdentityFromSecret,
  hasStandaloneCodingPlanAccess,
  resolveStandaloneCodingPlanProvider,
  standaloneAccountIdentityCredentialKey,
  standaloneAccountProviderCredentialKey,
} from "./app/standalone-account-provider-runtime.js";
import {
  captureLoginSessionSnapshot,
  captureStandaloneAccountSnapshot,
  commitLoginSessionChange,
  commitStandaloneAccountCredentials,
  type LoginProviderId,
} from "./auth-login-credentials.js";
import { throwIfAborted, waitWithAbort } from "./auth-login-abort.js";
import { ZCodeCliLoginError } from "./auth-login-error.js";
import { setTimeout as delay } from "node:timers/promises";
import { pollUntilReady } from "./auth-login-polling.js";

// 错误类型单独成模块（账号组自愈也要构造它），对外仍从本入口导出。
export { ZCodeCliLoginError };

// 登出与登录的键集合同源、语义相反（登出不比较期望值），拆到单独模块后仍从本入口导出，
// 调用方（CLI / TUI）不感知文件拆分。
export { logoutZCodeCli } from "./auth-logout.js";
export type { LogoutZCodeCliOptions, LogoutZCodeCliResult } from "./auth-logout.js";

const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1_000;

export type CodingPlanProviderId = LoginProviderId;

export interface LoginZCodeCliOptions {
  providerId?: CodingPlanProviderId;
  abortSignal?: AbortSignal;
  apiKeyResolver?: ReturnType<typeof createCodingPlanApiKeyResolver>;
  baseUrl?: string;
  credentialStore?: SharedZCodeCredentialStore;
  env?: EnvRecord;
  httpClient?: Parameters<typeof createCliOAuthClient>[0]["httpClient"];
  noBrowser?: boolean;
  now?: () => number;
  onAuthorizeUrl?: (data: CliOAuthInitData) => void | Promise<void>;
  onBrowserOpen?: (result: BrowserOpenResult) => void | Promise<void>;
  onPollStatus?: (data: CliOAuthPollData) => void | Promise<void>;
  openBrowser?: (url: string) => Promise<BrowserOpenResult>;
  pollToken?: string;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  personalProviderConfigPath?: string;
}

export interface LoginZCodeCliResult {
  browser?: BrowserOpenResult;
  configPath: string;
  credentialsPath: string;
  model: string;
  providerId: CodingPlanProviderId;
  user: CliOAuthUser;
}

export type LoginBigmodelCodingPlanOptions = Omit<LoginZCodeCliOptions, "providerId">;
export type LoginBigmodelCodingPlanResult = LoginZCodeCliResult & { providerId: "bigmodel" };

export interface ConfigureCodingPlanApiKeyOptions {
  apiKey: string;
  credentialStore?: SharedZCodeCredentialStore;
  env?: EnvRecord;
  personalProviderConfigPath?: string;
  providerId: CodingPlanProviderId;
}

export interface ConfigureCodingPlanApiKeyResult {
  configPath: string;
  model: string;
  providerId: CodingPlanProviderId;
}

export async function hasConfiguredStandaloneCodingPlan(
  options: {
    credentialStore?: SharedZCodeCredentialStore;
    env?: EnvRecord;
  } = {},
): Promise<boolean> {
  const credentialStore =
    options.credentialStore ?? createSharedZCodeCredentialStore({ env: options.env });
  return hasStandaloneCodingPlanAccess(credentialStore, options.env ?? process.env);
}

export async function loginZCodeCli(
  options: LoginZCodeCliOptions = {},
): Promise<LoginZCodeCliResult> {
  const env = options.env ?? process.env;
  const providerId = options.providerId ?? "zai";
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const deadlineMs = now() + timeoutMs;
  const timeoutController = new AbortController();
  const signal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, timeoutController.signal])
    : timeoutController.signal;
  const timeoutError = () =>
    new ZCodeCliLoginError("auth_timeout", "Authorization timed out. Please retry login.");
  let timer = setTimeout(() => timeoutController.abort(timeoutError()), timeoutMs);
  try {
    throwIfAborted(signal);
    const pollToken = options.pollToken ?? createCliOAuthPollToken();
    const credentialStore = options.credentialStore ?? createSharedZCodeCredentialStore({ env });
    // 快照必须在发起登录时读：待授权期间另一进程可能已经完成登录，只有这份快照能让提交
    // 识别出「本轮结果已陈旧」并整组丢弃，而不是用旧响应覆盖新会话。
    const loginSnapshot = await captureLoginSessionSnapshot(credentialStore);
    const oauthClient = createOAuthClient(options, env);
    const initData = await waitWithAbort(oauthClient.init({ pollToken }, { signal }), signal);
    const remainingMs = Math.min(deadlineMs, initData.expires_at * 1_000) - now();
    if (remainingMs <= 0) throw timeoutError();
    clearTimeout(timer);
    timer = setTimeout(() => timeoutController.abort(timeoutError()), remainingMs);
    await options.onAuthorizeUrl?.(initData);
    throwIfAborted(signal);
    const browser = options.noBrowser
      ? undefined
      : await waitWithAbort(
          (options.openBrowser ?? openUrlInBrowser)(initData.authorize_url),
          signal,
        );
    if (browser) await options.onBrowserOpen?.(browser);
    const readyData = await pollUntilReady({
      abortSignal: signal,
      initData,
      now,
      oauthClient,
      onPollStatus: options.onPollStatus,
      pollToken,
      sleep: options.sleep ?? ((ms) => delay(ms, undefined, { signal })),
      timeoutMs: Math.max(0, deadlineMs - now()),
      createError: (code) =>
        code === "auth_timeout"
          ? timeoutError()
          : new ZCodeCliLoginError(code, "Authorization failed. Please retry login."),
    });
    const apiKey = await waitWithAbort(
      resolveCodingPlanApiKey({
        accessToken: readyData.accessToken,
        env,
        httpClient: options.httpClient,
        family: providerId,
        resolver: options.apiKeyResolver,
        signal,
      }),
      signal,
    );
    // A cancelled/expired attempt must not persist a late ready response or API key.
    throwIfAborted(signal);
    try {
      const committed = await commitLoginSessionChange(credentialStore, loginSnapshot, {
        providerId,
        accessToken: readyData.accessToken,
        zcodeJwtToken: readyData.token,
        userInfoRaw: serializeLoginUserInfo(providerId, readyData.user),
        // zai 的授权响应不带 refresh token（Host 也只取 bigmodel 下发的那一枚），
        // 因此 zai 登录不写这个键：落盘字段集合与 Host 侧保持一致。
        ...(providerId === "bigmodel" && readyData.refreshToken
          ? { refreshToken: readyData.refreshToken }
          : {}),
      });
      if (!committed) throw supersededLoginError();
    } catch (error) {
      // CAS 失败不是写盘故障，已带「重新登录」的可操作提示，不能被包装成 credential_write_failed。
      if (error instanceof ZCodeCliLoginError) throw error;
      throw new ZCodeCliLoginError(
        "credential_write_failed",
        "Login succeeded but writing credentials failed.",
        { cause: error },
      );
    }
    throwIfAborted(signal);
    let configPatch: StandaloneCodingPlanPersistenceResult;
    try {
      configPatch = await persistStandaloneCodingPlanConnection({
        accountIdentity: readyData.user.user_id,
        apiKey,
        credentialStore,
        env,
        personalProviderConfigPath: options.personalProviderConfigPath,
        providerId,
      });
    } catch (error) {
      // 凭据冲突发生在配置写入之前，已带可操作提示，不能被归因成 config_update_failed。
      if (error instanceof ZCodeCliLoginError) throw error;
      throw new ZCodeCliLoginError(
        "config_update_failed",
        "Login succeeded but updating ZCode config failed.",
        { cause: error },
      );
    }
    return {
      ...(browser ? { browser } : {}),
      configPath: configPatch.path,
      credentialsPath: credentialStore.filePath,
      model: configPatch.mainModel,
      providerId,
      user: readyData.user,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function loginBigmodelCodingPlan(
  options: LoginBigmodelCodingPlanOptions = {},
): Promise<LoginBigmodelCodingPlanResult> {
  return {
    ...(await loginZCodeCli({ ...options, providerId: "bigmodel" })),
    providerId: "bigmodel",
  };
}

export async function configureCodingPlanApiKey(
  options: ConfigureCodingPlanApiKeyOptions,
): Promise<ConfigureCodingPlanApiKeyResult> {
  const apiKey = options.apiKey.trim();
  if (!apiKey) {
    throw new ZCodeCliLoginError("config_update_failed", "API key must not be empty.");
  }
  const credentialStore =
    options.credentialStore ?? createSharedZCodeCredentialStore({ env: options.env });
  const configPatch = await persistStandaloneCodingPlanConnection({
    accountIdentity: createStandaloneAccountIdentityFromSecret(apiKey),
    apiKey,
    credentialStore,
    env: options.env ?? process.env,
    personalProviderConfigPath: options.personalProviderConfigPath,
    providerId: options.providerId,
  });
  return {
    configPath: configPatch.path,
    model: configPatch.mainModel,
    providerId: options.providerId,
  };
}

interface StandaloneCodingPlanPersistenceResult {
  readonly mainModel: string;
  readonly path: string;
}

async function persistStandaloneCodingPlanConnection(input: {
  readonly accountIdentity: string;
  readonly apiKey: string;
  readonly credentialStore: SharedZCodeCredentialStore;
  readonly env: EnvRecord;
  readonly personalProviderConfigPath?: string;
  readonly providerId: CodingPlanProviderId;
}): Promise<StandaloneCodingPlanPersistenceResult> {
  const configuredProvider = await resolveStandaloneCodingPlanProvider(input.providerId, input.env);
  const providerId = configuredProvider.providerId;
  const modelId = configuredProvider.modelId;
  const credentialKeys = {
    identityCredentialKey: standaloneAccountIdentityCredentialKey(providerId),
    apiKeyCredentialKey: standaloneAccountProviderCredentialKey({
      providerId,
      accountIdentity: input.accountIdentity,
    }),
  };
  // 账号身份的整组提交：identity 决定运行时用哪个账号的 Key，与 OAuth 会话版本一起比较，
  // 才能挡住「Host 刚登录了新账号、CLI 的旧响应又把 identity 改回上一个账号」。
  const credentialSnapshot = await captureStandaloneAccountSnapshot(
    input.credentialStore,
    credentialKeys,
  );
  const credentialsCommitted = await commitStandaloneAccountCredentials(
    input.credentialStore,
    credentialSnapshot,
    { ...credentialKeys, accountIdentity: input.accountIdentity, apiKey: input.apiKey },
  );
  if (!credentialsCommitted) throw supersededLoginError();
  const path =
    input.personalProviderConfigPath ??
    input.env[ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]?.trim() ??
    join(dirname(input.credentialStore.filePath), PERSONAL_PROVIDER_CONFIG_FILE_NAME);
  // 登录与运行时共享文件和事务；首次写入仍先保留旧用户 Provider，不能仅写默认值。
  const personalRepository = new NodePersonalProviderConfigRepository({
    filePath: path,
    importLegacy: () => readLegacyCliPersonalProviderConfig({}),
    pollingIntervalMs: false,
  });
  const repository = new NodeModelSelectionConfigRepository({ personalRepository });
  try {
    await repository.saveConfiguredDefault({ providerId, modelId });
  } finally {
    repository.dispose();
    personalRepository.dispose();
  }
  return {
    mainModel: `${providerId}/${modelId}`,
    path,
  };
}

/**
 * user_info 的落盘形态按 provider 分开：Host 读 zai 时按后端 data.user 原样解析，
 * 读 bigmodel 时要求归一化的 id/username/displayName。写错一侧不会报错，只会让会话恢复
 * 时「登录过却读不到 profile」，所以两种形态在这里各固定一次。
 */
function serializeLoginUserInfo(providerId: CodingPlanProviderId, user: CliOAuthUser): string {
  if (providerId === "zai") {
    return JSON.stringify(user);
  }
  const username = user.name || user.email || user.user_id;
  return JSON.stringify({
    id: user.user_id,
    username,
    displayName: username,
    rawProfile: user,
  });
}

/**
 * 快照过期 = 期间另一处登录已经提交（常见于 Desktop Host 与 CLI 同时登录）。
 * 结果整组丢弃，绝不用旧响应覆盖新会话；提示必须指向「重新登录」这个可操作动作。
 */
function supersededLoginError(): ZCodeCliLoginError {
  return new ZCodeCliLoginError(
    "credential_conflict",
    "Another sign-in updated the stored credentials during this login, so this result was discarded. " +
      "Please retry login.",
  );
}

function createOAuthClient(options: LoginZCodeCliOptions, env: EnvRecord): CliOAuthClient {
  return createCliOAuthClient({
    baseUrl:
      options.baseUrl ?? buildZCodeEndpointUrls(resolveCliZCodeEndpointOrigin(env)).apiBaseUrl,
    providerId: options.providerId ?? "zai",
    httpClient: options.httpClient ?? createDefaultHttpClient(env),
  });
}

function resolveCliZCodeEndpointOrigin(env: EnvRecord): string {
  return resolveRuntimeZCodeEndpointOrigin(env);
}

function createDefaultHttpClient(env: EnvRecord) {
  const config = createConfig({ env });
  return createNodeHttpClientAdapter({
    env,
    proxyUrl: config.config.network.httpProxy,
    noProxy: config.config.network.noProxy,
    caCertFile: config.config.network.caCertFile,
    timeoutMs: config.config.network.timeout,
  });
}

async function resolveCodingPlanApiKey(input: {
  accessToken: string;
  env: EnvRecord;
  httpClient?: Parameters<typeof createCodingPlanApiKeyResolver>[0]["httpClient"];
  family: CodingPlanProviderId;
  resolver?: ReturnType<typeof createCodingPlanApiKeyResolver>;
  signal?: AbortSignal;
}): Promise<string> {
  const resolver =
    input.resolver ??
    createCodingPlanApiKeyResolver({
      httpClient: input.httpClient ?? createDefaultHttpClient(input.env),
    });
  return resolver.resolve(
    {
      accessToken: input.accessToken,
      family: input.family,
    },
    { signal: input.signal },
  );
}
