import { dirname } from "node:path";
import {
  ensureWebServiceDir,
  readWebServiceState,
  removeWebServiceState,
  writeWebServiceState,
} from "./state.js";
import { buildWebServiceUrl, probeWebService, type WebServiceProbeResult } from "./probe.js";
import { ensureWebServiceToken } from "./token.js";

/**
 * 本地 Web 服务的编排层（契约 §1/§3/§6）。
 *
 * 主进程**只做编排**：它不代理 HTTP、不持有服务状态机 —— 服务本体是它启动的子进程，
 * 磁盘上的 `web-service.json` 才是"当前有没有在跑"的持久依据（进程内状态会在重启后说谎）。
 *
 * **最硬的一条不变式（契约 §4 末段）**：`state === "running"` 时 `start` 必须**拒绝启动第二个进程**
 * 并返回接管信息。实现方式是"先探活、探活说在跑就直接返回，绝不 spawn"——
 * 这样幂等性由**探活判据**保证，而不是靠某个进程内 flag（flag 在第二个窗口/重启后无效，
 * 而同一台机器上我们启动的服务必须至多一个）。
 *
 * IO 全部注入：`spawnChild` / 探活 / 端口选择 / 等待就绪 / 时钟都可替换 ⇒
 * 幂等性、stale 覆盖、退出清理都能在测试里用**真实子进程**跑到，不依赖 Electron。
 */

export const WEB_SERVICE_DEFAULT_PORT = 3030;
export const WEB_SERVICE_READY_TIMEOUT_MS = 15_000;
export const WEB_SERVICE_STOP_GRACE_MS = 5_000;

/**
 * 对外状态。**只列真正会被产出的取值**（穷尽核对过 `statusFromProbe` 与 `start/stop` 的所有 return 点）。
 *
 * 原先这里还有 `"starting"` 与 `"stopping"`，但**全仓没有任何地方产出它们**
 * （task-83 同批发现：这是与 `stale` 同一类的死分支）。原因：`start`/`stop` 是
 * **同步等待到最终态**才返回的，IPC 也只在动作**之后**广播一次 ⇒ 中间态根本没有出口。
 * 保留它们会让每个 `switch (state)` 都得为不可达取值写分支，而"永不触发的分支"
 * 正是本轮反复抓到的缺陷类型（AGENTS.md：否定式断言必须穷尽验证）。
 *
 * 过渡态的**用户可见反馈由渲染进程自己做**（面板的 `pendingAction` 禁用按钮 +
 * `starting`/`stopping` 文案由 UI 的本地 in-flight 状态承载），不需要主进程伪造一个状态。
 */
export type WebServiceState = "stopped" | "running" | "running-untrusted" | "failed";

export type WebServiceErrorCode =
  | "spawn-failed"
  | "port-taken"
  | "probe-timeout"
  | "token-unreadable"
  | "non-loopback-without-token";

/** 契约 §4 的 `stale` 细分原因（探活层已经算出来了，这里如实上抛，不再丢掉）。 */
export type WebServiceStaleReason = "pid-dead" | "port-closed" | "probe-timeout";

export interface WebServiceStatus {
  state: WebServiceState;
  adopted: boolean;
  loopback: boolean;
  host?: string;
  port?: number;
  url?: string;
  startedAt?: number;
  error?: { code: WebServiceErrorCode; message: string };
  /**
   * **仅在 `state === "stopped"` 且这是"陈旧条目"时出现**：上一次的服务已不在
   * （pid 已死 / 端口已关 / 探活超时），但状态文件仍留着（契约 §3 规则 2）。
   *
   * 为什么用可选字段而不是给 `state` 加一个 `"stale"` 取值：
   * `stopped` 必须继续是"服务没在跑"的**唯一**取值，否则每一处 `state === "stopped"` 的读法
   * 都要改成两值判断，漏一处就会把陈旧条目当成"从没开过"或反过来当成在跑。
   * `stale` 描述的是**我们留下的记录**陈旧，不是服务处于第二个状态 ——
   * 它是"为什么没在跑"的注解。
   */
  staleReason?: WebServiceStaleReason;
}

export interface WebServiceChildHandle {
  readonly pid: number | undefined;
  kill: (signal: NodeJS.Signals) => void;
  onExit: (listener: (code: number | null, signal: NodeJS.Signals | null) => void) => void;
}

export interface WebServiceControllerDeps {
  statePath: string;
  tokenPath: string;
  /** 随包的 HTTP 入口（`zcode-server-http.cjs`）绝对路径。 */
  entryPath: string;
  /** 用于起子进程的可执行文件；Electron 下是 `process.execPath` + `ELECTRON_RUN_AS_NODE=1`。 */
  nodeExecPath: string;
  staticRoot?: string;
  workspacePath?: string;
  /** 子进程额外环境变量（生产实现会注入 `ELECTRON_RUN_AS_NODE=1`）。 */
  childEnv?: Record<string, string>;
  spawnChild: (input: {
    entryPath: string;
    args: readonly string[];
    env: Record<string, string>;
  }) => WebServiceChildHandle;
  probe: () => Promise<WebServiceProbeResult>;
  /** 选一个空闲端口；`preferred` 可用时应当原样返回它。 */
  pickFreePort: (preferred: number) => Promise<number>;
  waitUntilReady: (input: { url: string; token: string; timeoutMs: number }) => Promise<boolean>;
  waitForExit: (child: WebServiceChildHandle, timeoutMs: number) => Promise<boolean>;
  /**
   * 停止状态文件里指名的 pid：SIGTERM → 宽限 → 必要时 SIGKILL → **确认端口已释放**。
   * 返回 `false` 表示没能停干净（这时**不删**状态文件，让探活继续判 stale）。
   */
  killPid: (input: {
    pid: number;
    host: string;
    port: number;
    graceMs: number;
  }) => Promise<boolean>;
  now?: () => number;
  readyTimeoutMs?: number;
  stopGraceMs?: number;
}

export interface WebServiceController {
  status: () => Promise<WebServiceStatus>;
  start: (options?: { scope?: "loopback" | "lan"; port?: number }) => Promise<WebServiceStatus>;
  stop: () => Promise<WebServiceStatus>;
  connectionInfo: () => Promise<{ url: string; linkWithToken: string } | null>;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized === "localhost"
  );
}

function statusFromProbe(probe: WebServiceProbeResult): WebServiceStatus {
  switch (probe.state) {
    case "stopped":
      return { state: "stopped", adopted: false, loopback: true };
    case "stale":
      // 契约 §3 的文案表给了 stale 一行（"上一次的服务已不在，可重新开启"），而对外状态
      // 原本无法表达它 ⇒ 面板那条文案**不可达**（task-83）。这里把探活已经算出来的 reason
      // 如实带出去，让"从未开启"与"上次异常退出、记录还在"可区分。
      // loopback 仍为 true：进程已死 ⇒ 没有任何监听面暴露，不该触发局域网告警。
      return {
        state: "stopped",
        adopted: false,
        loopback: true,
        staleReason: probe.reason,
      };
    case "running":
      return {
        state: "running",
        adopted: probe.adopted,
        loopback: isLoopbackHost(probe.host),
        host: probe.host,
        port: probe.port,
        url: probe.url,
        startedAt: probe.startedAt,
      };
    case "running-untrusted":
      return {
        state: "running-untrusted",
        adopted: false,
        loopback: isLoopbackHost(probe.host),
        host: probe.host,
        port: probe.port,
        url: buildWebServiceUrl(probe.host, probe.port),
      };
  }
}

export function createWebServiceController(deps: WebServiceControllerDeps): WebServiceController {
  const now = deps.now ?? (() => Date.now());
  const readyTimeoutMs = deps.readyTimeoutMs ?? WEB_SERVICE_READY_TIMEOUT_MS;
  const stopGraceMs = deps.stopGraceMs ?? WEB_SERVICE_STOP_GRACE_MS;

  const status = async (): Promise<WebServiceStatus> => statusFromProbe(await deps.probe());

  /**
   * 停止一个**由状态文件指名**的进程：SIGTERM → 宽限 → SIGKILL → 确认端口释放（契约 §6.4）。
   *
   * 刻意不复用 `spawnChild`：我们手上只有一个 pid（可能是**上一次启动**留下的、或用户自己跑的
   * `zcode --web`），不能为了停止它再起一个进程。真实实现见 `runtime.ts` 的 `killPid`。
   */
  const terminatePid = (pid: number, host: string, port: number): Promise<boolean> =>
    deps.killPid({ pid, host, port, graceMs: stopGraceMs });

  const start = async (
    options: { scope?: "loopback" | "lan"; port?: number } = {},
  ): Promise<WebServiceStatus> => {
    // ① 先探活：在跑就接管，**绝不 spawn**（幂等性的唯一依据）。
    const before = await deps.probe();
    if (before.state === "running" || before.state === "running-untrusted") {
      return statusFromProbe(before);
    }

    const scope = options.scope ?? "loopback";
    const host = scope === "loopback" ? "127.0.0.1" : "0.0.0.0";

    // ② 令牌：非回环没有可用令牌来源时**拒绝启动**（契约 §6.1）。
    let token: string;
    try {
      token = await ensureWebServiceToken(deps.tokenPath);
    } catch (error) {
      return {
        state: "failed",
        adopted: false,
        loopback: scope === "loopback",
        error: {
          code: "token-unreadable",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    if (scope !== "loopback" && token.trim().length === 0) {
      return {
        state: "failed",
        adopted: false,
        loopback: false,
        error: {
          code: "non-loopback-without-token",
          message: "Non-loopback listen requires a usable auth token file.",
        },
      };
    }

    // ③ 端口：显式指定且被占用 ⇒ 明确失败（不偷偷换端口，否则用户复制出去的链接是错的）；
    //    用默认端口且被占用 ⇒ 选下一个空闲端口（契约 §2）。
    const requestedPort = options.port ?? WEB_SERVICE_DEFAULT_PORT;
    const explicitPort = options.port !== undefined;
    let port: number;
    try {
      port = await deps.pickFreePort(requestedPort);
    } catch (error) {
      return {
        state: "failed",
        adopted: false,
        loopback: scope === "loopback",
        error: {
          code: "port-taken",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    if (explicitPort && port !== requestedPort) {
      return {
        state: "failed",
        adopted: false,
        loopback: scope === "loopback",
        error: {
          code: "port-taken",
          message: `Port ${requestedPort} is already in use.`,
        },
      };
    }

    await ensureWebServiceDir(dirname(deps.statePath));
    const url = buildWebServiceUrl(host, port);
    const env: Record<string, string> = {
      // 端口用 `PORT`、令牌文件用复数名 —— 这两个名字以消费端 entry-http.ts 为准
      // （契约 §2 已订正：原名 ZCODE_SERVER_PORT / ZCODE_SERVER_AUTH_TOKEN_FILE 全仓 0 命中）。
      PORT: String(port),
      ZCODE_SERVER_HOST: host,
      ZCODE_SERVER_AUTH_TOKENS_FILE: deps.tokenPath,
      ...(deps.staticRoot ? { ZCODE_WEB_STATIC_ROOT: deps.staticRoot } : {}),
      ...(deps.workspacePath ? { ZCODE_SERVER_WORKSPACE: deps.workspacePath } : {}),
      ...(deps.childEnv ?? {}),
    };

    let child: WebServiceChildHandle;
    try {
      child = deps.spawnChild({ entryPath: deps.entryPath, args: [], env });
    } catch (error) {
      return {
        state: "failed",
        adopted: false,
        loopback: scope === "loopback",
        error: {
          code: "spawn-failed",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }

    const ready = await deps.waitUntilReady({ url, token, timeoutMs: readyTimeoutMs });
    if (!ready) {
      // 起不来就把子进程收干净再报错（否则会留下一个占着端口的孤儿）。
      if (child.pid !== undefined) {
        child.kill("SIGTERM");
        await deps.waitForExit(child, stopGraceMs);
      }
      return {
        state: "failed",
        adopted: false,
        loopback: scope === "loopback",
        host,
        port,
        error: {
          code: "probe-timeout",
          message: `Service did not become ready within ${readyTimeoutMs}ms.`,
        },
      };
    }

    // ④ 只有"启动成功且探活通过"之后才写状态（契约 §3 规则 1）。
    await writeWebServiceState(deps.statePath, {
      pid: child.pid ?? 0,
      host,
      port,
      ...(deps.workspacePath ? { workspacePath: deps.workspacePath } : {}),
      tokenFile: deps.tokenPath,
      ...(deps.staticRoot ? { staticRoot: deps.staticRoot } : {}),
      startedAt: now(),
      entry: entryFileName(deps.entryPath),
    });

    return {
      state: "running",
      adopted: false,
      loopback: scope === "loopback",
      host,
      port,
      url,
      startedAt: now(),
    };
  };

  const stop = async (): Promise<WebServiceStatus> => {
    const record = await readWebServiceState(deps.statePath);
    if (!record) return statusFromProbe(await deps.probe());
    const stopped = await terminatePid(record.pid, record.host, record.port);
    if (!stopped) {
      return {
        state: "failed",
        adopted: false,
        loopback: isLoopbackHost(record.host),
        host: record.host,
        port: record.port,
        error: {
          code: "probe-timeout",
          message: `Process ${record.pid} did not exit and release port ${record.port}.`,
        },
      };
    }
    // 契约 §3 规则 2：**我们主动停止且子进程已退出**之后才删；异常退出保留文件（判 stale）。
    await removeWebServiceState(deps.statePath);
    return { state: "stopped", adopted: false, loopback: isLoopbackHost(record.host) };
  };

  const connectionInfo = async (): Promise<{ url: string; linkWithToken: string } | null> => {
    const current = await status();
    if (current.state !== "running" || !current.host || !current.port) return null;
    const token = await ensureWebServiceToken(deps.tokenPath);
    const url = buildWebServiceUrl(current.host, current.port);
    // 令牌**只**经这条通道交给渲染进程（契约 §5 约定）；status 与日志里都不出现它。
    return { url, linkWithToken: `${url}/?token=${encodeURIComponent(token)}` };
  };

  return { status, start, stop, connectionInfo };
}

function entryFileName(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
}
