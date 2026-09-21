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
