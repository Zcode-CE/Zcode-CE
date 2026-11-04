import { formatLogPrefix } from "@zcode/shared";
import type { IRemoteBackend, StdioStream } from "../backend.js";
import type { DaemonProbeOutcome, DaemonReadyStatus, DaemonStatusSnapshot } from "./types.js";

/** 一次 `status --json` 的预算：远端 shell 起一次进程通常 < 1s；超时按不可用处理。 */
const STATUS_COMMAND_TIMEOUT_MS = 8_000;

/**
 * 候选可执行文件顺序（Lead 决策 #1）：
 * 1. `ZCODE_SERVER_BIN` —— 显式覆盖（用户/CI 指定非标准安装位置）；
 * 2. `~/.zcode/server/bin/zcode-server` —— 安装器的默认落点；
 * 3. PATH 上的 `zcode-server` —— 系统包管理器/自建安装。
 * 只做检测，不安装、不升级：不可用时调用方回退 stdio（现有链路零变化）。
 */
export function resolveDaemonServerCandidates(input: {
  env: Record<string, string | undefined>;
  homeDir: string;
}): string[] {
  const explicit = input.env.ZCODE_SERVER_BIN?.trim();
  const home = input.homeDir.replace(/\/+$/u, "");
  return [
    ...(explicit ? [explicit] : []),
    `${home}/.zcode/server/bin/zcode-server`,
    "zcode-server",
  ];
}

/**
 * 解析 `status --json`。
 *
 * 三态判据来自 server-cli 的 `serverStatusSchema`（strict，一律退出码 0，所以不能靠退出码
 * 判断「未安装」）：
 *   - `installed: false` ⇒ 未安装（install.json 不存在）；
 *   - `installed: true` + `state: "stopped"` ⇒ 已安装未运行（可以起）；
 *   - `state: "ready"` + `port` ⇒ 运行中，直接用该端口。
 * 崩溃时 `lastExitReason` 会带 `(core log: <path>)`，这里原样保留供诊断引用。
 *
 * 为什么不用 `run/status.json`：文件是 Supervisor 的持久化快照，路径依赖数据根；CLI 的
 * `status` 走同一状态源且做版本兼容（Lead 决策 #2）。解析要容忍 SSH banner 行。
 */
export function parseDaemonStatusJson(
  raw: string,
): { ok: true; status: DaemonStatusSnapshot } | { ok: false; reason: string } {
  const candidates = [
    raw.trim(),
    ...raw
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .reverse(),
  ];
  let lastError = "no JSON object found";
  for (const candidate of candidates) {
    if (!candidate.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        lastError = "status JSON is not an object";
        continue;
      }
      const record = parsed as Record<string, unknown>;
      if (typeof record.state !== "string" || record.state.length === 0) {
        lastError = "status JSON has no state";
        continue;
      }
      return {
        ok: true,
        status: {
          state: record.state,
          // installed 缺省按 true 处理：老版本 CLI 没有该字段但能返回 state 就说明装过。
          installed: record.installed === false ? false : true,
          ...(typeof record.pid === "number" ? { pid: record.pid } : {}),
          ...(typeof record.host === "string" && record.host ? { host: record.host } : {}),
          ...(typeof record.port === "number" ? { port: record.port } : {}),
          ...(typeof record.generation === "number" ? { generation: record.generation } : {}),
          ...(typeof record.version === "string" ? { version: record.version } : {}),
          ...(typeof record.protocolVersion === "number"
            ? { protocolVersion: record.protocolVersion }
            : {}),
          ...(typeof record.lastExitReason === "string"
            ? { lastExitReason: record.lastExitReason }
            : {}),
        },
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return { ok: false, reason: lastError };
}

/** 只有 ready 且给出合法端口的 daemon 才能承载会话。 */
export function toReadyStatus(
  status: DaemonStatusSnapshot,
): { ok: true; status: DaemonReadyStatus } | { ok: false; reason: string } {
  if (status.state !== "ready") {
    return { ok: false, reason: `daemon state is ${status.state}, not ready` };
  }
  if (typeof status.port !== "number" || !Number.isInteger(status.port) || status.port <= 0) {
    return { ok: false, reason: "daemon is ready but reported no usable port" };
  }
  return { ok: true, status: { ...status, host: status.host ?? "127.0.0.1", port: status.port } };
}

/** 执行一条远端命令并收集 stdout（带超时；不依赖 backend 的私有实现）。 */
export async function runRemoteCommand(
  backend: IRemoteBackend,
  command: string,
  timeoutMs = STATUS_COMMAND_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const stream: StdioStream = await backend.exec(command);
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    };
    const timer = setTimeout(() => finish(-1), timeoutMs);
    // daemon 探测失败不能拖住连接：超时后按「不可用」返回，stdout 里已收到的部分仍可用于诊断。
    timer.unref?.();
    stream.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    stream.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    stream.onClose((code) => finish(code ?? 0));
  });
}

/** 远端 daemon 的 server-root 默认值（与安装器/运行时根的约定一致）。 */
export function resolveDaemonServerRoot(env: Record<string, string | undefined>): string {
  return env.ZCODE_REMOTE_DAEMON_SERVER_ROOT?.trim() || "$HOME/.zcode/server";
}

/** 三态归类（不含 bin/serverRoot，由调用方补齐）。 */
export type DaemonStatusClass =
  | { kind: "ready"; status: DaemonReadyStatus }
  | { kind: "stopped" }
  | null;

/** 把候选执行结果归类（未安装返回 null，其它中间态由调用方按 unusable 处理）。 */
export function classifyDaemonStatus(status: DaemonStatusSnapshot): DaemonStatusClass {
  if (status.installed === false) return null;
  if (status.state === "ready") {
    const ready = toReadyStatus(status);
    return ready.ok ? { kind: "ready", status: ready.status } : null;
  }
  if (status.state === "stopped") return { kind: "stopped" };
  return null;
}

/**
 * 探测远端：装没装 `zcode-server`、装了自己报的是什么状态。
 *
 * 每次(重)连都重新执行（端口随 Core 启动变化，SPIKE §4.5）。结果不缓存。
 */
export async function probeDaemonServer(
  backend: IRemoteBackend,
  options: {
    env?: Record<string, string | undefined>;
    homeDir?: string;
    timeoutMs?: number;
  } = {},
): Promise<DaemonProbeOutcome> {
  const log = (...args: unknown[]) =>
    console.log(formatLogPrefix("remote-daemon", process.pid), ...args);
  if (!backend.openTcpipChannel) {
    return {
      kind: "unsupported",
      reason: "this remote transport cannot open a direct-tcpip channel (daemon needs SSH)",
    };
  }
  const env = options.env ?? process.env;
  const serverRoot = resolveDaemonServerRoot(env);
  const candidates = resolveDaemonServerCandidates({
    env,
    homeDir: options.homeDir ?? "~",
  });
  const failures: string[] = [];
  for (const bin of candidates) {
    const command = `${quoteRemotePath(bin)} status --json`;
    let result: { stdout: string; stderr: string; code: number };
    try {
      result = await runRemoteCommand(backend, command, options.timeoutMs);
    } catch (error) {
      failures.push(`${bin}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (result.code === -1) {
      failures.push(`${bin}: status --json timed out`);
      continue;
    }
    // 退出码非 0 只说明这个候选跑不起来（命令不存在/不可执行）⇒ 换下一个候选。
    // 「未安装」不是靠退出码判断的：server-cli 的 status 一律退出 0。
    if (result.code !== 0) {
      failures.push(`${bin}: status --json exited ${result.code}`);
      continue;
    }
    const parsed = parseDaemonStatusJson(result.stdout);
    if (!parsed.ok) {
      failures.push(`${bin}: ${parsed.reason}`);
      continue;
    }
    const status = parsed.status;
    if (status.installed === false) {
      log("daemon not installed on remote", { bin, serverRoot });
      return { kind: "not-installed", bin, serverRoot, coreLogPath: `${serverRoot}/run/core.log` };
    }
    const classified = classifyDaemonStatus(status);
    if (classified?.kind === "ready") {
      log("daemon ready", { bin, host: classified.status.host, port: classified.status.port });
      return { ...classified, bin, serverRoot };
    }
    if (classified?.kind === "stopped") {
      log("daemon installed but stopped", { bin, serverRoot });
      return { kind: "stopped", bin, serverRoot, coreLogPath: `${serverRoot}/run/core.log` };
    }
    // ready 但端口非法，或 crashed/starting 等中间态：都按「本次不可用」降级，
    // 但把 lastExitReason 与 core log 路径带出去（诊断入口）。
    return {
      kind: "unusable",
      reason:
        `daemon state is ${status.state}` +
        (status.lastExitReason ? `: ${status.lastExitReason}` : ""),
      bin,
      serverRoot,
      coreLogPath: `${serverRoot}/run/core.log`,
    };
  }
  const reason = failures.length === 0 ? "no zcode-server candidate" : failures.join("; ");
  log("daemon not available:", reason);
  return { kind: "not-installed", reason, serverRoot, coreLogPath: `${serverRoot}/run/core.log` };
}

/** 把探测结果转成一句可读的降级原因（connect-auto / UI 能力提示共用）。 */
export function describeDaemonProbeOutcome(probe: DaemonProbeOutcome): string {
  switch (probe.kind) {
    case "ready":
      return "daemon ready";
    case "stopped":
      return "daemon installed but not running";
    case "not-installed":
      return probe.reason ?? "远端未安装 zcode-server（装上后可获得常驻会话）";
    case "unusable":
      return probe.reason;
    case "unsupported":
      return probe.reason;
  }
}

/** `~` 不能被 shell 之外的层展开；统一交给远端 sh -lc 处理。 */
export function quoteRemotePath(path: string): string {
  if (path.startsWith("~/")) return `"$HOME"/${path.slice(2)}`;
  return JSON.stringify(path);
}
