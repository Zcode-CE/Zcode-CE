import { ZCODE_RPC_HOST_CAPABILITY_HEADER } from "@zcode/shared";
import type { DaemonChannelFactory } from "./types.js";
import { parseJsonResponse, requestOverChannel } from "./http.js";

/**
 * ticket TTL（与 daemon 的 server-core/hostCapability.ts 一致：30s）。
 * 只在文档/日志里用；本模块不据此缓存票据。
 */
export const DAEMON_HOST_CAPABILITY_TTL_MS = 30_000;

export interface DaemonHostCapabilityTicket {
  capability: string;
  expiresAt?: number;
}

/**
 * 取一张 /ws/host 的一次性 ticket。
 *
 * 每次（重）连都必须重新取，禁止缓存复用：daemon 侧无论成功、过期还是重放都会先删除票据
 * （hostCapability.ts:45-54），复用同一张必然 401（SPIKE §4.8 实测：无 ticket=401、带 ticket=升级成功、
 * 重放=401）。这里不做任何模块级缓存，调用方也不得保存后复用。
 */
export async function requestDaemonHostCapabilityTicket(params: {
  openChannel: DaemonChannelFactory;
  timeoutMs?: number;
}): Promise<{ ok: true; ticket: DaemonHostCapabilityTicket } | { ok: false; reason: string }> {
  let response;
  try {
    response = await requestOverChannel(await params.openChannel(), {
      method: "POST",
      path: "/api/rpc-host-capability",
      timeoutMs: params.timeoutMs,
    });
  } catch (error) {
    return {
      ok: false,
      reason:
        "取 host capability 失败（通道不可用）：" +
        (error instanceof Error ? error.message : String(error)),
    };
  }
  const parsed = parseJsonResponse<{ capability?: unknown; expiresAt?: unknown }>(
    response,
    "/api/rpc-host-capability",
  );
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const capability = typeof parsed.value.capability === "string" ? parsed.value.capability : "";
  if (!capability) {
    return { ok: false, reason: "/api/rpc-host-capability 没有返回 capability 字符串" };
  }
  return {
    ok: true,
    ticket: {
      capability,
      ...(typeof parsed.value.expiresAt === "number" ? { expiresAt: parsed.value.expiresAt } : {}),
    },
  };
}

export { ZCODE_RPC_HOST_CAPABILITY_HEADER };
