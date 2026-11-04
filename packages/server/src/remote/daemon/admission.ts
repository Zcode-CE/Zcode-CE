import { ZCODE_PROTOCOL_VERSION } from "@zcode/shared";
import type { DaemonChannelFactory } from "./types.js";
import { parseJsonResponse, requestOverChannel, type ChannelHttpResponse } from "./http.js";

/** daemon /api/server-info 的最小形状（SPIKE §2.4 实测字段）。 */
export interface DaemonServerInfo {
  serverId?: string;
  version?: string;
  protocolVersion?: number;
  authRequired?: boolean;
}

export type DaemonAdmission =
  | { admitted: true; serverId: string; version?: string; protocolVersion: number }
  | { admitted: false; reason: string };

/**
 * 准入判定：protocolVersion 必须与本端一致，并记录 serverId 作为会话归属。
 *
 * 形状沿用 packages/web/src/serverCompatibility.ts（{compatible:false, reason} 的可读原因），
 * 但这里不 import 它：那条依赖是 server → web（方向反了），复制这 30 行判定比引入跨层依赖安全。
 * RPC 层不做版本协商（packages/rpc/src 无 protocolVersion 校验），所以这道闸是唯一一次判断。
 */
export function evaluateDaemonAdmission(
  serverInfo: DaemonServerInfo | undefined,
  expectedProtocolVersion: number = ZCODE_PROTOCOL_VERSION,
): DaemonAdmission {
  const actual = serverInfo?.protocolVersion;
  if (typeof actual !== "number" || !Number.isFinite(actual)) {
    return {
      admitted: false,
      reason:
        "远端 daemon 没有返回可识别的协议版本（/api/server-info.protocolVersion）；" +
        "请确认它由兼容版本的 zcode-server 启动。 / " +
        "The remote daemon did not report a recognizable protocol version.",
    };
  }
  if (actual !== expectedProtocolVersion) {
    return {
      admitted: false,
      reason:
        "桌面与远端 daemon 的协议版本不一致：桌面期望 " +
        expectedProtocolVersion +
        "，远端为 " +
        actual +
        "（daemon 版本 " +
        (serverInfo?.version ?? "unknown") +
        "）。请升级其中一端后重连。 / " +
        "Desktop and remote daemon protocol versions do not match.",
    };
  }
  const serverId = serverInfo?.serverId?.trim();
  if (!serverId) {
    return {
      admitted: false,
      reason: "远端 daemon 没有返回 serverId，无法建立会话归属（/api/server-info.serverId）。",
    };
  }
  return {
    admitted: true,
    serverId,
    ...(serverInfo?.version ? { version: serverInfo.version } : {}),
    protocolVersion: actual,
  };
}

/**
 * 经通道读取 /api/server-info 并做准入判定。
 * 这一跳无鉴权（daemon 只监听回环，隧道就是边界），但必须在取票之前跑：
 * 版本不一致时不该浪费一张 ticket，也不该发起 WS 升级。
 */
export async function checkDaemonAdmission(params: {
  openChannel: DaemonChannelFactory;
  expectedProtocolVersion?: number;
  timeoutMs?: number;
}): Promise<DaemonAdmission> {
  let response: ChannelHttpResponse;
  try {
    response = await requestOverChannel(await params.openChannel(), {
      path: "/api/server-info",
      timeoutMs: params.timeoutMs,
    });
  } catch (error) {
    return {
      admitted: false,
      reason:
        "/api/server-info 请求失败：" + (error instanceof Error ? error.message : String(error)),
    };
  }
  const parsed = parseJsonResponse<DaemonServerInfo>(response, "/api/server-info");
  if (!parsed.ok) return { admitted: false, reason: parsed.reason };
  return evaluateDaemonAdmission(parsed.value, params.expectedProtocolVersion);
}
