import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isProcessAlive,
  probeWebService,
  type WebServiceProbeResult,
} from "../../src/main/web-service/probe.js";
import { readWebServiceState } from "../../src/main/web-service/state.js";
import { readWebServiceToken } from "../../src/main/web-service/token.js";
import type {
  WebServiceChildHandle,
  WebServiceControllerDeps,
} from "../../src/main/web-service/service.js";

/**
 * 测试用**真实**编排依赖：起真的 node 子进程、用真的 fetch 探活、用真的信号停止。
 *
 * 为什么不用全 fake：契约里最硬的一条是「`running` 时 start 不得起第二个进程」，
 * 而"进程"这件事恰恰是 fake 最容易造假的地方（计数器归零、pid 复用都不会被发现）。
 * 这里每个断言背后都有一个真实的、可被 `ps` 看到的子进程。
 */

const here = dirname(fileURLToPath(import.meta.url));
export const STUB_SERVER_PATH = resolve(here, "../fixtures/web-service-stub-server.mjs");
/** 「慢回收持有者」：spawn 替身服务后同步阻塞，期间不处理 SIGCHLD（见该文件的说明）。 */
export const SLOW_REAP_HOLDER_PATH = resolve(here, "../fixtures/web-service-slow-reap-holder.mjs");

export function pickFreePort(): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePromise(port));
    });
  });
}

export function isPortOpen(host: string, port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host, port });
    const done = (open: boolean) => {
      socket.destroy();
      resolvePromise(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/**
 * 等 pid 真的从进程表消失（不是只等端口释放）。
 *
 * 为什么需要它（CI run 36151161461 的根因）：SIGKILL 之后内核分两步收尾 ——
 * 先 exit_files 关掉监听 socket（端口立即释放），进程随后变成僵尸（/proc/<pid>/stat 的 state='Z'），
 * 而僵尸要等父进程（本测试进程）在事件循环里 waitpid 才从进程表消失。
 * 两步之间有一个窗口：端口已关、但 process.kill(pid, 0) 仍然成功（僵尸对 kill 可见）。
 * 只等端口释放就下结论时，窗口内的探活会跳过 pid-dead 分支、去探测端口，
 * 拿到 ECONNREFUSED ⇒ reason 变成 port-closed。
 *
 * 实测（本机，SIGKILL 后同步采样 20 次）：端口不再 LISTEN 的那一刻，pid 全部仍可见且 state='Z'；
 * 不给事件循环时僵尸可留存数秒，给一次事件循环轮次即被回收。本地该窗口约 0.1ms，
 * 测试进程恰好在中间转过一次事件循环 ⇒ 5/5 绿；CI runner 上测试进程会在 kill 之后被调度出去
 * （并行跑多个测试文件），回来时端口已关、事件循环一次都没转 ⇒ 复现。
 *
 * 语义上「等 pid 消失」强于「等端口释放」：端口在 exit_files 阶段就释放，早于僵尸产生
 * ⇒ pid 消失必然蕴含端口已释放。
 */
export async function waitForProcessGone(pid: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(
    `进程 ${pid} 在 ${timeoutMs}ms 内没有从进程表消失 —— 无法判定 pid-dead（可能是 pid 被复用）`,
  );
}

/**
 * 把替身服务挂在一个「故意不回收僵尸」的父进程下启动，返回替身服务的 pid 与释放函数。
 *
 * 为什么需要它：SIGKILL 之后「端口已释放」与「pid 从进程表消失」不是同一时刻（见 waitForProcessGone 的说明），
 * 而本地这个窗口只有约 0.1ms，无法稳定测到。持有者用 Atomics.wait 同步阻塞、不读 SIGCHLD 管道
 * ⇒ 僵尸不被回收，窗口被拉到秒级 ⇒ 竞态可确定性复现。
 *
 * 释放方式：SIGKILL 持有者，僵尸被 reparent 给 init 回收（实测 pid 约 10ms 内消失）。
 */
export async function startStubUnderSlowReaper(input: {
  port: number;
  tokenPath: string;
  blockMs?: number;
}): Promise<{ stubPid: number; release: () => Promise<void> }> {
  const pidFile = resolve(
    dirname(input.tokenPath),
    `slow-reap-stub-${process.pid}-${Date.now()}.pid`,
  );
  const holder = spawn(process.execPath, [SLOW_REAP_HOLDER_PATH, STUB_SERVER_PATH], {
    env: {
      ...process.env,
      PORT: String(input.port),
      ZCODE_SERVER_HOST: "127.0.0.1",
      ZCODE_SERVER_AUTH_TOKENS_FILE: input.tokenPath,
      HOLDER_PID_FILE: pidFile,
      HOLDER_BLOCK_MS: String(input.blockMs ?? 60_000),
    },
    stdio: "ignore",
  });

  let stubPid = 0;
  for (let i = 0; i < 400; i += 1) {
    try {
      stubPid = Number(await readFile(pidFile, "utf8"));
      if (Number.isInteger(stubPid) && stubPid > 0) break;
    } catch {
      // 还没写出来
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  if (!Number.isInteger(stubPid) || stubPid <= 0) {
    holder.kill("SIGKILL");
    throw new Error("慢回收持有者没有写出替身服务的 pid");
  }

  let released: Promise<void> | undefined;
  const release = (): Promise<void> => {
    // 幂等：测试的 finally 与中间断言都会调它，重复调用不得抛错。
    released ??= (async () => {
      // 先把替身服务本身杀掉：断言失败时它可能还活着，留着会让 withHarness 的清理变慢、
      // 也会让下一条用例拿到一个占着端口的孤儿。杀不存在的进程会抛，忽略即可。
      try {
        process.kill(stubPid, "SIGKILL");
      } catch {
        // 已经不在了
      }
      // 持有者被 kill ⇒ 僵尸 reparent 给 init 回收（否则僵尸要等持有者自己结束才被回收）。
      try {
        holder.kill("SIGKILL");
      } catch {
        // 已退出
      }
      await waitForProcessGone(stubPid);
    })();
    return released;
  };

  return { stubPid, release };
}

async function probeServerInfo(input: {
  url: string;
  token: string | undefined;
  timeoutMs: number;
}) {
  try {
    const response = await fetch(
      input.token
        ? `${input.url}/api/server-info?token=${encodeURIComponent(input.token)}`
        : `${input.url}/api/server-info`,
      { signal: AbortSignal.timeout(input.timeoutMs) },
    );
    return response.status;
  } catch (error) {
    const code = (error as { cause?: { code?: string }; name?: string }).cause?.code;
    if (code === "ECONNREFUSED") return "network";
    if ((error as Error).name === "TimeoutError" || (error as Error).name === "AbortError") {
      return "timeout";
    }
    return "network";
  }
}

export interface RealDepsHarness {
  deps: WebServiceControllerDeps;
  spawnCount: () => number;
  liveChildren: () => ChildProcess[];
  killAll: () => void;
}

export function createRealDeps(input: {
  statePath: string;
  tokenPath: string;
  staticRoot?: string;
  readyTimeoutMs?: number;
  stopGraceMs?: number;
}): RealDepsHarness {
  const children: ChildProcess[] = [];
  let spawns = 0;

  const probe = async (): Promise<WebServiceProbeResult> =>
    probeWebService({
      statePath: input.statePath,
      readState: readWebServiceState,
      readToken: readWebServiceToken,
      isPidAlive: isProcessAlive,
      probeServerInfo,
      timeoutMs: 800,
    });

  const waitForExit = (child: WebServiceChildHandle, timeoutMs: number) =>
    new Promise<boolean>((resolvePromise) => {
      const target = children.find((candidate) => candidate.pid === child.pid);
      if (!target) {
        resolvePromise(false);
        return;
      }
      const timer = setTimeout(() => resolvePromise(false), timeoutMs);
      target.once("exit", () => {
        clearTimeout(timer);
        resolvePromise(true);
      });
    });

  const deps: WebServiceControllerDeps = {
    statePath: input.statePath,
    tokenPath: input.tokenPath,
    entryPath: STUB_SERVER_PATH,
    nodeExecPath: process.execPath,
    ...(input.staticRoot ? { staticRoot: input.staticRoot } : {}),
    workspacePath: "/abs/ws",
    spawnChild: ({ entryPath, env }) => {
      spawns += 1;
      const child = spawn(process.execPath, [entryPath], {
        env: { ...process.env, ...env },
        stdio: "ignore",
      });
      children.push(child);
      return {
        pid: child.pid,
        kill: (signal) => child.kill(signal),
        onExit: (listener) => child.once("exit", listener),
      };
    },
    probe,
    pickFreePort: async (preferred) =>
      (await isPortOpen("127.0.0.1", preferred)) ? pickFreePort() : preferred,
    waitUntilReady: async ({ url, token, timeoutMs }) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const status = await probeServerInfo({ url, token, timeoutMs: 500 });
        if (typeof status === "number" && status >= 200 && status < 300) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;
    },
    waitForExit,
    killPid: async ({ pid, host, port, graceMs }) => {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        return !(await isPortOpen(host, port));
      }
      const deadline = Date.now() + graceMs;
      while (Date.now() < deadline) {
        if (!isProcessAlive(pid)) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      if (isProcessAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* 已退出 */
        }
        const hardDeadline = Date.now() + graceMs;
        while (Date.now() < hardDeadline && isProcessAlive(pid)) {
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      return !(await isPortOpen(host, port));
    },
    now: () => Date.now(),
    readyTimeoutMs: input.readyTimeoutMs ?? 10_000,
    stopGraceMs: input.stopGraceMs ?? 3_000,
  };

  return {
    deps,
    spawnCount: () => spawns,
    liveChildren: () => children.filter((child) => child.exitCode === null && !child.killed),
    killAll: () => {
      for (const child of children) {
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    },
  };
}

export async function readTokenForTest(path: string): Promise<string | undefined> {
  return readWebServiceToken(path);
}
