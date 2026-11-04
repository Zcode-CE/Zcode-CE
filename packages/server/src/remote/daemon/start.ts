import { formatLogPrefix } from "@zcode/shared";
import type { IRemoteBackend } from "../backend.js";
import { quoteRemotePath, runRemoteCommand } from "./probe.js";

/**
 * 远程起 daemon 的超时预算。CLI 自己会轮询到 ready（10s 预算），这里多留余量给冷启动。
 */
const START_DAEMON_TIMEOUT_MS = 60_000;

/**
 * 在远端拉起常驻 daemon（已安装、未运行的情形）。
 *
 * 必须带 `ZCODE_SERVER_SKIP_SERVICE_REGISTRATION=1`：`serve --daemon` 默认走
 * systemd --user / launchd / schtasks 注册，而裸 SSH 的非登录 shell 常常没有
 * XDG_RUNTIME_DIR / DBUS_SESSION_BUS_ADDRESS；即使注册成功，注销后存活还需要
 * `loginctl enable-linger`（非 root 远程机通常做不到）。跳过后是 detached fork，
 * 进程独立于连接存活（SPIKE §4.2 实测）。
 *
 * 起完不在这里读端口：CLI 已经等到 ready，调用方重新 `status --json` 取最新端口
 * （端口每次启动都变，不能沿用启动前的快照）。
 */
export async function startRemoteDaemon(
  backend: IRemoteBackend,
  params: { bin: string; serverRoot: string; timeoutMs?: number },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const log = (...args: unknown[]) =>
    console.log(formatLogPrefix("remote-daemon", process.pid), ...args);
  const command =
    "ZCODE_SERVER_SKIP_SERVICE_REGISTRATION=1 " +
    quoteRemotePath(params.bin) +
    " serve --daemon --server-root " +
    quoteRemotePath(params.serverRoot);
  log("starting remote daemon", { bin: params.bin, serverRoot: params.serverRoot });
  let result: { stdout: string; stderr: string; code: number };
  try {
    result = await runRemoteCommand(backend, command, params.timeoutMs ?? START_DAEMON_TIMEOUT_MS);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (result.code === -1) {
    return { ok: false, reason: "serve --daemon timed out" };
  }
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().slice(-500);
    return { ok: false, reason: `serve --daemon exited ${result.code}: ${detail}` };
  }
  return { ok: true };
}
