// Config Merger - Merge configs by priority

import type {
  HookEventName,
  HookMatcherConfig,
  PluginOptionValues,
  RuntimeConfigPatch,
} from "@zcode/contracts";
import { ConfigScope, ConfigScopePriority } from "@zcode/contracts";

type PluginOptions = Record<string, PluginOptionValues>;

/**
 * Config source with priority info
 */
interface PrioritizedConfig {
  config: RuntimeConfigPatch;
  scope: ConfigScope;
  priority: number;
}

/**
 * 每个顶层字段的嵌套合并策略：低优先级层提供默认值，高优先级层只覆盖自己声明的键。
 *
 * 为什么必须逐字段合并：`RuntimeConfigPatch` 的顶层字段全部是对象，而实际每一层通常只声明
 * 其中一两个键 —— Desktop 新建会话只传 `permission.mode`（bootstrap 的
 * createConfigCliOverrides），环境变量层只传 `network.httpProxy` / `storage.dir`。旧实现先
 * `Object.assign(result, config)` 再展开 `result.<key>`，展开时的来源已经是本层的值，低优先级
 * 层的其余键被静默丢弃：用户的 `permission.disallowedTools`、`network.caCertFile`、
 * `storage.sessionDbPath`、`ui.theme` 都会回到默认值，界面没有任何提示。
 *
 * `Record<keyof RuntimeConfigPatch, ...>` 是穷尽性护栏：`RuntimeConfigPatch` 新增顶层字段而
 * 未在此登记策略时 typecheck 直接失败，新字段不会静默退回「整层覆盖」。
 */
// Modified by ZCode: 嵌套字段合并自上游 v4.0.0 (a4b44451, Apache-2.0) 的 skillOverrides/commandOverrides
// 修复扩展开来 —— 16 个顶层字段全部逐键合并，否则高优先级层只声明一个键就会把低层整层替换掉。
const NESTED_FIELD_MERGERS: Record<
  keyof RuntimeConfigPatch,
  (previous: RuntimeConfigPatch, next: RuntimeConfigPatch) => object | undefined
> = {
  commandOverrides: (previous, next) =>
    next.commandOverrides ? { ...previous.commandOverrides, ...next.commandOverrides } : undefined,
  features: (previous, next) =>
    next.features ? { ...previous.features, ...next.features } : undefined,
  hooks: (previous, next) =>
    next.hooks ? mergeHooksConfig(previous.hooks, next.hooks) : undefined,
  logging: (previous, next) => (next.logging ? { ...previous.logging, ...next.logging } : undefined),
  mcp: (previous, next) =>
    next.mcp
      ? {
          ...previous.mcp,
          ...next.mcp,
          servers: { ...previous.mcp?.servers, ...next.mcp.servers },
        }
      : undefined,
  memory: (previous, next) => (next.memory ? { ...previous.memory, ...next.memory } : undefined),
  modelAnomalyGuard: (previous, next) =>
    next.modelAnomalyGuard
      ? { ...previous.modelAnomalyGuard, ...next.modelAnomalyGuard }
      : undefined,
  modelStream: (previous, next) =>
    next.modelStream ? { ...previous.modelStream, ...next.modelStream } : undefined,
  network: (previous, next) => (next.network ? { ...previous.network, ...next.network } : undefined),
  permission: (previous, next) =>
    next.permission ? { ...previous.permission, ...next.permission } : undefined,
  plugins: (previous, next) =>
    next.plugins ? mergePluginsConfig(previous.plugins, next.plugins) : undefined,
  skillOverrides: (previous, next) =>
    next.skillOverrides ? { ...previous.skillOverrides, ...next.skillOverrides } : undefined,
  skills: (previous, next) => (next.skills ? { ...previous.skills, ...next.skills } : undefined),
  storage: (previous, next) => (next.storage ? { ...previous.storage, ...next.storage } : undefined),
  toolConcurrency: (previous, next) =>
    next.toolConcurrency ? { ...previous.toolConcurrency, ...next.toolConcurrency } : undefined,
  ui: (previous, next) => (next.ui ? { ...previous.ui, ...next.ui } : undefined),
};

/**
 * Merge multiple configs by scope priority
 * Lower priority = applied first, higher priority = applied last (overwrites)
 */
export function mergeConfigs(...configs: PrioritizedConfig[]): RuntimeConfigPatch {
  // Sort by priority (ascending)
  const sorted = [...configs].sort((a, b) => a.priority - b.priority);

  let result: RuntimeConfigPatch = {};

  for (const { config, scope } of sorted) {
    result = mergeConfigLayer(result, prepareLayerConfig(config, scope));
  }

  return result;
}

/**
 * 按来源剥掉不允许进入 merged RuntimeConfig 的项目层字段。
 */
function prepareLayerConfig(config: RuntimeConfigPatch, scope: ConfigScope): RuntimeConfigPatch {
  if (scope !== ConfigScope.Project || !config.plugins) return config;
  // Marketplace 是 Host User inventory 的目录配置，不属于 Workspace 项目配置。
  // 保留 schema 兼容旧文件，但不能让项目层字段进入 merged RuntimeConfig/catalog。
  const projectPlugins = { ...config.plugins };
  delete projectPlugins.extraKnownMarketplaces;
  return { ...config, plugins: projectPlugins };
}

/**
 * 合并一层配置：标量/数组按键整体覆盖，嵌套对象走 `NESTED_FIELD_MERGERS` 逐字段覆盖。
 */
function mergeConfigLayer(
  previous: RuntimeConfigPatch,
  next: RuntimeConfigPatch,
): RuntimeConfigPatch {
  const merged: RuntimeConfigPatch = { ...previous, ...next };
  for (const key of Object.keys(NESTED_FIELD_MERGERS) as (keyof RuntimeConfigPatch)[]) {
    const value = NESTED_FIELD_MERGERS[key](previous, next);
    // 本层没有声明该字段时 `merged` 已经保留低优先级层的值，不能改写成 undefined。
    if (value !== undefined) Object.assign(merged, { [key]: value });
  }
  return merged;
}

/**
 * 合并两层的 plugins 配置。
 *
 * Workspace Plugin 配置和 User Plugin 配置共用同一个 RuntimeConfig，不能让后一个 `plugins`
 * 对象整体覆盖前一个来源；否则 Workspace 只声明一个插件时会丢掉 User 的其它启用项和 options。
 * enabledPlugins 按 pluginId、options 按 pluginId/option key 合并，dirs 保留两层候选根目录，
 * 最终 resolver 再做去重和路径校验。
 */
function mergePluginsConfig(
  previous: RuntimeConfigPatch["plugins"],
  next: NonNullable<RuntimeConfigPatch["plugins"]>,
): NonNullable<RuntimeConfigPatch["plugins"]> {
  return {
    ...previous,
    ...next,
    ...(next.dirs
      ? { dirs: [...new Set([...(previous?.dirs ?? []), ...next.dirs])] }
      : {}),
    ...(next.enabledPlugins
      ? {
          enabledPlugins: {
            ...previous?.enabledPlugins,
            ...next.enabledPlugins,
          },
        }
      : {}),
    ...(next.extraKnownMarketplaces
      ? {
          extraKnownMarketplaces: {
            ...previous?.extraKnownMarketplaces,
            ...next.extraKnownMarketplaces,
          },
        }
      : {}),
    ...(next.options
      ? { options: mergePluginOptions(previous?.options, next.options) }
      : {}),
  };
}

function mergePluginOptions(
  current: PluginOptions | undefined,
  next: PluginOptions,
): PluginOptions {
  const merged: PluginOptions = { ...current };
  for (const [pluginId, options] of Object.entries(next)) {
    merged[pluginId] = {
      ...merged[pluginId],
      ...options,
    };
  }
  return merged;
}

function mergeHooksConfig(
  current: RuntimeConfigPatch["hooks"],
  next: NonNullable<RuntimeConfigPatch["hooks"]>,
): NonNullable<RuntimeConfigPatch["hooks"]> {
  const events: Partial<Record<HookEventName, HookMatcherConfig[]>> = {
    ...current?.events,
  };

  // project hooks 不能整体覆盖 user hooks，空的 project `enabled:false` 也不能
  // 关闭 user hooks。每个配置文件只控制自己的事件，因此仅在该来源启用时追加事件，
  // effective enabled 由任一已启用来源决定。
  if (next.enabled !== false) {
    for (const [eventName, matchers] of Object.entries(next.events ?? {}) as Array<
      [HookEventName, HookMatcherConfig[]]
    >) {
      if (!matchers) continue;
      events[eventName] = [...(events[eventName] ?? []), ...matchers];
    }
  }

  return {
    ...current,
    ...next,
    enabled: current?.enabled === true || next.enabled === true,
    events,
  };
}

/**
 * Get priority for a config scope
 */
export function getScopePriority(scope: ConfigScope): number {
  return ConfigScopePriority[scope];
}

/**
 * Create a prioritized config entry
 */
export function createPrioritizedConfig(
  config: RuntimeConfigPatch,
  scope: ConfigScope,
): PrioritizedConfig {
  return {
    config,
    scope,
    priority: getScopePriority(scope),
  };
}
