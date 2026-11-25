// 插件配置来源投影：把 user 配置与各项目配置文件投影成 PluginConfigSources。
//
// 单独成模块的理由：合并后的 `options` 只说明「哪个 scope 声明过这个键」，而插件选项的原始层要
// 另外保留（`optionLayers`）—— 敏感选项按层叠加私有文件，且项目层 `options` 已由 config-merger
// 从 merged config 剥离，合并结果无法还原层级。读这条链路的人应当在一个地方看到全部规则。
import type { PluginOptionValues, RuntimeConfigPatch } from "@zcode/contracts";
import type { ProjectConfigFile } from "./project-config.adapter.js";

export type PluginConfigScope = "user" | "workspace";

export interface PluginOptionLayer {
  scope: PluginConfigScope;
  path: string;
  /** workspace 层配置文件的 baseDir；私有文件按它找 workspace 条目。user 层没有。 */
  workspaceRoot?: string;
  options: Record<string, PluginOptionValues>;
}

export interface PluginConfigSources {
  dirs: {
    user: string[];
    workspace: string[];
  };
  enabled: Record<string, PluginConfigScope>;
  marketplaces: Record<string, PluginConfigScope>;
  options: Record<string, Record<string, PluginConfigScope>>;
  /**
   * 插件选项的原始配置层，按优先级从低到高（user，再按发现顺序的项目配置文件）。
   * 合并后的 options 分不出值来自哪一层；敏感选项要按层叠加私有文件，所以保留原始层。
   */
  optionLayers: PluginOptionLayer[];
  paths: {
    user: string;
    workspace: string | undefined;
  };
}

export function resolvePluginConfigSources(input: {
  projectConfig: RuntimeConfigPatch;
  projectFiles: readonly ProjectConfigFile[];
  projectPath: string | undefined;
  skipUserConfig: boolean;
  userConfig: RuntimeConfigPatch;
  userPath: string;
}): PluginConfigSources {
  const enabled: Record<string, PluginConfigScope> = {};
  const marketplaces: Record<string, PluginConfigScope> = {};
  const options: Record<string, Record<string, PluginConfigScope>> = {};

  for (const pluginId of Object.keys(input.userConfig.plugins?.enabledPlugins ?? {})) {
    enabled[pluginId] = "user";
  }
  for (const pluginId of Object.keys(input.projectConfig.plugins?.enabledPlugins ?? {})) {
    enabled[pluginId] = "workspace";
  }

  for (const marketplaceId of Object.keys(input.userConfig.plugins?.extraKnownMarketplaces ?? {})) {
    marketplaces[marketplaceId] = "user";
  }
  for (const [pluginId, pluginOptions] of Object.entries(input.userConfig.plugins?.options ?? {})) {
    options[pluginId] = {};
    for (const key of Object.keys(pluginOptions)) options[pluginId][key] = "user";
  }
  for (const [pluginId, pluginOptions] of Object.entries(
    input.projectConfig.plugins?.options ?? {},
  )) {
    const sourceByKey = (options[pluginId] ??= {});
    for (const key of Object.keys(pluginOptions)) sourceByKey[key] = "workspace";
  }

  return {
    dirs: {
      user: input.userConfig.plugins?.dirs ?? [],
      workspace: input.projectConfig.plugins?.dirs ?? [],
    },
    enabled,
    marketplaces,
    options,
    optionLayers: resolvePluginOptionLayers(input),
    paths: {
      user: input.userPath,
      workspace: input.projectPath,
    },
  };
}

/**
 * 原始配置层：user 在前（调用方明确跳过用户配置时不登记，否则私有 user 值会凭空生效），
 * 项目配置文件按发现顺序在后 —— 顺序即优先级，最内层 workspace 最高。
 */
function resolvePluginOptionLayers(input: {
  projectFiles: readonly ProjectConfigFile[];
  skipUserConfig: boolean;
  userConfig: RuntimeConfigPatch;
  userPath: string;
}): PluginOptionLayer[] {
  return [
    ...(input.skipUserConfig
      ? []
      : [
          {
            options: input.userConfig.plugins?.options ?? {},
            path: input.userPath,
            scope: "user" as const,
          },
        ]),
    ...input.projectFiles.map((file) => ({
      options: file.config.plugins?.options ?? {},
      path: file.path,
      scope: "workspace" as const,
      workspaceRoot: file.baseDir,
    })),
  ];
}
