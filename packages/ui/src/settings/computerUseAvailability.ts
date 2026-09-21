import type { RemoteTarget } from "@zcode/shared";
import { isRemoteWorkspaceIdentity } from "@zcode/shared";

type ComputerUseAvailabilityKind =
  | "local-macos"
  | "local-windows"
  | "local-linux"
  | "remote-ssh"
  | "remote-wsl"
  | "remote-docker"
  | "remote-server"
  | "web";

interface ComputerUseAvailability {
  kind: ComputerUseAvailabilityKind;
  supported: boolean;
  /** 实验性支持：能力已接入但未承诺稳定性，UI 需显式提示，而不是当作不支持隐藏掉。 */
  experimental?: boolean;
}

interface ComputerUseAvailabilityInput {
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  remoteSessionId?: string | null;
  remoteTarget?: RemoteTarget | null;
  workspaceIdentity?: string | null;
}

/**
 * 设置页「启用电脑控制」总开关的运行时状态。
 *
 * 总开关读的是插件管理 store 里 `computer-use@zcode-plugins-official` 这条记录，于是存在两种与
 * 用户意图无关的前置状态：store 还没加载完、插件根本不在本构建里。旧实现把两者都折叠成
 * `enabled=false`，用户点开关直接拿到 `Plugin not found: computer-use@zcode-plugins-official` ——
 * 那是这份 UI 能给出的最差表达。这里把前置状态显式建模，交给设置页分文案并决定开关能不能点。
 */
export type ComputerUsePluginStateKind = "loading" | "unavailable" | "enabled" | "disabled";

/** 插件不可用的成因：列表加载失败可重试；插件缺失只能如实告知。 */
export type ComputerUsePluginUnavailableReason = "not-found" | "load-failed";

export interface ComputerUsePluginState {
  kind: ComputerUsePluginStateKind;
  /** 仅 `unavailable` 时存在。 */
  reason?: ComputerUsePluginUnavailableReason;
}

export interface ComputerUsePluginStateInput {
  /** 插件管理 store 是否已经为本 workspace 完成过一次加载（成功或失败都算）。 */
  loaded: boolean;
  /** 本 workspace 的加载是否失败（store 里没有可用数据）。 */
  loadFailed: boolean;
  /** 该 workspace 的插件列表里是否存在 computer-use 条目。 */
  present: boolean;
  /** 该插件当前的启用态；`present` 为 false 时无意义。 */
  enabled: boolean;
}

/**
 * 前置状态优先于启用态：
 * - 列表里有这个插件 ⇒ 按它的 enabled 给出 enabled / disabled（enable 失败是另一次操作的结果，不在这里）；
 * - 加载失败 ⇒ unavailable(load-failed)，此时 store 里的 `plugins` 不可信；
 * - 还在加载 ⇒ loading；
 * - 加载完成却没有该条目 ⇒ unavailable(not-found)（例如插件没进包或当前 scope 不提供）。
 */
export function resolveComputerUsePluginState({
  loaded,
  loadFailed,
  present,
  enabled,
}: ComputerUsePluginStateInput): ComputerUsePluginState {
  if (present) return { kind: enabled ? "enabled" : "disabled" };
  if (loadFailed) return { kind: "unavailable", reason: "load-failed" };
  if (!loaded) return { kind: "loading" };
  return { kind: "unavailable", reason: "not-found" };
}

/**
 * 总开关是否必须保持不可点。
 *
 * 硬要求：插件不可用或状态未知时，点开关不能落到 `setEnabled` 上。那里的选解析器在
 * marketplace 清单里找不到 id 时抛 `Plugin not found`，用户看到的是一次没有出路的失败。
 */
export function shouldDisableComputerUseToggle(state: ComputerUsePluginStateKind): boolean {
  return state === "loading" || state === "unavailable";
}

export function resolveComputerUseAvailability({
  isDesktop = false,
  isMacDesktop = false,
  isWindowsDesktop = false,
  remoteSessionId,
  remoteTarget,
  workspaceIdentity,
}: ComputerUseAvailabilityInput = {}): ComputerUseAvailability {
  const isRemote = Boolean(
    remoteSessionId ||
    remoteTarget ||
    (workspaceIdentity?.trim() && isRemoteWorkspaceIdentity(workspaceIdentity.trim())),
  );
  if (isRemote) {
    const remoteKind: ComputerUseAvailabilityKind =
      remoteTarget?.kind === "ssh"
        ? "remote-ssh"
        : remoteTarget?.kind === "wsl"
          ? "remote-wsl"
          : remoteTarget?.kind === "docker"
            ? "remote-docker"
            : "remote-server";
    return {
      kind: remoteKind,
      supported: false,
    };
  }
  if (!isDesktop) return { kind: "web", supported: false };
  if (isMacDesktop) return { kind: "local-macos", supported: true };
  if (isWindowsDesktop) return { kind: "local-windows", supported: true };
  // Linux 使用开源实现（trycua/cua）的 linux-x64-gnu / linux-arm64-gnu 预编译目标，
  // 驱动已随包发出（packages/zcode-cua 的 CUA_DRIVER_SUPPORTED_PLATFORMS 也包含这两个 target）。
  // 但后端在 X11 / Wayland 下的覆盖度未经验证，因此标记为「可用但实验性」，
  // 由 UI 显式提示能力边界，而不是像过去那样直接判为不支持。
  return { kind: "local-linux", supported: true, experimental: true };
}

const COMPUTER_USE_SEARCH_TERMS = ["电脑控制", "computer use", "zcode-cua", "cua"];

export function matchesComputerUseSearch(query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return true;
  return COMPUTER_USE_SEARCH_TERMS.some((term) => term.includes(normalized));
}

/**
 * 是否需要展示「本环境不可用」的提示卡。
 * Linux 在接入开源实现后已改为「可用但实验性」（见上方 local-linux 分支），
 * 因此这里现在只对远端环境返回 true；web 走另一条文案分支。
 */
export function isComputerUseUnavailable(availability: ComputerUseAvailability): boolean {
  return !availability.supported && availability.kind !== "web";
}
