import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createWebServiceController,
  type WebServiceChildHandle,
  type WebServiceControllerDeps,
} from "../src/main/web-service/service.js";
import type { WebServiceProbeResult } from "../src/main/web-service/probe.js";
import { writeWebServiceState, type WebServiceStateRecord } from "../src/main/web-service/state.js";

/**
 * web-service 的两条「进程归属」约束（审计 S1 / S4）。
 *
 * S1：stop() 曾直接按状态文件里的 pid 杀进程。状态文件在异常退出后会被保留（契约 §3），
 *     其中的 pid 可能已被系统回收给无关进程 ⇒ 误杀。修法：先探活，只有确认这个 pid 仍在
 *     提供我们的服务时才发信号；stale/stopped 只清状态文件。
 * S4：waitUntilReady 曾只按 deadline 轮询，子进程缺文件立即崩溃也要空等满 15s。
 *     修法：把子进程句柄传进去，exit 即失败。
 *
 * 用真实临时目录放状态/令牌文件：controller 直接读写磁盘（不是注入的 port），
 * 假一个不存在的路径会让 stop() 在"读不到记录"处提前返回，测不到归属校验本身。
 */

const RECORD: WebServiceStateRecord = {
  schemaVersion: 1,
  pid: 4242,
  host: "127.0.0.1",
  port: 38490,
  workspacePath: "/abs/ws",
  tokenFile: "/abs/token",
  startedAt: 1760000000000,
  entry: "zcode-server-http.cjs",
};

interface Harness {
  deps: WebServiceControllerDeps;
  killed: number[];
  /** 启动失败时对子进程发的信号（S4 的"别留孤儿"断言）。 */
  childKills: NodeJS.Signals[];
  childExitListeners: ((code: number | null, signal: NodeJS.Signals | null) => void)[];
  cleanup: () => Promise<void>;
}

async function harness(overrides: {
  probe: WebServiceProbeResult;
  writeRecord?: boolean;
  ready?: boolean;
}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-ws-ownership-"));
  const statePath = join(dir, "web-service.json");
  const tokenPath = join(dir, "token");
  if (overrides.writeRecord !== false) {
    await writeWebServiceState(statePath, RECORD);
  }
  const killed: number[] = [];
  const childKills: NodeJS.Signals[] = [];
  const exitListeners: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
  const child: WebServiceChildHandle = {
    pid: 9001,
    kill: (signal) => {
      childKills.push(signal);
    },
    onExit: (listener) => {
      exitListeners.push(listener);
    },
  };
  const deps: WebServiceControllerDeps = {
    statePath,
    tokenPath,
    entryPath: join(dir, "zcode-server-http.cjs"),
    nodeExecPath: process.execPath,
    spawnChild: () => child,
    probe: async () => overrides.probe,
    pickFreePort: async (preferred) => preferred,
    waitUntilReady: async ({ child: passed }) => {
      // S4 的前提：调用方必须把子进程句柄传进来，否则无法感知早退。
      assert.equal(passed, child, "waitUntilReady 必须拿到子进程句柄");
      return overrides.ready ?? true;
    },
    waitForExit: async () => true,
    killPid: async ({ pid }) => {
      killed.push(pid);
      return true;
    },
    now: () => 1_000,
  };
  return {
    deps,
    killed,
    childKills,
    childExitListeners: exitListeners,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test("S1：探活判定 stale ⇒ stop 只清状态文件，不发任何信号", async () => {
  const h = await harness({ probe: { state: "stale", reason: "pid-dead" } });
  try {
    const controller = createWebServiceController(h.deps);
    const status = await controller.stop();
    assert.deepEqual(h.killed, [], "pid 归属未确认时绝不能杀进程");
    assert.equal(status.state, "stopped");
    assert.equal(status.staleReason, "pid-dead", "stale 原因要如实带出");
  } finally {
    await h.cleanup();
  }
});

test("S1：探活判定 running ⇒ 才按 pid 停止", async () => {
  const h = await harness({
    probe: {
      state: "running",
      adopted: false,
      host: "127.0.0.1",
      port: 38490,
      url: "http://127.0.0.1:38490",
      pid: 4242,
      startedAt: 1,
    },
  });
  try {
    const controller = createWebServiceController(h.deps);
    const status = await controller.stop();
    assert.deepEqual(h.killed, [4242], "确认归属后才允许停止它");
    assert.equal(status.state, "stopped");
  } finally {
    await h.cleanup();
  }
});

test("S4：就绪后正常启动（子进程句柄已传入 waitUntilReady）", async () => {
  const h = await harness({ probe: { state: "stopped" }, writeRecord: false, ready: true });
  try {
    const controller = createWebServiceController(h.deps);
    const status = await controller.start();
    assert.equal(status.state, "running");
  } finally {
    await h.cleanup();
  }
});

test("S4：未就绪（子进程崩溃）⇒ 失败并回收子进程，不留孤儿", async () => {
  const h = await harness({ probe: { state: "stopped" }, writeRecord: false, ready: false });
  try {
    const controller = createWebServiceController(h.deps);
    const status = await controller.start();
    assert.equal(status.state, "failed");
    assert.deepEqual(h.childKills, ["SIGTERM"], "起不来必须把子进程收干净，不能留孤儿占端口");
  } finally {
    await h.cleanup();
  }
});
