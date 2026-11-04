/* eslint-disable max-lines -- 插件市场、安装、卸载、启停状态需要集中维护以避免并发操作状态分散 */
import { create } from "zustand";
import type {
  AvailablePluginSummary,
  InstalledPluginSummary,
  PluginMarketplaceSummary,
  PluginScope,
  PluginsCapability,
} from "@zcode/shared";
import type { IPluginsService } from "@zcode/services";
import { logger } from "@/logger.js";

function buildPluginOperationId(
  scope: PluginScope,
  pluginName: string,
  marketplace: string,
): string {
  return `${scope}:${pluginName}@${marketplace}`;
}

/**
 * 概览请求代号。切换工作区（或清空上下文）后，旧请求仍会返回；
 * 慢的旧响应若照常落盘，会把上一台机器的市场与开关状态写进当前工作区。
 * 发起时领号，落盘前同时核对代号与当前目标，二者任一变化即丢弃。
 */
let overviewRequestGeneration = 0;

/** 代号与目标都必须仍是发起时的那一份，才允许把概览结果写入 store。 */
function isCurrentOverviewRequest(
  get: () => PluginStoreState,
  generation: number,
  workspacePath: string,
  workspaceIdentity: string | null,
): boolean {
  if (generation !== overviewRequestGeneration) return false;
  const state = get();
  // 远程同路径 workspace 共享 workspacePath，只有 identity 一起比较才能区分主机。
  return state.workspacePath === workspacePath && state.workspaceIdentity === workspaceIdentity;
}

interface PluginStoreState {
  workspacePath: string | null;
  workspaceIdentity: string | null;
  loadedWorkspacePath: string | null;
  loadedWorkspaceIdentity: string | null;
  marketplaces: PluginMarketplaceSummary[];
  availablePlugins: AvailablePluginSummary[];
  installedPlugins: InstalledPluginSummary[];
  capability: PluginsCapability | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  addingMarketplaceSource: string | null;
  removingMarketplaceName: string | null;
  updatingMarketplaceName: string | null;
  installingPluginId: string | null;
  uninstallingPluginId: string | null;
  settingPluginEnabledId: string | null;
  settingPluginEnabledValue: boolean | null;
  initialize: (
    workspacePath: string,
    pluginsService: IPluginsService,
    workspaceIdentity?: string,
  ) => Promise<void>;
  refresh: (pluginsService: IPluginsService, workspaceIdentity?: string) => Promise<void>;
  addMarketplace: (
    source: string,
    pluginsService: IPluginsService,
    workspaceIdentity?: string,
  ) => Promise<boolean>;
  removeMarketplace: (
    marketplace: string,
    pluginsService: IPluginsService,
    workspaceIdentity?: string,
  ) => Promise<boolean>;
  updateMarketplace: (
    marketplace: string | null,
    pluginsService: IPluginsService,
    workspaceIdentity?: string,
  ) => Promise<boolean>;
  installPlugin: (
    pluginName: string,
    marketplace: string,
    scopeOrPluginsService: InstalledPluginSummary["scope"] | IPluginsService,
    maybePluginsService?: IPluginsService,
    workspaceIdentity?: string,
  ) => Promise<boolean>;
  uninstallPlugin: (
    pluginName: string,
    marketplace: string,
    scopeOrPluginsService: InstalledPluginSummary["scope"] | IPluginsService,
    maybePluginsService?: IPluginsService,
    workspaceIdentity?: string,
  ) => Promise<boolean>;
  setPluginEnabled: (
    pluginName: string,
    marketplace: string,
    scopeOrEnabled: InstalledPluginSummary["scope"] | boolean,
    enabledOrPluginsService: boolean | IPluginsService,
    maybePluginsService?: IPluginsService,
    workspaceIdentity?: string,
    nativeScope?: InstalledPluginSummary["nativeScope"],
  ) => Promise<boolean>;
  resetWorkspaceContext: () => void;
}

export const usePluginStore = create<PluginStoreState>((set, get) => ({
  workspacePath: null,
  workspaceIdentity: null,
  loadedWorkspacePath: null,
  loadedWorkspaceIdentity: null,
  marketplaces: [],
  availablePlugins: [],
  installedPlugins: [],
  capability: null,
  loading: false,
  refreshing: false,
  error: null,
  addingMarketplaceSource: null,
  removingMarketplaceName: null,
  updatingMarketplaceName: null,
  installingPluginId: null,
  uninstallingPluginId: null,
  settingPluginEnabledId: null,
  settingPluginEnabledValue: null,
  resetWorkspaceContext() {
    // 清空上下文同样让在途概览过期：否则它会重新填回刚被清掉的清单。
    overviewRequestGeneration += 1;
    set({
      workspacePath: null,
      workspaceIdentity: null,
      loadedWorkspacePath: null,
      loadedWorkspaceIdentity: null,
      marketplaces: [],
      availablePlugins: [],
      installedPlugins: [],
      capability: null,
      loading: false,
      refreshing: false,
      error: null,
      addingMarketplaceSource: null,
      removingMarketplaceName: null,
      updatingMarketplaceName: null,
      installingPluginId: null,
      uninstallingPluginId: null,
      settingPluginEnabledId: null,
      settingPluginEnabledValue: null,
    });
  },
  async initialize(
    workspacePath: string,
    pluginsService: IPluginsService,
    workspaceIdentity?: string,
  ) {
    const currentState = get();
    const normalizedWorkspaceIdentity = workspaceIdentity?.trim() || null;
    const hasCachedData =
      currentState.loadedWorkspacePath === workspacePath &&
      currentState.loadedWorkspaceIdentity === normalizedWorkspaceIdentity &&
      (currentState.marketplaces.length > 0 ||
        currentState.availablePlugins.length > 0 ||
        currentState.installedPlugins.length > 0 ||
        currentState.capability !== null);
    // 远程同路径 workspace 会共享同一个 workspacePath。
    // 如果这里只按路径复用插件缓存，上一台机器的市场和开关状态会短暂显示到当前远端。
    // 这里把 workspaceIdentity 一起纳入命中条件，保证同路径不同主机严格隔离。
    const generation = ++overviewRequestGeneration;
    set({
      workspacePath,
      workspaceIdentity: normalizedWorkspaceIdentity,
      marketplaces: hasCachedData ? currentState.marketplaces : [],
      availablePlugins: hasCachedData ? currentState.availablePlugins : [],
      installedPlugins: hasCachedData ? currentState.installedPlugins : [],
      capability: hasCachedData ? currentState.capability : null,
      loading: !hasCachedData,
      refreshing: false,
      error: null,
    });
    try {
      const result = await pluginsService.getOverview({
        workspacePath,
        ...(normalizedWorkspaceIdentity ? { workspaceIdentity: normalizedWorkspaceIdentity } : {}),
      });
      if (!isCurrentOverviewRequest(get, generation, workspacePath, normalizedWorkspaceIdentity)) {
        return;
      }
      set({
        marketplaces: result.marketplaces,
        availablePlugins: result.availablePlugins,
        installedPlugins: result.installedPlugins,
        capability: result.capability,
        loading: false,
        refreshing: false,
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: normalizedWorkspaceIdentity,
      });
    } catch (error) {
      // 旧请求的失败同样过时：它会把新工作区的列表清空并挂上上一台机器的错误。
      if (!isCurrentOverviewRequest(get, generation, workspacePath, normalizedWorkspaceIdentity)) {
        return;
      }
      set({
        loading: false,
        refreshing: false,
        error: error instanceof Error ? error.message : String(error),
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: normalizedWorkspaceIdentity,
      });
    }
  },
  async refresh(pluginsService: IPluginsService, workspaceIdentity?: string) {
    const workspacePath = get().workspacePath;
    if (!workspacePath) {
      return;
    }
    const workspaceIdentityFromState =
      workspaceIdentity?.trim() || get().workspaceIdentity || undefined;
    const state = get();
    const hasCachedData =
      state.marketplaces.length > 0 ||
      state.availablePlugins.length > 0 ||
      state.installedPlugins.length > 0;
    // 插件开关/卸载后会走 refresh，之前强制 loading=true 会让列表切成空态再恢复，造成“闪一下”。
    // 这里保留已有列表做后台刷新，只在首次无缓存数据时显示 loading。
    const generation = ++overviewRequestGeneration;
    const expectedIdentity = state.workspaceIdentity;
    set({ loading: !hasCachedData, refreshing: true, error: null });
    try {
      const result = await pluginsService.getOverview({
        workspacePath,
        ...(workspaceIdentityFromState ? { workspaceIdentity: workspaceIdentityFromState } : {}),
      });
      if (!isCurrentOverviewRequest(get, generation, workspacePath, expectedIdentity)) {
        return;
      }
      set({
        marketplaces: result.marketplaces,
        availablePlugins: result.availablePlugins,
        installedPlugins: result.installedPlugins,
        capability: result.capability,
        loading: false,
        refreshing: false,
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: workspaceIdentityFromState ?? null,
      });
    } catch (error) {
      if (!isCurrentOverviewRequest(get, generation, workspacePath, expectedIdentity)) {
        return;
      }
      set({
        loading: false,
        refreshing: false,
        error: error instanceof Error ? error.message : String(error),
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: workspaceIdentityFromState ?? null,
      });
    }
  },
  async addMarketplace(
    source: string,
    pluginsService: IPluginsService,
    workspaceIdentity?: string,
  ) {
    const workspacePath = get().workspacePath;
    const trimmedSource = source.trim();
    if (!workspacePath || !trimmedSource) {
      return false;
    }
    const workspaceIdentityFromState =
      workspaceIdentity?.trim() || get().workspaceIdentity || undefined;
    set({ error: null, addingMarketplaceSource: trimmedSource });
    try {
      await pluginsService.addMarketplace({
        workspacePath,
        ...(workspaceIdentityFromState ? { workspaceIdentity: workspaceIdentityFromState } : {}),
        source: trimmedSource,
      });
      await get().refresh(pluginsService, workspaceIdentityFromState);
      return true;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      set({ addingMarketplaceSource: null });
    }
  },
  async removeMarketplace(
    marketplace: string,
    pluginsService: IPluginsService,
    workspaceIdentity?: string,
  ) {
    const workspacePath = get().workspacePath;
    if (!workspacePath) {
      return false;
    }
    const workspaceIdentityFromState =
      workspaceIdentity?.trim() || get().workspaceIdentity || undefined;
    set({ error: null, removingMarketplaceName: marketplace });
    try {
      await pluginsService.removeMarketplace({
        workspacePath,
        ...(workspaceIdentityFromState ? { workspaceIdentity: workspaceIdentityFromState } : {}),
        marketplace,
      });
      await get().refresh(pluginsService, workspaceIdentityFromState);
      return true;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      set({ removingMarketplaceName: null });
    }
  },
  async updateMarketplace(
    marketplace: string | null,
    pluginsService: IPluginsService,
    workspaceIdentity?: string,
  ) {
    const workspacePath = get().workspacePath;
    if (!workspacePath) {
      return false;
    }
    const workspaceIdentityFromState =
      workspaceIdentity?.trim() || get().workspaceIdentity || undefined;
    set({
      error: null,
      updatingMarketplaceName: marketplace ?? "__all__",
    });
    try {
      const result = await pluginsService.updateMarketplace({
        workspacePath,
        ...(workspaceIdentityFromState ? { workspaceIdentity: workspaceIdentityFromState } : {}),
        marketplace: marketplace || undefined,
      });
      await get().refresh(pluginsService, workspaceIdentityFromState);
      // legacy usePlugins 入口虽已退役，仍是公开 hook；它必须与 PluginManagementStore
      // 共用部分成功语义，不能在 Agent 返回 error diagnostic 后无条件报告成功。
      const blockingDiagnostic = result?.diagnostics?.find(
        (diagnostic) => diagnostic.severity === "error",
      );
      if (blockingDiagnostic) {
        set({ error: blockingDiagnostic.message });
        return false;
      }
      return true;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      set({ updatingMarketplaceName: null });
    }
  },
  async installPlugin(
    pluginName: string,
    marketplace: string,
    scopeOrPluginsService: InstalledPluginSummary["scope"] | IPluginsService,
    maybePluginsService?: IPluginsService,
    workspaceIdentity?: string,
  ) {
    const workspacePath = get().workspacePath;
    if (!workspacePath) {
      // 设置页尚未绑定 workspace 时 store 里可能还留着上一份缓存列表；
      // 直接 return false 会让点击安装看起来毫无反应，这里先写入显式错误提示。
      // 用户可见错误用稳定 i18n key：store 不持有 intl，展示方用 resolvePluginStoreErrorMessage 解析。
      set({ error: "plugin.error.noWorkspaceInstall" });
      return false;
    }
    const workspaceIdentityFromState =
      workspaceIdentity?.trim() || get().workspaceIdentity || undefined;
    const scope = typeof scopeOrPluginsService === "string" ? scopeOrPluginsService : "user";
    const pluginsService =
      typeof scopeOrPluginsService === "string" ? maybePluginsService : scopeOrPluginsService;
    if (!pluginsService) {
      set({ error: "pluginsService is required" });
      return false;
    }
    const pluginId = buildPluginOperationId(scope, pluginName, marketplace);
    set({ error: null, installingPluginId: pluginId });
    logger.info("[Plugins] install start", { pluginId, workspacePath });
    try {
      await pluginsService.installPlugin({
        workspacePath,
        ...(workspaceIdentityFromState ? { workspaceIdentity: workspaceIdentityFromState } : {}),
        pluginName,
        marketplace,
        scope,
      });
      await get().refresh(pluginsService, workspaceIdentityFromState);
      logger.info("[Plugins] install success", { pluginId, workspacePath });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[Plugins] install failed", { pluginId, workspacePath, message });
      set({ error: message });
      return false;
    } finally {
      set({ installingPluginId: null });
    }
  },
  async uninstallPlugin(
    pluginName: string,
    marketplace: string,
    scopeOrPluginsService: InstalledPluginSummary["scope"] | IPluginsService,
    maybePluginsService?: IPluginsService,
    workspaceIdentity?: string,
  ) {
    const workspacePath = get().workspacePath;
    if (!workspacePath) {
      set({ error: "plugin.error.noWorkspaceUninstall" });
      return false;
    }
    const workspaceIdentityFromState =
      workspaceIdentity?.trim() || get().workspaceIdentity || undefined;
    const scope = typeof scopeOrPluginsService === "string" ? scopeOrPluginsService : "user";
    const pluginsService =
      typeof scopeOrPluginsService === "string" ? maybePluginsService : scopeOrPluginsService;
    if (!pluginsService) {
      set({ error: "pluginsService is required" });
      return false;
    }
    const pluginId = buildPluginOperationId(scope, pluginName, marketplace);
    set({ error: null, uninstallingPluginId: pluginId });
    try {
      await pluginsService.uninstallPlugin({
        workspacePath,
        ...(workspaceIdentityFromState ? { workspaceIdentity: workspaceIdentityFromState } : {}),
        pluginName,
        marketplace,
        scope,
      });
      await get().refresh(pluginsService, workspaceIdentityFromState);
      return true;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      set({ uninstallingPluginId: null });
    }
  },
  async setPluginEnabled(
    pluginName: string,
    marketplace: string,
    scopeOrEnabled: InstalledPluginSummary["scope"] | boolean,
    enabledOrPluginsService: boolean | IPluginsService,
    maybePluginsService?: IPluginsService,
    workspaceIdentity?: string,
    nativeScope?: InstalledPluginSummary["nativeScope"],
  ) {
    const workspacePath = get().workspacePath;
    if (!workspacePath) {
      set({ error: "plugin.error.noWorkspaceToggle" });
      return false;
    }
    const workspaceIdentityFromState =
      workspaceIdentity?.trim() || get().workspaceIdentity || undefined;
    const legacyCall = typeof scopeOrEnabled === "boolean";
    const scope = legacyCall ? "user" : scopeOrEnabled;
    const enabled = legacyCall ? scopeOrEnabled : (enabledOrPluginsService as boolean);
    const pluginsService = legacyCall
      ? (enabledOrPluginsService as IPluginsService)
      : maybePluginsService;
    if (!pluginsService) {
      set({ error: "pluginsService is required" });
      return false;
    }
    const pluginId = buildPluginOperationId(scope, pluginName, marketplace);
    set({
      error: null,
      settingPluginEnabledId: pluginId,
      settingPluginEnabledValue: enabled,
    });
    try {
      await pluginsService.setPluginEnabled({
        workspacePath,
        ...(workspaceIdentityFromState ? { workspaceIdentity: workspaceIdentityFromState } : {}),
        pluginName,
        marketplace,
        scope,
        ...(nativeScope ? { nativeScope } : {}),
        enabled,
      });
      await get().refresh(pluginsService, workspaceIdentityFromState);
      return true;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      set({
        settingPluginEnabledId: null,
        settingPluginEnabledValue: null,
      });
    }
  },
}));
