// Modified by ZCode: 自上游 zai-org/ZCode v4.0.0 (a4b44451, Apache-2.0) 的
// apps/zcode-cli/packages/bootstrap/src/plugin-secrets.ts 搬运；读取路径改为同步以匹配 CE 的同步插件解析链。
//
// 敏感插件选项的私有存储：读取时把私有文件叠加到配置视图，保存、重置、卸载时维护。
//
// 语义（参照上游 docs/design/v2/plugin-compat.md「Sensitive Option Storage」）：
// - 敏感键不进 config.json；workspace 作用域的全部插件选项也不进项目配置文件；
// - 私有文件与 `plugins/` 同级、按 workspace root 隔离，复用 @zcode/shared/node 的文件锁与
//   原子写（0600）；
// - 读不出（损坏 / I/O 失败）时按空处理并给出 `plugin_secrets_unreadable` 诊断，不静默降级；
// - 项目层 `plugins.options` 已由 mergeConfigs 剥离，这里也不作为任何值的来源（不回退读取）；
//   旧的项目层选项不自动迁移 —— 理由见 adapters/src/config/config-merger.ts 的注释。
//
// 文件 I/O、schema 与按层解析都在 adapters/src/config/plugin-secrets.adapter.ts；
// 这里只负责保存策略与配置来源投影。
import {
  readPluginOptionsFromFileConfig,
  removePluginSecrets,
  resolvePluginSecretOverrides,
  readPluginSecretsFileSync,
  setPluginSecrets,
  updatePluginOptionsInFileConfig,
  updatePluginSecretsFile,
  type ConfigResult,
  type PluginSecretsFile,
  type PluginSecretsScope,
} from "@zcode/adapters/config";
import type {
  Logger,
  PluginDiagnostic,
  PluginMetadata,
  PluginOptionValues,
} from "@zcode/contracts";

const PLUGIN_SECRETS_UNREADABLE_CODE = "plugin_secrets_unreadable";
const PLUGIN_SECRETS_UNREADABLE_MESSAGE =
  "Plugin private options file is unreadable; stored plugin options are ignored until they are saved again";

type PluginOptionValuesInput = Record<string, string | number | boolean>;

export { resolvePluginSecretsPath } from "@zcode/adapters/config";

/**
 * 读取私有文件并叠加到配置视图。读不出时按空处理，返回不含值的诊断。
 *
 * 同步实现：CE 的插件解析链（resolveZCodePlugins、app 启动、协议投影）全是同步函数，
 * 读取改成 async 会把 CLI/协议/启动链一并拉成 async；私有文件的写入是原子 rename，
 * 读者只会看到旧文件或新文件，所以这里不需要拿锁。
 */
export function withPluginSecrets(
  configResult: ConfigResult,
  secretsPath: string,
  logger?: Pick<Logger, "warn">,
): { configResult: ConfigResult; diagnostics: PluginDiagnostic[] } {
  const read = readPluginSecretsFileSync(secretsPath);
  if (read.status === "ok") {
    return { configResult: applyPluginSecrets(configResult, read.file), diagnostics: [] };
  }
  logger?.warn("Plugin private options file is unreadable", {
    event: "plugins.secrets.unreadable",
    module: "bootstrap.plugins",
    path: secretsPath,
    reason: read.reason,
  });
  return {
    configResult: applyPluginSecrets(configResult, read.file),
    diagnostics: [
      {
        code: PLUGIN_SECRETS_UNREADABLE_CODE,
        message: PLUGIN_SECRETS_UNREADABLE_MESSAGE,
        path: secretsPath,
        severity: "error",
      },
    ],
  };
}

/**
 * 按层叠加：user 私有文件优先于用户配置旧值；workspace 只读私有值，scope 之间的优先级不变
 * （user < 项目配置文件按发现顺序，最内层 workspace 最高）。
 *
 * 只重算私有文件里出现过的键，其余键沿用合并结果；重算只读原始层，所以对同一视图重复叠加
 * 结果不变。
 */
export function applyPluginSecrets(
  configResult: ConfigResult,
  file: PluginSecretsFile,
): ConfigResult {
  const overrides = resolvePluginSecretOverrides(
    configResult.sources.plugins.optionLayers ?? [],
    file,
  );
  if (overrides.length === 0) return configResult;
  const options = { ...configResult.config.plugins.options };
  const optionSources = { ...configResult.sources.plugins.options };
  for (const { pluginId, key, value, scope } of overrides) {
    options[pluginId] = { ...options[pluginId], [key]: value };
    optionSources[pluginId] = { ...optionSources[pluginId], [key]: scope };
  }
  return {
    ...configResult,
    config: {
      ...configResult.config,
      plugins: { ...configResult.config.plugins, options },
    },
    sources: {
      ...configResult.sources,
      plugins: { ...configResult.sources.plugins, options: optionSources },
    },
  };
}

export interface SavePluginOptionsInput {
  clearOptionKeys: readonly string[];
  configPath: string;
  options: PluginOptionValuesInput;
  plugin: Pick<PluginMetadata, "id" | "userConfig">;
  scope: PluginSecretsScope;
  secretsPath: string;
}

/**
 * configure 的写入：全部 workspace 选项与 user 敏感键进私有文件，user 普通键进 config.json。
 *
 * - 迁移：仅 user config.json 的旧明文敏感键迁走，包括这次请求没带的键。
 *   UI 不回传敏感值，只保存普通键的请求里本来就没有已存的 secret；只迁请求里的键会让旧明文
 *   永远留在文件里。
 * - 先写私有文件，再改 config.json：第二步失败时两处都有值，读取以私有文件为准，不会丢值。
 * - 写 user 普通键时删掉私有文件里的同名键：清单把敏感键改回普通后，旧私有值不能盖住新值。
 * - workspace 的旧明文选项不迁移，只从项目配置文件里清掉（理由见 config-merger.ts）。
 */
export async function savePluginOptions(input: SavePluginOptionsInput): Promise<void> {
  const workspace = input.scope.kind === "workspace";
  const sensitiveKeys = collectSensitiveKeys(input.plugin);
  const clear = new Set(input.clearOptionKeys);
  const secretValues: PluginOptionValues = {};
  const legacy =
    workspace || sensitiveKeys.size > 0
      ? await readPluginOptionsFromFileConfig(input.configPath, input.plugin.id)
      : {};
  // 仓库旧值可能控制解释器或请求地址；保存其它键不能顺便把这些值迁入可信私有存储。
  if (!workspace) {
    for (const [key, value] of Object.entries(legacy)) {
      if (sensitiveKeys.has(key) && !clear.has(key)) secretValues[key] = value;
    }
  }
  const plainValues: PluginOptionValuesInput = {};
  for (const [key, value] of Object.entries(input.options)) {
    if (workspace || sensitiveKeys.has(key)) secretValues[key] = value;
    else plainValues[key] = value;
  }

  const secretClearKeys = unique([...input.clearOptionKeys, ...Object.keys(plainValues)]);
  if (Object.keys(secretValues).length > 0 || secretClearKeys.length > 0) {
    await updatePluginSecretsFile(input.secretsPath, (file) =>
      setPluginSecrets(file, input.scope, input.plugin.id, secretValues, secretClearKeys),
    );
  }
  await updatePluginOptionsInFileConfig(
    input.configPath,
    input.plugin.id,
    plainValues,
    unique([
      ...input.clearOptionKeys,
      ...Object.keys(secretValues),
      ...(workspace ? Object.keys(legacy) : []),
    ]),
  );
}

/** reset（user scope）与 uninstall 用：删除一个插件在指定 scope 或全部 scope 的私有值。 */
export async function removeStoredPluginSecrets(
  secretsPath: string,
  pluginId: string,
  scope: PluginSecretsScope | "all",
): Promise<void> {
  await updatePluginSecretsFile(secretsPath, (file) => removePluginSecrets(file, pluginId, scope));
}

function collectSensitiveKeys(plugin: Pick<PluginMetadata, "userConfig">): Set<string> {
  return new Set(
    Object.entries(plugin.userConfig ?? {})
      .filter(([, option]) => option.sensitive === true)
      .map(([key]) => key),
  );
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
