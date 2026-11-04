import type { Duplex } from "node:stream";

/**
 * 远端常驻 daemon 传输的共享类型（第一片：传输与准入）。
 *
 * 依据：`.local/reports/remote/persistent-session/SPIKE.md`。关键约束：
 * - 端口每次 Core(重)启动都会变 ⇒ 每次(重)连都必须重新执行 `zcode-server status --json`；
 * - `/ws/host` 要一次性 ticket（TTL 30s，重放必 401）⇒ 禁止缓存；
 * - daemon 只监听回环 ⇒ 桌面必须经 SSH `direct-tcpip`（`forwardOut`）到达该端口；
 * - 远程起 daemon 必须 `ZCODE_SERVER_SKIP_SERVICE_REGISTRATION=1`（裸 SSH 非登录 shell
 *   通常缺 XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS，服务注册不可假设可用）。
 */

/**
 * `zcode-server status --json` 的解析结果（对应 server-cli 的 serverStatusSchema 子集）。
 * 注意：该命令一律退出码 0，「未安装」只体现在 `installed: false` 上。
 */
export interface DaemonStatusSnapshot {
  state: string;
  installed: boolean;
  pid?: number;
  host?: string;
  port?: number;
  /** Supervisor 的 Core 世代号；daemon 重启后变化 ⇒ 会话全丢（SPIKE §4.5）。 */
  generation?: number;
  version?: string;
  protocolVersion?: number;
  /** 崩溃原因；带 `(core log: <path>)` 时可直接引用该日志。 */
  lastExitReason?: string;
}

/** 已就绪且拿到可用端口的状态。 */
export interface DaemonReadyStatus extends DaemonStatusSnapshot {
  host: string;
  port: number;
}

/**
 * 探测三态 + 两种降级原因（Lead 决策：未安装→降级 stdio 并给 UI 提示；已安装未运行→起
 * daemon；运行中→直连）。
 */
export type DaemonProbeOutcome =
  | { kind: "ready"; status: DaemonReadyStatus; bin: string; serverRoot: string }
  /** 已安装但没在跑：可以现场起（skip-registration，detached）。 */
  | { kind: "stopped"; bin: string; serverRoot: string; coreLogPath: string }
  /** 远端没有 zcode-server：回退 stdio，并把「装上可获得常驻会话」作为能力提示。 */
  | {
      kind: "not-installed";
      bin?: string;
      serverRoot: string;
      reason?: string;
      coreLogPath?: string;
    }
  /** 装了但当前不可用（crashed/starting 等）：回退 stdio，带 lastExitReason + core log。 */
  | { kind: "unusable"; reason: string; bin: string; serverRoot: string; coreLogPath: string }
  /** 该 transport 没有 direct-tcpip 能力（WSL/Docker）：本片不覆盖。 */
  | { kind: "unsupported"; reason: string };

/**
 * 一条到远端回环端口的字节通道（SSH direct-tcpip）。
 * 每次 HTTP 请求/WS 升级各开一条：HTTP keep-alive 关闭时 Node 会销毁底层 socket，
 * 复用同一条通道会让第二个请求直接 ECONNRESET（原型实测）。
 */
export type DaemonChannelFactory = () => Promise<Duplex>;

/** 远端事件：区分「连接断了」与「daemon 没了」，第二阶段状态机据此决定重连还是重建。 */
export type DaemonCloseReason =
  /** WS 关闭：可能只是链路/进程问题，daemon 往往仍 ready ⇒ 可重连。 */
  | "connection-closed"
  /** SSH 通道断开（半开/keepalive/隧道丢失）：daemon 可能仍存活。 */
  | "backend-disconnected"
  /** 探测或状态查询表明 daemon 不可用（未安装/未 ready）⇒ 需要重建或回退 stdio。 */
  | "daemon-unavailable";

export interface DaemonCloseEvent {
  reason: DaemonCloseReason;
  code: number;
  message?: string;
}
