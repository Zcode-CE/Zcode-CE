import { randomBytes } from "node:crypto";
import { BROKER_SOCKET_ENV, BROKER_UNAVAILABLE_ENV } from "@zcode/zcode-cua/broker";
import { resolveBrokerSocketPath } from "@zcode/zcode-cua/broker/socketPath";
import { ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY } from "@zcode/shared";

/**
 * Computer Use 的 agent spawn env 契约：官方 Helper 是**凭据来源**，不是门控。
 *
 * 背景（F3-2）：开源驱动路径的 broker 是 node-repl-host 自建的进程内 socket
 * （apps/zcode-cli/packages/node-repl-host/src/cua-broker.ts:21-63），Helper 的 socket 对驱动是惰性的 ——
 * server.ts:389 收下它之后没有任何消费方（packages/zcode-cua/index.js 只读 driver/loadDriver）。
 * 而 bootstrap 的注入门控要求 socket 非空
 * （apps/zcode-cli/packages/bootstrap/src/mcp-config.ts:124-131），于是没有官方 Helper 的构建里
 * ZCODE_CUA_NODE_REPL_HOST 永远注入不进去，Computer Use 恒不可用。
 * 这里下发同一份凭据契约，让驱动路径不依赖 Helper 实体是否存在。
 */

/** 懒铸造：socket 路径 + config-provenance authority，与 darwin 懒启动分支同一口径。 */
export function mintCuaProductHelperEnv(): Record<string, string> {
  return {
    [BROKER_SOCKET_ENV]: resolveBrokerSocketPath(),
    [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: randomBytes(16).toString("hex"),
  };
}

/**
 * 开源驱动（@trycua/cua-driver）有预编译产物的平台，与 packages/zcode-cua/cua-driver-runtime.js
 * 的 CUA_DRIVER_SUPPORTED_PLATFORMS 是同一组平台（那里按 os-arch-libc 三元组枚举）。
 * 三平台之外保持 fail-closed：不伪造凭据，CUA 继续按不可用处理。
 */
const CUA_OPEN_SOURCE_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set([
  "darwin",
  "win32",
  "linux",
]);

export function canRunOpenSourceCuaDriver(platform: NodeJS.Platform | string): boolean {
  return CUA_OPEN_SOURCE_PLATFORMS.has(platform as NodeJS.Platform);
}

/**
 * buildCuaProductHelperAgentEnv 的返回值与懒铸造的合流点。
 *
 * Helper transport 真的拿到了（socket + authority）就照原样用；回落成 BROKER_UNAVAILABLE 时，
 * 在开源驱动支持的平台上改用懒铸造契约 —— CE 构建不随包携带 cua-helper
 * （macOS 的 resources/cua-helper/*.app 与 Windows 的 resources/tools/cua-helper 都不在
 * electron-builder.config.js:580-667 的 extraResources 里），win32 的 acquire 分支必然落到这条路径；
 * 不回落的话 Windows 上的 trycua 路径同样永远起不来。
 */
export function resolveCuaProductHelperSpawnEnv(
  helperEnv: Record<string, string>,
  options: { platform?: NodeJS.Platform | string } = {},
): Record<string, string> {
  if (!(BROKER_UNAVAILABLE_ENV in helperEnv)) return helperEnv;
  return canRunOpenSourceCuaDriver(options.platform ?? process.platform)
    ? mintCuaProductHelperEnv()
    : helperEnv;
}
