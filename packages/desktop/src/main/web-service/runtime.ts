import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, createConnection } from "node:net";
import { join } from "node:path";
import { resolveWebServiceStatePath, resolveWebServiceTokenPath } from "./paths.js";
import { isProcessAlive, probeWebService } from "./probe.js";
import { readWebServiceState, type WebServiceStateRecord } from "./state.js";
import {
  createWebServiceController,
  WEB_SERVICE_DEFAULT_PORT,
  WEB_SERVICE_READY_TIMEOUT_MS,
  WEB_SERVICE_STOP_GRACE_MS,
  type WebServiceChildHandle,
  type WebServiceController,
} from "./service.js";
import { readWebServiceToken } from "./token.js";

/**
 * 「本地 Web 服务」的**生产者**（task-80 步骤 4 的第 1 件）：把 resources 里的三份资产解析出来，
 * 并把服务编排层需要的能力（spawn / 探活 / 选端口 / 等就绪 / 等退出 / 停 pid）实现好注入进去。
 *
 * 为什么单独一层：`service.ts` 只做编排与状态，**不碰** Electron、不碰 `process.resourcesPath`、不碰进程表；
 * 这样它能在纯 Node 测试里跑（既有 17 条测试就是这么做的），而"生产路径长什么样"集中在这里一处。
 * 依赖注入面与 electron-builder 的 extraResources 布局一一对应（见 electron-builder.config.js 的 web-service 三条）。
 */

export interface WebServiceRuntimePaths {
  /** 随包的 HTTP 入口（`resources/web-service/zcode-server-http.cjs`）。 */
  entryPath: string;
  /** 面板静态资源根（`resources/web-service/web`）；缺失 ⇒ 只有 API 面。 */
  staticRoot: string;
  /** node-pty 原生件（`resources/web-service/build/Release/pty.node`）。 */
  ptyNodePath: string;
}

export interface WebServiceRuntimeOptions {
  /** 生产：`process.resourcesPath`。测试/开发可指向任意布局。 */
  resourceRoot: string;
  /** 开发态兜底：resources 布局不存在时用仓库路径（仅本地开发与测试）。 */
  fallbackRoot?: string;
  workspacePath?: string;
  statePath?: string;
  tokenPath?: string;
  /** 起子进程的可执行文件；Electron 下是 `process.execPath`。 */
  nodeExecPath?: string;
  /** 子进程额外 env（Electron 下注入 `ELECTRON_RUN_AS_NODE=1`）。 */
  childEnv?: Record<string, string>;
  /** 子进程 stdout/stderr 的转发口（默认丢弃）。 */
  onChildOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

/** 三份随包资产的位置：优先 resources，其次开发态仓库路径。 */
export function resolveWebServiceRuntimePaths(options: {
  resourceRoot: string;
  fallbackRoot?: string;
}): WebServiceRuntimePaths {
  const packaged = {
    entryPath: join(options.resourceRoot, "web-service", "zcode-server-http.cjs"),
    staticRoot: join(options.resourceRoot, "web-service", "web"),
    ptyNodePath: join(options.resourceRoot, "web-service", "build", "Release", "pty.node"),
  };
  if (existsSync(packaged.entryPath) || !options.fallbackRoot) {
    return packaged;
  }
  return {
    entryPath: join(options.fallbackRoot, "packages/server/dist/remote/zcode-server-http.cjs"),
    staticRoot: join(options.fallbackRoot, "packages/web/dist"),
    ptyNodePath: join(options.fallbackRoot, "node_modules/node-pty/build/Release/pty.node"),
  };
}

async function isPortFree(port: number): Promise<boolean> {
  return await new Promise<boolean>((done) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (free: boolean) => {
      socket.destroy();
      done(free);
    };
    socket.once("connect", () => finish(false));
    socket.once("error", () => finish(true));
    socket.setTimeout(500, () => finish(true));
  });
}

async function pickFreePort(preferred: number): Promise<number> {
  if (await isPortFree(preferred)) {
    return preferred;
  }
  return await new Promise<number>((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : WEB_SERVICE_DEFAULT_PORT;
      server.close(() => done(port));
    });
  });
}

export function createWebServiceRuntime(options: WebServiceRuntimeOptions): {
  paths: WebServiceRuntimePaths;
  controller: WebServiceController;
} {
  const paths = resolveWebServiceRuntimePaths(options);
  const statePath = options.statePath ?? resolveWebServiceStatePath();
  const tokenPath = options.tokenPath ?? resolveWebServiceTokenPath();
  const fetchImpl = options.fetchImpl ?? fetch;

  const probeServerInfo = async (input: {
    url: string;
    token: string | undefined;
    timeoutMs: number;
  }) => {
    try {
      const query = input.token ? `?token=${encodeURIComponent(input.token)}` : "";
      const response = await fetchImpl(`${input.url.replace(/\/$/, "")}/api/server-info${query}`, {
        signal: AbortSignal.timeout(input.timeoutMs),
      });
      return response.status;
    } catch (error) {
      return error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network";
    }
  };

  const controller = createWebServiceController({
    statePath,
    tokenPath,
    entryPath: paths.entryPath,
    nodeExecPath: options.nodeExecPath ?? process.execPath,
    staticRoot: paths.staticRoot,
    ...(options.workspacePath ? { workspacePath: options.workspacePath } : {}),
    ...(options.childEnv ? { childEnv: options.childEnv } : {}),
    spawnChild: ({ entryPath, args, env }): WebServiceChildHandle => {
      const child = spawn(options.nodeExecPath ?? process.execPath, [entryPath, ...args], {
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => options.onChildOutput?.(chunk, "stdout"));
      child.stderr?.on("data", (chunk: string) => options.onChildOutput?.(chunk, "stderr"));
      return {
        pid: child.pid,
        kill: (signal) => child.kill(signal),
        onExit: (listener) => child.once("exit", listener),
      };
    },
    probe: () =>
      probeWebService({
        statePath,
        readState: (path) =>
          readWebServiceState(path) as Promise<WebServiceStateRecord | undefined>,
        readToken: (path) => readWebServiceToken(path),
        isPidAlive: isProcessAlive,
        probeServerInfo,
      }),
    pickFreePort,
    waitUntilReady: async ({ url, token, timeoutMs }) => {
      const deadline = (options.now ?? Date.now)() + timeoutMs;
      while ((options.now ?? Date.now)() < deadline) {
        if ((await probeServerInfo({ url, token, timeoutMs: 1500 })) === 200) {
          return true;
        }
        await new Promise((done) => setTimeout(done, 200));
      }
      return false;
    },
    waitForExit: async (child, timeoutMs) =>
      await new Promise<boolean>((done) => {
        const timer = setTimeout(() => done(false), timeoutMs);
        child.onExit(() => {
          clearTimeout(timer);
          done(true);
        });
      }),
    killPid: async ({ pid, port, graceMs }) => {
      if (!isProcessAlive(pid)) {
        return await isPortFree(port);
      }
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        return await isPortFree(port);
      }
      const deadline = Date.now() + graceMs;
      while (Date.now() < deadline) {
        if (!isProcessAlive(pid) && (await isPortFree(port))) {
          return true;
        }
        await new Promise((done) => setTimeout(done, 100));
      }
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // 已经退出：继续确认端口
      }
      const killDeadline = Date.now() + 2_000;
      while (Date.now() < killDeadline) {
        if (await isPortFree(port)) {
          return true;
        }
        await new Promise((done) => setTimeout(done, 100));
      }
      return false;
    },
    readyTimeoutMs: WEB_SERVICE_READY_TIMEOUT_MS,
    stopGraceMs: WEB_SERVICE_STOP_GRACE_MS,
    ...(options.now ? { now: options.now } : {}),
  });

  return { paths, controller };
}
