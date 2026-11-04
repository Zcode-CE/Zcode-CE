import { ChannelClient, SocketProtocol } from "@zcode/rpc";
import { RemoteServiceAccess } from "@zcode/client";
import { formatLogPrefix } from "@zcode/shared";
import type { IRemoteBackend } from "../backend.js";
import type { RemoteConnection } from "../connect.js";
import { probeDaemonServer } from "./probe.js";
import { startRemoteDaemon } from "./start.js";
import { checkDaemonAdmission } from "./admission.js";
import { requestDaemonHostCapabilityTicket } from "./hostCapability.js";
import { openDaemonHostWebSocket, wrapDaemonWebSocket } from "./websocket.js";
import { wrapDaemonChannelAsSocket } from "./socket.js";
import type { DaemonCloseEvent, DaemonProbeOutcome, DaemonReadyStatus } from "./types.js";

/**
 * 准入失败（协议版本不一致 / 无 serverId）：不降级，直接把可读原因抛给调用方。
 * 与「daemon 不可用」不同：后者回退 stdio（行为零变化），前者必须让用户看到版本问题，
 * 否则会退化成「功能静默不可用、而界面一切正常」。
 */
export class DaemonAdmissionError extends Error {
  readonly code = "daemon_admission_failed";
  constructor(message: string) {
    super(message);
    this.name = "DaemonAdmissionError";
  }
}

export interface DaemonConnectOptions {
  /** 期望的协议版本，默认 @zcode/shared 的 ZCODE_PROTOCOL_VERSION。 */
  expectedProtocolVersion?: number;
  /** daemon 侧关闭事件（区分连接断开 / daemon 消失），第二阶段状态机消费。 */
  onDidDaemonClose?: (event: DaemonCloseEvent) => void;
  signal?: AbortSignal;
  /** 探测用的环境来源（测试注入）。 */
  env?: Record<string, string | undefined>;
  /** 探测用的 home（测试注入）；默认 `~` 交给远端 shell 展开。 */
  homeDir?: string;
  /** 已安装未运行时是否允许现场拉起 daemon（默认允许）。 */
  autoStart?: boolean;
  /** 拉起后等待 ready 的预算（毫秒）；超时按不可用降级。 */
  startReadyTimeoutMs?: number;
}

export type DaemonConnectResult =
  | { available: true; connection: RemoteConnection }
  /** 不可用：调用方回退 stdio。kind 供 UI 区分「未安装（可提示安装）」与「装了但坏了」。 */
  | {
      available: false;
      kind: "not-installed" | "unusable" | "unsupported" | "start-failed" | "incompatible";
      reason: string;
      /** Core 日志路径（诊断入口；已安装时才有意义）。 */
      coreLogPath?: string;
    };

const BACKEND_DISCONNECT_CODE = -1;
const DAEMON_READY_POLL_INTERVAL_MS = 250;

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("Remote daemon connect canceled");
  error.name = "AbortError";
  throw error;
}

function toUnavailable(probe: DaemonProbeOutcome): DaemonConnectResult | null {
  if (probe.kind === "ready" || probe.kind === "stopped") return null;
  if (probe.kind === "unsupported") {
    return { available: false, kind: "unsupported", reason: probe.reason };
  }
  if (probe.kind === "not-installed") {
    return {
      available: false,
      kind: "not-installed",
      reason: probe.reason ?? "远端未安装 zcode-server（装上后可获得常驻会话）",
      ...(probe.coreLogPath ? { coreLogPath: probe.coreLogPath } : {}),
    };
  }
  return {
    available: false,
    kind: "unusable",
    reason: probe.reason,
    coreLogPath: probe.coreLogPath,
  };
}

/**
 * 连到远端常驻 daemon 的 /ws/host，返回与 stdio 版同形的 RemoteConnection。
 *
 * 判据（Lead 决策，探测三态）：
 *   1. installed: false ⇒ not-installed，调用方回退 stdio 并给 UI 能力提示；
 *   2. installed + stopped ⇒ 用 SKIP_SERVICE_REGISTRATION=1 serve --daemon 现场拉起，
 *      再轮询 status 取新端口；拉不起来 ⇒ unusable（带 core log 路径）；
 *   3. ready ⇒ 直接用它报的端口。
 * 拿到 ready 之后：准入（/api/server-info）→ 取一次性 ticket → 升级 /ws/host。
 */
export async function connectDaemonRemote(
  backend: IRemoteBackend,
  options: DaemonConnectOptions = {},
): Promise<DaemonConnectResult> {
  const log = (...args: unknown[]) =>
    console.log(formatLogPrefix("remote-daemon", process.pid), ...args);
  const openTcpipChannel = backend.openTcpipChannel?.bind(backend);
  if (!openTcpipChannel) {
    return {
      available: false,
      kind: "unsupported",
      reason: "remote transport does not support direct-tcpip",
    };
  }

  let probe = await probeDaemonServer(backend, {
    env: options.env,
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
  });
  throwIfAborted(options.signal);
  const unavailable = toUnavailable(probe);
  if (unavailable) return unavailable;

  if (probe.kind === "stopped") {
    if (options.autoStart === false) {
      return {
        available: false,
        kind: "unusable",
        reason: "daemon is installed but not running (autoStart disabled)",
        coreLogPath: probe.coreLogPath,
      };
    }
    const started = await startRemoteDaemon(backend, {
      bin: probe.bin,
      serverRoot: probe.serverRoot,
    });
    if (!started.ok) {
      return {
        available: false,
        kind: "start-failed",
        reason: "拉起远端 daemon 失败：" + started.reason,
        coreLogPath: probe.coreLogPath,
      };
    }
    throwIfAborted(options.signal);
    // 端口每次启动都会变：起完必须重新 status，不能沿用启动前的快照。
    const ready = await waitForDaemonReady(backend, options);
    if (!ready) {
      return {
        available: false,
        kind: "start-failed",
        reason: "daemon 已拉起但未在预算内就绪",
        coreLogPath: probe.coreLogPath,
      };
    }
    probe = ready;
  }

  const readyProbe = probe as Extract<DaemonProbeOutcome, { kind: "ready" }>;
  const daemon: DaemonReadyStatus = readyProbe.status;
  const serverRoot = readyProbe.serverRoot;
  const bin = readyProbe.bin;
  // HTTP 与 WS 两条路径都经同一个 Socket 兼容 shim：ssh2 forwardOut 返回的是 Channel（Duplex），
  // 缺 setTimeout/setNoDelay/ref/address 等 net.Socket 方法，Node http 与 ws 都会直接崩（真机 E2E 实测）。
  const openChannel = async () =>
    wrapDaemonChannelAsSocket(await openTcpipChannel({ host: daemon.host, port: daemon.port }), {
      host: daemon.host,
      port: daemon.port,
    });

  const admission = await checkDaemonAdmission({
    openChannel,
    expectedProtocolVersion: options.expectedProtocolVersion,
  });
  if (!admission.admitted) {
    // 决策调整（Lead）：准入失败回退 stdio 而不是硬错 —— 远端装旧版 daemon 的用户
    // 本来用 stdio 是好的，硬错会把「可用」变成「不可用」（回归）。版本差异写进 reason，
    // 由 connect-auto 以 `daemon-incompatible` 码交给 UI 显示。
    return { available: false, kind: "incompatible", reason: admission.reason };
  }
  log("admitted", { serverId: admission.serverId, port: daemon.port });
  throwIfAborted(options.signal);

  const ticket = await requestDaemonHostCapabilityTicket({ openChannel });
  if (!ticket.ok) {
    return { available: false, kind: "unusable", reason: ticket.reason };
  }
  throwIfAborted(options.signal);

  const webSocket = await openDaemonHostWebSocket({
    openChannel,
    capability: ticket.ticket.capability,
  });
  throwIfAborted(options.signal);

  const socket = wrapDaemonWebSocket(webSocket);
  const protocol = new SocketProtocol(socket);
  const client = new ChannelClient(protocol);
  const services = new RemoteServiceAccess(client);

  let reported = false;
  let backendDisconnectDisposable: { dispose(): void } | undefined;
  const reportClose = (event: DaemonCloseEvent) => {
    if (reported) return;
    reported = true;
    backendDisconnectDisposable?.dispose();
    options.onDidDaemonClose?.(event);
  };
  backendDisconnectDisposable = backend.onDidDisconnect?.((event) => {
    // SSH 通道断开：daemon 很可能仍 ready（SPIKE §4.4 实测 kill 隧道后 status 仍 ready），
    // 所以报 backend-disconnected 而不是 daemon-unavailable —— 第二阶段据此重连而非重建。
    reportClose({
      reason: "backend-disconnected",
      code: BACKEND_DISCONNECT_CODE,
      ...(event.error?.message ? { message: event.error.message } : {}),
    });
  });
  const onSocketClose = socket.onClose(() => {
    reportClose({ reason: "connection-closed", code: 0 });
  });

  let disposed = false;
  const disposeConnection = () => {
    if (disposed) return;
    disposed = true;
    onSocketClose.dispose();
    backendDisconnectDisposable?.dispose();
    client.dispose();
    protocol.dispose();
    // 只断 WS：daemon 是独立常驻进程，会话（pty/agent scope）必须活下来。
    // backend（SSH 连接）由窗口级 registry 统一管理，这里也不 dispose。
    socket.dispose();
  };

  return {
    available: true,
    connection: {
      services,
      client,
      transport: "daemon",
      serverId: admission.serverId,
      daemon: {
        host: daemon.host,
        port: daemon.port,
        ...(daemon.generation !== undefined ? { generation: daemon.generation } : {}),
        ...(daemon.pid !== undefined ? { pid: daemon.pid } : {}),
        serverRoot,
        bin,
      },
      dispose: disposeConnection,
      disposeAndWait: async (disposeOptions) => {
        if (disposed) return;
        const timeoutMs = Math.max(disposeOptions?.timeoutMs ?? 2_000, 0);
        const closed = new Promise<void>((resolve) => {
          if (webSocket.readyState === webSocket.CLOSED) {
            resolve();
            return;
          }
          webSocket.once("close", () => resolve());
        });
        disposeConnection();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        });
        await Promise.race([closed, deadline]);
        if (timer) clearTimeout(timer);
      },
    },
  };
}

/** 拉起后轮询 status 直到 ready（端口每次启动都会变，必须重读）。 */
async function waitForDaemonReady(
  backend: IRemoteBackend,
  options: DaemonConnectOptions,
): Promise<Extract<DaemonProbeOutcome, { kind: "ready" }> | null> {
  const budgetMs = Math.max(options.startReadyTimeoutMs ?? 10_000, 0);
  const deadline = Date.now() + budgetMs;
  for (;;) {
    throwIfAborted(options.signal);
    const probe = await probeDaemonServer(backend, {
      env: options.env,
      ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    });
    if (probe.kind === "ready") return probe;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, DAEMON_READY_POLL_INTERVAL_MS));
  }
}
