// Modified by ZCode: 自上游 zai-org/ZCode v4.0.0 (a4b44451, Apache-2.0) 并入本波安全/稳定性修复（详见 docs/development/upstream-sync.md）。
// Config Factory - Load and merge all config sources

import { resolve } from "node:path";
import type {
  ConfigPort,
  HookConfigSource,
  LoggerFactory,
  McpServerConfig,
  RuntimeConfig,
  RuntimeConfigPatch,
  WorkspaceHookBundleSnapshot,
} from "@zcode/contracts";
import {
  ConfigScope,
  DefaultRuntimeConfig,
  createWorkspaceHookBundleSnapshot,
} from "@zcode/contracts";
import {
  buildWorkspaceHookBundleSnapshot,
  readWorkspaceHookScriptStates,
  resolveWorkspaceHookRuntimeRoot,
  type WorkspaceHookRuntimeRoot,
  type WorkspaceHookScriptState,
} from "@zcode/shared/workspace-hook-discovery";
import { createConfigPort } from "./index.js";
import { loadFileConfig, getDefaultConfigPath, type LoadedConfig } from "./file-config.adapter.js";
import { parseEnvConfig } from "./env-config.adapter.js";
import { mergeConfigs, createPrioritizedConfig } from "./config-merger.js";
import { createNodeLoggerFactory } from "../logging/index.js";
import {
  loadProjectConfigFile,
  loadProjectConfigs,
  summarizeProjectConfigs,
  type ProjectConfigDiscovery,
  type ProjectConfigFile,
} from "./project-config.adapter.js";
import { resolvePluginConfigSources, type PluginConfigSources } from "./plugin-config-sources.js";

export type {
  PluginConfigScope,
  PluginConfigSources,
  PluginOptionLayer,
} from "./plugin-config-sources.js";

export interface ConfigFactoryOptions {
  /** Path to user config file (default: ~/.zcode/cli/config.json) */
  userConfigPath?: string;
  /** Path to project config file */
  projectConfigPath?: string;
  /** Working directory used to discover project config files */
  workingDirectory?: string;
  /** Opaque workspace identity supplied by the existing Host resolver; local callers fall back to workspacePath. */
  workspaceIdentity?: string;
  /** Environment variables (default: process.env) */
  env?: Record<string, string | undefined>;
  /** CLI overrides (highest priority) */
  cliOverrides?: RuntimeConfigPatch;
  /** Skip loading user config file */
  skipUserConfig?: boolean;
  /** Optional logger factory for tests or embedding runtimes. Defaults to the node JSONL logger. */
  loggerFactory?: LoggerFactory;
}

export interface ConfigResult {
  configPort: ConfigPort;
  config: RuntimeConfig;
  sources: {
    user: {
      diagnostics: LoadedConfig["diagnostics"];
      path: string;
      loaded: boolean;
      hasMcpServers: boolean;
      hasUiLocale: boolean;
      hasUiTheme: boolean;
      mcpServerNames: string[];
    };
    project: {
      diagnostics: LoadedConfig["diagnostics"];
      path: string | undefined;
      paths: string[];
      loaded: boolean;
      hasUiLocale: boolean;
      hasUiTheme: boolean;
      hasMcpServers: boolean;
      mcpServerNames: string[];
      uiLocalePath: string | undefined;
      uiThemePath: string | undefined;
      workspaceHookSnapshot?: WorkspaceHookBundleSnapshot;
      /**
       * 审核请求与「审核中 toggle」曾各自推导 runtimeRoot（前者遍历
       * default/user/project/env/cli 全部层，后者只读单层 runtimeConfig.hooks），
       * 两者只要有一处不同就产生不同 bundleDigest，toggle 会被误判为
       * workspace_hooks_snapshot_mismatch。这里导出快照实际使用的 runtimeRoot，
       * 让下游复用同一个值，把一致性变成结构性约束而不是巧合。
       */
      workspaceHookRuntimeRoot?: WorkspaceHookRuntimeRoot;
    };
    plugins: PluginConfigSources;
    mcp: {
      serverSources: Record<string, McpServerConfigSource>;
    };
    env: boolean;
    cli: boolean;
  };
}

type OptionalPathLoadedConfig = Omit<LoadedConfig, "path"> & {
  path: string | undefined;
};

export type McpServerConfigSource = "system" | "project" | "user" | "env" | "cli";

/**
 * Create ConfigPort with all sources merged
 *
 * Priority (lowest to highest):
 * 1. System defaults
 * 2. User config file (~/.zcode/cli/config.json)
 * 3. Project config files (root to cwd, then explicit projectConfigPath)
 * 4. Environment variables (ZCODE_*)
 * 5. CLI overrides
 */
export function createConfig(options: ConfigFactoryOptions = {}): ConfigResult {
  return assembleConfig(options, discoverProjectConfigs(options), undefined);
}

/**
 * 异步配置装配入口（D24 / ZP-20261110-06）：先读取可识别入口脚本的内容状态，再用与同步入口
 * 完全相同的装配公式生成快照，使 declaration digest 覆盖入口脚本内容。
 *
 * 为什么必须与同步入口成对存在：同步 createConfig 拿不到脚本状态，只能保持引入内容绑定之前
 * 的摘要（否则升级会让既有 Trust 一次性失效）；而 Review 授权、运行时准入与 Settings 显示
 * 必须共用同一份摘要，否则同一工作区会在不同入口出现 bound / unbound 两种 bundleDigest，
 * toggle 恒报 workspace_hooks_bundle_changed、授权后永不匹配。生产运行时（create-app）走
 * 本函数，同步 createConfig 保留给不参与 Hook 信任的装配调用方。
 */
export async function createConfigAsync(
  options: ConfigFactoryOptions = {},
): Promise<ConfigResult> {
  const discovery = discoverProjectConfigs(options);
  const workspacePath = resolve(options.workingDirectory ?? process.cwd());
  // 与快照使用同一批 sources：reviewItemId 才能一一对应，映射不完整会被记成 unverifiable。
  const scriptStates = await readWorkspaceHookScriptStates({
    workspacePath,
    sources: discovery.hookCandidates,
  });
  return assembleConfig(options, discovery, scriptStates);
}

/**
 * 项目配置发现（含 Hook 候选占位）只有一份实现：异步入口要先拿到 sources 读脚本状态，
 * 再交给同一装配函数，避免两条装配路径各自发现一次而出现顺序或占位差异。
 */
function discoverProjectConfigs(options: ConfigFactoryOptions): ProjectConfigDiscovery {
  return options.workingDirectory
    ? loadProjectConfigs(options.workingDirectory, options.projectConfigPath)
    : options.projectConfigPath
      ? summarizeProjectConfigs([
          loadProjectConfigFile(options.projectConfigPath, {
            discoveryOrder: 0,
            explicitProjectConfig: true,
          }),
        ])
      : summarizeProjectConfigs([]);
}

function assembleConfig(
  options: ConfigFactoryOptions,
  discoveredProjectConfigs: ProjectConfigDiscovery,
  /** 缺省表示拿不到脚本状态（同步入口）：条目不带 scriptEntry，摘要与内容绑定前逐字节相同。 */
  workspaceHookScriptStates: ReadonlyMap<string, WorkspaceHookScriptState> | undefined,
): ConfigResult {
  // 1. System defaults
  const configs: ReturnType<typeof createPrioritizedConfig>[] = [
    createPrioritizedConfig(DefaultRuntimeConfig, ConfigScope.System),
  ];

  // 2. User config file
  const userConfigResult: LoadedConfig = options.skipUserConfig
    ? { config: {}, diagnostics: [], path: getDefaultConfigPath(), loaded: false }
    : loadFileConfig(options.userConfigPath);

  if (userConfigResult.loaded) {
    configs.push(
      createPrioritizedConfig(
        withHookConfigSource(userConfigResult.config, {
          kind: "user",
          path: userConfigResult.path,
        }),
        ConfigScope.User,
      ),
    );
  }

  // 3. Project config files（发现结果由调用方传入，见 discoverProjectConfigs）
  // explicit 配置曾在 auto-discovery 之后手工追加并自行编号，绕过 shared
  // canonical-path dedup；同一文件会进入 snapshot 两次并使既有 Trust 全部 stale。
  // 修法：有 workspace 时由 loadProjectConfigs 统一走 discoverWorkspaceHookConfigPaths，
  // 去重、失败候选占位和 discoveryOrder 均与 Settings builder 同源。
  const projectConfigFiles = discoveredProjectConfigs.files;
  const projectSummary = discoveredProjectConfigs;
  const projectDiagnostics = discoveredProjectConfigs.diagnostics;
  // 配置 diagnostics 过去只返回给调用方，用户导出日志时看不到加载失败或被跳过的 MCP server。
  // 在汇总入口统一写 warn，保留具体文件路径和 JSON path，方便定位迁移配置问题。
  logConfigDiagnostics({
    env: options.env,
    loggerFactory: options.loggerFactory,
    projectDiagnostics,
    userDiagnostics: userConfigResult.diagnostics,
  });
  const projectConfigResult: OptionalPathLoadedConfig =
    summarizeOptionalProjectConfig(projectConfigFiles);
  const projectUiLocalePath = [...projectConfigFiles]
    .reverse()
    .find((file) => file.config.ui?.locale !== undefined)?.path;
  const projectUiThemePath = [...projectConfigFiles]
    .reverse()
    .find((file) => file.config.ui?.theme !== undefined)?.path;

  for (const projectConfig of projectConfigFiles) {
    configs.push(createPrioritizedConfig(projectConfig.config, ConfigScope.Project));
  }

  // 4. Environment variables
  const envConfig = parseEnvConfig(options.env ?? process.env);
  if (Object.keys(envConfig).length > 0) {
    configs.push(
      createPrioritizedConfig(
        withHookConfigSource(envConfig, { kind: "internal" }),
        ConfigScope.Env,
      ),
    );
  }

  // 5. CLI overrides (applied last = highest priority)
  if (options.cliOverrides) {
    configs.push(
      createPrioritizedConfig(
        withHookConfigSource(options.cliOverrides, { kind: "internal" }),
        ConfigScope.Cli,
      ),
    );
  }

  const workspaceHookRuntimeRoot = resolveWorkspaceHookRuntimeRoot([
    DefaultRuntimeConfig.hooks,
    userConfigResult.config.hooks,
    ...projectSummary.hookCandidates.map((candidate) => candidate.hooks),
    envConfig.hooks,
    options.cliOverrides?.hooks,
  ]);
  const workspacePath = resolve(options.workingDirectory ?? process.cwd());
  const workspaceHookSnapshotData = buildWorkspaceHookBundleSnapshot({
    workspaceIdentity: options.workspaceIdentity?.trim() || workspacePath,
    workspacePath,
    sources: projectSummary.hookCandidates,
    runtimeRoot: workspaceHookRuntimeRoot,
    // 同步入口不传：条目不带 scriptEntry，摘要保持与引入内容绑定之前逐字节相同。
    ...(workspaceHookScriptStates ? { scriptStates: workspaceHookScriptStates } : {}),
  });
  const workspaceHookSnapshot = workspaceHookSnapshotData
    ? createWorkspaceHookBundleSnapshot(workspaceHookSnapshotData)
    : undefined;

  // Project Hook events stay outside this executable merge. The snapshot above is the only
  // Phase 1 side-channel and cannot be consumed by configured-runner.
  const merged = mergeConfigs(...configs);
  const pluginConfigSources = resolvePluginConfigSources({
    projectConfig: projectConfigResult.config,
    projectFiles: projectConfigFiles,
    projectPath: projectConfigResult.path,
    skipUserConfig: options.skipUserConfig === true,
    userConfig: userConfigResult.config,
    userPath: userConfigResult.path,
  });
  const mcpServerResolution = resolveEffectiveMcpServers({
    cliOverrides: options.cliOverrides,
    envConfig,
    projectConfig: projectConfigResult.config,
    userConfig: userConfigResult.config,
  });
  merged.mcp = {
    ...merged.mcp,
    servers: mcpServerResolution.servers,
  };

  // Create ConfigPort with merged config
  const configPort = createConfigPort(merged);

  return {
    configPort,
    config: configPort.getAll(),
    sources: {
      user: {
        diagnostics: userConfigResult.diagnostics,
        path: userConfigResult.path,
        loaded: userConfigResult.loaded,
        hasMcpServers: userConfigResult.config.mcp?.servers !== undefined,
        hasUiLocale: userConfigResult.config.ui?.locale !== undefined,
        hasUiTheme: userConfigResult.config.ui?.theme !== undefined,
        mcpServerNames: Object.keys(userConfigResult.config.mcp?.servers ?? {}),
      },
      project: {
        diagnostics: projectDiagnostics,
        path: projectConfigResult.path,
        paths: projectSummary.paths,
        loaded: projectConfigResult.loaded,
        hasUiLocale: projectConfigResult.config.ui?.locale !== undefined,
        hasUiTheme: projectConfigResult.config.ui?.theme !== undefined,
        hasMcpServers: projectConfigResult.config.mcp?.servers !== undefined,
        mcpServerNames: projectSummary.mcpServerNames,
        uiLocalePath: projectUiLocalePath,
        uiThemePath: projectUiThemePath,
        ...(workspaceHookSnapshot ? { workspaceHookSnapshot } : {}),
        workspaceHookRuntimeRoot,
      },
      plugins: pluginConfigSources,
      mcp: {
        serverSources: mcpServerResolution.sources,
      },
      env: Object.keys(envConfig).length > 0,
      cli: !!options.cliOverrides,
    },
  };
}

function withHookConfigSource(
  config: RuntimeConfigPatch,
  source: HookConfigSource,
): RuntimeConfigPatch {
  if (!config.hooks?.events) return config;
  return {
    ...config,
    hooks: {
      ...config.hooks,
      events: Object.fromEntries(
        Object.entries(config.hooks.events).map(([eventName, matchers]) => [
          eventName,
          matchers?.map((matcher) => ({
            ...matcher,
            hooks: matcher.hooks.map((hook) => ({ ...hook, source: hook.source ?? source })),
          })),
        ]),
      ) as NonNullable<RuntimeConfigPatch["hooks"]>["events"],
    },
  };
}

export function resolveWorkspaceStorageDir(input: {
  env?: Record<string, string | undefined>;
  workingDirectory: string;
}): string {
  const baseStorageDir = createConfig({ env: input.env }).config.storage.dir;
  const projectConfig = loadProjectConfigs(input.workingDirectory);
  let projectStorageDir: string | undefined;
  for (const file of projectConfig.files) {
    projectStorageDir = file.config.storage?.dir ?? projectStorageDir;
  }
  const envStorageDir = parseEnvConfig(input.env ?? process.env).storage?.dir;
  return envStorageDir ?? projectStorageDir ?? baseStorageDir;
}

function resolveEffectiveMcpServers(input: {
  cliOverrides?: RuntimeConfigPatch;
  envConfig: RuntimeConfigPatch;
  projectConfig: RuntimeConfigPatch;
  userConfig: RuntimeConfigPatch;
}): {
  servers: Record<string, McpServerConfig>;
  sources: Record<string, McpServerConfigSource>;
} {
  const servers: Record<string, McpServerConfig> = {};
  const sources: Record<string, McpServerConfigSource> = {};
  const apply = (source: McpServerConfigSource, patch: RuntimeConfigPatch | undefined) => {
    for (const [name, server] of Object.entries(patch?.mcp?.servers ?? {})) {
      servers[name] = server;
      sources[name] = source;
    }
  };

  apply("system", DefaultRuntimeConfig);
  // MCP server discovery has an extension-specific rule: user config shadows project config.
  // This does not change the global config precedence for model/permission/UI fields.
  apply("project", input.projectConfig);
  apply("user", input.userConfig);
  apply("env", input.envConfig);
  apply("cli", input.cliOverrides);
  return { servers, sources };
}

function logConfigDiagnostics(input: {
  env?: Record<string, string | undefined>;
  loggerFactory?: LoggerFactory;
  projectDiagnostics: LoadedConfig["diagnostics"];
  userDiagnostics: LoadedConfig["diagnostics"];
}): void {
  const diagnostics = [
    ...input.userDiagnostics.map((diagnostic) => ({ ...diagnostic, configScope: "user" })),
    ...input.projectDiagnostics.map((diagnostic) => ({ ...diagnostic, configScope: "project" })),
  ];
  if (diagnostics.length === 0) return;

  const loggerFactory = input.loggerFactory ?? createNodeLoggerFactory({ env: input.env });
  const logger = loggerFactory.createLogger("zcode").child({
    module: "adapters.config",
  });

  for (const diagnostic of diagnostics) {
    logger.warn(resolveConfigDiagnosticLogMessage(diagnostic.code), {
      configPath: diagnostic.filePath,
      configScope: diagnostic.configScope,
      diagnosticCode: diagnostic.code,
      diagnosticMessage: diagnostic.message,
      diagnosticPath: diagnostic.path,
      event: resolveConfigDiagnosticLogEvent(diagnostic.code),
      severity: diagnostic.severity,
    });
  }
}

function resolveConfigDiagnosticLogMessage(
  code: LoadedConfig["diagnostics"][number]["code"],
): string {
  if (code === "config_mcp_server_invalid") return "MCP server config skipped";
  if (code === "config_project_hooks_pending_trust") {
    return "Project hooks pending workspace trust";
  }
  if (code === "config_project_plugin_options_ignored") {
    return "Project plugin options ignored";
  }
  return "Config file failed to load";
}

function resolveConfigDiagnosticLogEvent(
  code: LoadedConfig["diagnostics"][number]["code"],
): string {
  if (code === "config_mcp_server_invalid") return "config.mcp_server.skipped";
  if (code === "config_project_hooks_pending_trust") {
    return "config.project_hooks.pending_trust";
  }
  if (code === "config_project_plugin_options_ignored") {
    return "config.plugin_options.project_ignored";
  }
  return "config.file.invalid";
}

function summarizeOptionalProjectConfig(files: ProjectConfigFile[]): OptionalPathLoadedConfig {
  if (files.length === 0) {
    return { config: {}, diagnostics: [], path: undefined, loaded: false };
  }

  const path = files[files.length - 1]?.path;
  const config = mergeConfigs(
    ...files.map((file) => createPrioritizedConfig(file.config, ConfigScope.Project)),
  );

  return {
    config,
    diagnostics: files.flatMap((file) => file.diagnostics),
    path,
    loaded: true,
  };
}
