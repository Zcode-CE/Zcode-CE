/**
 * web 资产与服务器的**契约版本**比对。
 *
 * 分发链路上 web 资产与 server 由同一次构建产出（`scripts/build-zcode.mjs` 同批 stage），
 * 但源码态/手工部署完全可能出现「旧 web 资产 + 新 server」或反之。RPC 层不做版本协商
 * （`packages/rpc/src` 无 protocolVersion 校验），因此**必须**在这里显式判断：
 * 不一致就明确报错、不进入应用，**不允许静默降级**（AGENTS.md 对降级的要求）。
 */

export interface ServerInfoLike {
  protocolVersion?: number;
  version?: string;
}

export type ServerCompatibility = { compatible: true } | { compatible: false; reason: string };

export function evaluateServerCompatibility(
  serverInfo: ServerInfoLike | undefined,
  expectedProtocolVersion: number,
): ServerCompatibility {
  const actual = serverInfo?.protocolVersion;
  if (typeof actual !== "number" || !Number.isFinite(actual)) {
    return {
      compatible: false,
      reason:
        "服务器没有返回可识别的协议版本（/api/server-info.protocolVersion）。" +
        "请确认你访问的是 ZCode Web 服务，并且 web 资产与服务器来自同一个版本。 / " +
        "The server did not report a recognizable protocol version.",
    };
  }
  if (actual !== expectedProtocolVersion) {
    return {
      compatible: false,
      reason:
        "网页资产与服务器的协议版本不一致：网页期望 " +
        expectedProtocolVersion +
        "，服务器为 " +
        actual +
        "（服务器版本 " +
        (serverInfo?.version ?? "unknown") +
        "）。请用同一版本重新部署或刷新。 / " +
        "Web assets and server protocol versions do not match.",
    };
  }
  return { compatible: true };
}
