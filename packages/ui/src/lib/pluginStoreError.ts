import type { IntlInstance } from "@/i18n/IntlProvider.js";

/**
 * 插件管理 store 的错误文案解析。
 *
 * store 不是 React 上下文，拿不到 intl；但把中文硬编码进 store 会让英文界面显示中文。
 * 约定：store 对「自己产生的用户可见错误」写稳定的 i18n key（以 `plugin.error.` 开头），
 * 服务端/底层错误仍以原始字符串透传。展示方用本函数统一解析，避免每个消费方各写一份前缀判断。
 */
const PLUGIN_STORE_ERROR_I18N_PREFIX = "plugin.error.";
const PLUGIN_STORE_ERROR_MESSAGE_PREFIX = "settings.plugins.error.";

export function resolvePluginStoreErrorMessage(
  intl: Pick<IntlInstance, "formatMessage">,
  error: string | null | undefined,
): string | null {
  if (!error) return null;
  if (!error.startsWith(PLUGIN_STORE_ERROR_I18N_PREFIX)) return error;
  return intl.formatMessage({
    id: PLUGIN_STORE_ERROR_MESSAGE_PREFIX + error.slice(PLUGIN_STORE_ERROR_I18N_PREFIX.length),
  });
}
