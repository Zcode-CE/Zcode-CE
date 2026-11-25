import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { McpServerConfig, RuntimeConfigPatch } from "@zcode/contracts";
import {
  createWorkspaceHookSourceInput,
  discoverWorkspaceHookConfigPaths,
  workspaceHooksConfigSchema,
  type WorkspaceHookSourceInput,
} from "@zcode/shared/workspace-hook-discovery";
import { loadFileConfig, type LoadedConfig } from "./file-config.adapter.js";

const CURRENT_DIRECTORY = ".";

export interface ProjectConfigFile {
  baseDir: string;
  config: RuntimeConfigPatch;
  diagnostics: LoadedConfig["diagnostics"];
  hookCandidate?: WorkspaceHookSourceInput;
  loaded: boolean;
  path: string;
}

export interface ProjectConfigDiscovery {
  files: ProjectConfigFile[];
  diagnostics: LoadedConfig["diagnostics"];
  hookCandidates: WorkspaceHookSourceInput[];
  loaded: boolean;
  paths: string[];
  mcpServerNames: string[];
}

export function loadProjectConfigs(
  workingDirectory?: string,
  explicitProjectConfigPath?: string,
): ProjectConfigDiscovery {
  const resolvedWorkingDirectory = resolve(workingDirectory ?? process.cwd());
  const files = discoverWorkspaceHookConfigPaths({
    workingDirectory: resolvedWorkingDirectory,
    ...(explicitProjectConfigPath ? { explicitProjectConfigPath } : {}),
  }).map((ref, discoveryOrder) =>
    loadProjectConfigFile(ref.path, {
      discoveryOrder,
      explicitProjectConfig: ref.explicitProjectConfig,
      workingDirectory: resolvedWorkingDirectory,
    }),
  );

  return summarizeProjectConfigs(files);
}

export function loadProjectConfigFile(
  path: string,
  options: {
    discoveryOrder?: number;
    explicitProjectConfig?: boolean;
    workingDirectory?: string;
  } = {},
): ProjectConfigFile {
  const result = loadFileConfig(path);
  const baseDir = getProjectConfigBaseDir(result.path);
  const diagnostics = [...result.diagnostics];
  const hooks = result.loaded ? result.config.hooks : undefined;
  const config = result.loaded ? normalizeProjectConfig(result.config, baseDir) : {};

  // 项目层 plugins.options 已由 config-merger 从 merged config 剥离（理由见那里的注释）。
  // 装载时记一条诊断，让「写了项目选项但不生效」有可查原因，而不是静默消失；诊断只报字段
  // 路径，不回显任何选项值。
  if (hasDeclaredPluginOptions(config)) {
    diagnostics.push({
      code: "config_project_plugin_options_ignored",
      filePath: result.path,
      message:
        "Project plugin options are ignored; save workspace plugin options in plugin settings instead",
      path: "plugins.options",
      severity: "warning",
    });
  }

  if (hooks) {
    diagnostics.push({
      code: "config_project_hooks_pending_trust",
      filePath: result.path,
      message: "Project hooks are pending workspace trust and remain blocked",
      path: "hooks",
      severity: "warning",
    });
  }

  return {
    baseDir,
    config,
    diagnostics,
    ...(hooks
      ? {
          hookCandidate: createWorkspaceHookSourceInput({
            path: result.path,
            workingDirectory: resolve(options.workingDirectory ?? baseDir),
            // hooks 字段已由 loadFileConfig 经 ZCodeConfigFileSchema（shared 单源
            // schema）完成运行时校验；这里的 parse 仅做类型桥接——HooksRuntimeConfigPatch
            // 与 WorkspaceHooksConfig 是两个领域类型（执行 side vs 配置 side，字段语义有
            // 微差），不共享 TS 结构。禁止改成 as 断言绕过校验。
            hooks: workspaceHooksConfigSchema.parse(hooks),
            discoveryOrder: options.discoveryOrder ?? 0,
            explicitProjectConfig: options.explicitProjectConfig,
          }),
        }
      : {}),
    loaded: result.loaded,
    path: result.path,
  };
}

export function summarizeProjectConfigs(files: ProjectConfigFile[]): ProjectConfigDiscovery {
  const loadedFiles = files.filter((file) => file.loaded);
  const mcpServerNames = new Set<string>();

  for (const file of loadedFiles) {
    for (const name of Object.keys(file.config.mcp?.servers ?? {})) {
      mcpServerNames.add(name);
    }
  }

  return {
    diagnostics: files.flatMap((file) => file.diagnostics),
    files: loadedFiles,
    hookCandidates: loadedFiles.flatMap((file) => (file.hookCandidate ? [file.hookCandidate] : [])),
    loaded: loadedFiles.length > 0,
    paths: loadedFiles.map((file) => file.path),
    mcpServerNames: [...mcpServerNames],
  };
}

/** 项目配置文件是否声明了插件选项（都会被剥离，所以要给出可诊断的原因）。 */
function hasDeclaredPluginOptions(config: RuntimeConfigPatch): boolean {
  for (const pluginOptions of Object.values(config.plugins?.options ?? {})) {
    if (Object.keys(pluginOptions).length > 0) return true;
  }
  return false;
}

function getProjectConfigBaseDir(path: string): string {
  const configDirectory = dirname(path);
  return basename(configDirectory) === ".zcode" ? dirname(configDirectory) : configDirectory;
}

function normalizeProjectConfig(config: RuntimeConfigPatch, baseDir: string): RuntimeConfigPatch {
  const normalized: RuntimeConfigPatch = config.hooks
    ? (() => {
        const { hooks: _hooks, ...safeConfig } = config;
        // Project Hook declarations are retained only in the immutable candidate side-channel.
        // The executable RuntimeConfigPatch remains hook-free until a later admission phase.
        return safeConfig;
      })()
    : { ...config };

  if (!normalized.mcp?.servers) return normalized;

  return {
    ...normalized,
    mcp: {
      ...normalized.mcp,
      servers: Object.fromEntries(
        Object.entries(normalized.mcp.servers).map(([name, server]) => [
          name,
          normalizeProjectMcpServer(server, baseDir),
        ]),
      ),
    },
  };
}

function normalizeProjectMcpServer(server: McpServerConfig, baseDir: string): McpServerConfig {
  if (server.type !== "stdio") return server;

  const cwd = server.cwd ?? CURRENT_DIRECTORY;
  return {
    ...server,
    cwd: isAbsolute(cwd) ? cwd : resolve(baseDir, cwd),
  };
}
