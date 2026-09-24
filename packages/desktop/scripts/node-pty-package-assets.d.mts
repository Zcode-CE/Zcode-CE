import type { TargetPlatform } from "./target-platform.d.mts";

export interface NodePtyPayloadAssertionParams {
  /** 桌面端形态：<resourcesDir>/app.asar.unpacked/node_modules/node-pty */
  resourcesDir?: string;
  /** CLI 发行包形态：<dist-release>/<产物名>/runtime/node_modules/node-pty（与 resourcesDir 二选一） */
  nodePtyPackageRoot?: string;
  platformKey: string;
  sourcePackageName?: string;
}

export interface NodePtyPayloadAssertionResult {
  checked: boolean;
  reason?: string;
  platformKey?: string;
  digest?: string;
}

/** 断言产物内 node-pty 载荷只有我们验证过的那一份（不得带 build/Release|build/Debug，prebuilds 必须与平台包一致）。 */
export function assertPackagedNodePtyPayloadVerified(
  params: NodePtyPayloadAssertionParams,
): NodePtyPayloadAssertionResult;

export function restoreTargetNodePtyPrebuild(params: {
  desktopPackageRoot: string;
  targetPlatform: TargetPlatform;
}): void;

export function resolveSourceNodePtyPrebuildPath(params: {
  sourcePackageName: string;
  platformKey: string;
}): string;

export function resolvePackagedNodePtyPrebuildPath(params: {
  resourcesDir: string;
  platformKey: string;
}): string;
