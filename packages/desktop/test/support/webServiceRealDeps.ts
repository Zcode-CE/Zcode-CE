import { spawn, type ChildProcess } from "node:child_process";
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
