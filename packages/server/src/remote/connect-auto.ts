import type { IRemoteBackend } from "./backend.js";
import { connectRemote, type ConnectOptions, type RemoteConnection } from "./connect.js";
import {
  DaemonAdmissionError,
  connectDaemonRemote,
  describeDaemonProbeOutcome,
  probeDaemonServer,
  type DaemonCloseEvent,
  type DaemonConnectOptions,
  type DaemonConnectResult,
} from "./daemon/index.js";

/**
 * 传输选择：有可用常驻 daemon 就用它，否则完全保持现有 stdio 链路。
 *
 * 分发策略（Lead 决策 #1）：远端若已装可用的 `zcode-server`（`ZCODE_SERVER_BIN` →
 * `~/.zcode/server/bin/zcode-server` → PATH），走 daemon；否则零变化地走 stdio，
 * 并把「装上 server 后可得常驻会话」的原因（`daemonFallbackReason`）交给上层做能力提示。
 */
export type RemoteTransportKind = "stdio" | "daemon";

export interface ConnectRemoteAutoOptions extends ConnectOptions, DaemonConnectOptions {
  /** 关闭 daemon 探测（回滚开关 / 测试）。默认 auto。 */
  daemonTransport?: "auto" | "disabled";
  /** 测试注入：探测实现。 */
  probeDaemon?: typeof probeDaemonServer;
  /** 测试注入：daemon 连接实现。 */
  connectDaemon?: typeof connectDaemonRemote;
  /** 测试注入：stdio 实现。 */
  connectStdio?: typeof connectRemote;
}

export async function connectRemoteAuto(
  backend: IRemoteBackend,
  options: ConnectRemoteAutoOptions = {},
): Promise<RemoteConnection> {
  const connectStdio = options.connectStdio ?? connectRemote;
  const fallback = async (
    code: RemoteConnection["daemonFallbackCode"],
    reason: string,
  ): Promise<RemoteConnection> => {
    const connection = await connectStdio(backend, options);
    return {
      ...connection,
      transport: "stdio",
      daemonFallbackReason: reason,
      daemonFallbackCode: code,
    };
  };

  if (options.daemonTransport === "disabled") {
    return fallback("daemon-disabled", "daemon transport disabled by caller");
  }
  if (!backend.openTcpipChannel) {
    // WSL/Docker 没有 direct-tcpip：本片常驻会话只覆盖 SSH，其余保持 stdio。
    return fallback("transport-unsupported", "remote transport does not support direct-tcpip");
  }

  // 探测放在 connectDaemonRemote 内部（同一次调用内完成探测→准入→取票→升级）；
  // 这里先单独探一次，是为了把「daemon 不可用」与「daemon 连上了但握手失败」区分成
  // 两种回退原因：前者是能力提示，后者是故障。
  const probe = options.probeDaemon ?? probeDaemonServer;
  const probed = await probe(backend, {});
  // ready 与 stopped 都值得进 daemon 传输（stopped 会现场拉起）；其余直接回退 stdio。
  if (probed.kind !== "ready" && probed.kind !== "stopped") {
    return fallback(
      probed.kind === "not-installed" ? "daemon-not-installed" : "daemon-unusable",
      describeDaemonProbeOutcome(probed),
    );
  }

  const connectDaemon = options.connectDaemon ?? connectDaemonRemote;
  let result: DaemonConnectResult;
  try {
    result = await connectDaemon(backend, {
      ...(options.expectedProtocolVersion === undefined
        ? {}
        : { expectedProtocolVersion: options.expectedProtocolVersion }),
      ...(options.onDidDaemonClose ? { onDidDaemonClose: options.onDidDaemonClose } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    // 决策调整（Lead）：连接前的失败一律回退 stdio —— 远端旧版/坏掉的 daemon 不该让
    // 本来可用 stdio 的工作区变成不可用。原因码让 UI 出「为什么没走常驻会话」的横幅。
    // 注意：连接建立之后的 daemon 中断不走这里（那时 stdio 会另起一个 server，语义混乱），
    // 由 daemon 重连状态机处理（remoteDaemonReconnectController）。
    if (error instanceof DaemonAdmissionError) {
      return fallback("daemon-incompatible", error.message);
    }
    return fallback(
      "daemon-connect-failed",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!result.available) {
    const code =
      result.kind === "not-installed"
        ? "daemon-not-installed"
        : result.kind === "start-failed"
          ? "daemon-start-failed"
          : result.kind === "incompatible"
            ? "daemon-incompatible"
            : result.kind === "unsupported"
              ? "transport-unsupported"
              : "daemon-unusable";
    return fallback(code, result.reason);
  }
  return result.connection;
}

export type { DaemonCloseEvent };
