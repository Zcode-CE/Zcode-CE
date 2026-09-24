import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWebServiceController } from "../src/main/web-service/service.js";
import { readWebServiceState, writeWebServiceState } from "../src/main/web-service/state.js";
import {
  createRealDeps,
  isPortOpen,
  pickFreePort,
  readTokenForTest,
  STUB_SERVER_PATH,
  type RealDepsHarness,
} from "./support/webServiceRealDeps.js";

/**
 * 编排层端到端（**真实子进程**，不依赖 Electron）。
 *
 * 本文件钉的是契约里最硬的三条：
 * 1. **接管幂等**（§4 末段）：`running` 时连续 start 两次 ⇒ **子进程计数仍为 1**。
 *    这条只能用真实子进程证明 —— 用 fake 计数器时，"第二个进程"根本不存在的失败是看不见的。
 *    实现上的依据是"先探活，探活说在跑就直接返回、绝不 spawn"，所以这里同时断言
 *    spawn 次数与**活着的子进程数**两者都不变。
 * 2. **stale 判定**（§4）：`kill -9`（异常退出）⇒ pid-dead ⇒ 可被重新开启；状态文件不被误删。
 * 3. **stop 语义**（§6.4）：SIGTERM → 确认退出与端口释放 → **之后才**删状态文件。
 *
 * 运行：cd packages/desktop && node --import tsx --test test/webServiceAdoption.test.ts
 */

interface Harness extends RealDepsHarness {
  dir: string;
  statePath: string;
  tokenPath: string;
}

async function withHarness(body: (harness: Harness) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-webservice-"));
  const statePath = join(dir, "web-service.json");
  const tokenPath = join(dir, "token");
  const real = createRealDeps({ statePath, tokenPath, readyTimeoutMs: 10_000, stopGraceMs: 3_000 });
  try {
    await body({ ...real, dir, statePath, tokenPath });
  } finally {
    real.killAll();
    await rm(dir, { recursive: true, force: true });
  }
}

test("★接管幂等：running 时连续 start 两次，子进程计数仍为 1", async () => {
  await withHarness(async (harness) => {
    const port = await pickFreePort();
    const controller = createWebServiceController(harness.deps);

    const first = await controller.start({ scope: "loopback", port });
    assert.equal(first.state, "running");
    assert.equal(first.adopted, false);
    assert.equal(harness.spawnCount(), 1, "第一次 start 应当只起一个子进程");

    const second = await controller.start({ scope: "loopback", port });
    assert.equal(second.state, "running");
    assert.equal(second.adopted, true, "第二次 start 必须走接管");
    assert.equal(harness.spawnCount(), 1, "第二次 start 不得起第二个子进程");
    assert.equal(harness.liveChildren().length, 1, "活着的子进程数也必须仍为 1");
    assert.equal(second.pid === first.pid || second.port === first.port, true);
  });
});

test("start 写入状态文件（0600）与令牌文件（0600），且状态里不含令牌明文", async () => {
  await withHarness(async (harness) => {
    const port = await pickFreePort();
    const controller = createWebServiceController(harness.deps);
    assert.equal((await controller.start({ scope: "loopback", port })).state, "running");

    const record = await readWebServiceState(harness.statePath);
    assert.ok(record, "启动成功后必须写状态文件");
    assert.equal(record.port, port);
    assert.equal(record.entry, "web-service-stub-server.mjs");
    if (process.platform !== "win32") {
      assert.equal((await stat(harness.statePath)).mode & 0o777, 0o600);
      assert.equal((await stat(harness.tokenPath)).mode & 0o777, 0o600);
    }

    const token = await readTokenForTest(harness.tokenPath);
    assert.ok(token && token.length >= 32, "令牌文件必须含一个足够长的令牌");
    const status = await controller.status();
    assert.equal(
      JSON.stringify(status).includes(token),
      false,
      "status 绝不能携带令牌（契约 §5：令牌只经 connectionInfo.linkWithToken）",
    );
  });
});

test("connectionInfo 返回带令牌的链接；status 不带", async () => {
  await withHarness(async (harness) => {
    const port = await pickFreePort();
    const controller = createWebServiceController(harness.deps);
    await controller.start({ scope: "loopback", port });

    const info = await controller.connectionInfo();
    assert.ok(info);
    assert.equal(info.url, `http://127.0.0.1:${port}`);
    assert.match(info.linkWithToken, /\?token=/, "链接必须带 ?token= 供读码端换 cookie");

    // 令牌只在这条通道出现；同一时刻的 status 里不得有它。
    const token = await readTokenForTest(harness.tokenPath);
    assert.equal(
      (await controller.status()) &&
        JSON.stringify(await controller.status()).includes(token ?? "\u0000"),
      false,
    );
  });
});

test("★stale 判定：kill -9（异常退出）后判 stale/pid-dead，状态文件保留，可被重新开启", async () => {
  await withHarness(async (harness) => {
    const port = await pickFreePort();
    const controller = createWebServiceController(harness.deps);
    await controller.start({ scope: "loopback", port });
    const record = await readWebServiceState(harness.statePath);
    assert.ok(record);

    process.kill(record.pid, "SIGKILL");
    for (let i = 0; i < 60 && (await isPortOpen("127.0.0.1", port)); i += 1) {
      await new Promise((r) => setTimeout(r, 50));
    }

    const staleStatus = await controller.status();
    assert.equal(staleStatus.state, "stopped", "pid 已死时对外表现为可重新开启");
    // task-83：探活已经算出 reason，对外必须**如实带出**（否则面板的 stale 文案不可达，
    // 用户看到的是"未开启"，与"上次异常退出、记录还在"无法区分）。
    assert.equal(
      staleStatus.staleReason,
      "pid-dead",
      "kill -9 后对外状态必须带 staleReason=pid-dead（契约 §3 的 stale 一行才可达）",
    );
    assert.ok(
      await readWebServiceState(harness.statePath),
      "异常退出必须**保留**状态文件（契约 §3 规则 2：留着让探活判 stale）",
    );

    const restarted = await controller.start({ scope: "loopback", port });
    assert.equal(restarted.state, "running");
    assert.equal(harness.spawnCount(), 2, "stale 之后重新开启应当真的起一个新进程");
  });
});

test("★stop：SIGTERM 收干净 → 端口释放 → 之后才删状态文件", async () => {
  await withHarness(async (harness) => {
    const port = await pickFreePort();
    const controller = createWebServiceController(harness.deps);
    await controller.start({ scope: "loopback", port });

    const stopped = await controller.stop();
    assert.equal(stopped.state, "stopped");
    assert.equal(harness.liveChildren().length, 0, "stop 之后不得留下活着的子进程");
    assert.equal(await isPortOpen("127.0.0.1", port), false, "stop 必须确认端口已释放");
    assert.equal(
      await readWebServiceState(harness.statePath),
      undefined,
      "主动停止且已退出之后才删状态文件",
    );
    assert.equal(harness.spawnCount(), 1, "stop 不得顺手再起一个进程");
  });
});

test("stop 在没有状态文件时是幂等的（返回当前探活结果，不抛错）", async () => {
  await withHarness(async (harness) => {
    const controller = createWebServiceController(harness.deps);
    const stopped = await controller.stop();
    assert.equal(stopped.state, "stopped");
    assert.equal(harness.spawnCount(), 0);
    // 从来没有状态文件 ⇒ 是"从未开启"，**不是**陈旧条目：不得带 staleReason。
    // 这条与上面 kill -9 那条合起来才证明 staleReason 真的在区分两种 stopped。
    assert.equal(stopped.staleReason, undefined, "无状态文件时必须不带 staleReason");
  });
});

test("★stale 的区分度：'从未开启' 与 '陈旧条目' 对外可区分（task-83 的核心判据）", async () => {
  await withHarness(async (harness) => {
    const port = await pickFreePort();
    const controller = createWebServiceController(harness.deps);

    // ① 从未开启：stopped 且无 staleReason。
    const neverStarted = await controller.status();
    assert.equal(neverStarted.state, "stopped");
    assert.equal(neverStarted.staleReason, undefined, "从未开启不得被说成陈旧条目");

    // ② 起来 → 主动 stop：正常收尾 ⇒ 状态文件被删 ⇒ 回到"从未开启"的形态。
    await controller.start({ scope: "loopback", port });
    await controller.stop();
    const afterCleanStop = await controller.status();
    assert.equal(afterCleanStop.state, "stopped");
    assert.equal(
      afterCleanStop.staleReason,
      undefined,
      "正常停止后状态文件已删 ⇒ 不得残留 staleReason",
    );

    // ③ 再起来 → kill -9：异常退出 ⇒ 状态文件保留 ⇒ 必须报 stale/pid-dead。
    await controller.start({ scope: "loopback", port });
    const record = await readWebServiceState(harness.statePath);
    assert.ok(record);
    process.kill(record.pid, "SIGKILL");
    for (let i = 0; i < 60 && (await isPortOpen("127.0.0.1", port)); i += 1) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const afterCrash = await controller.status();
    assert.equal(afterCrash.state, "stopped");
    assert.equal(afterCrash.staleReason, "pid-dead", "异常退出必须被标成陈旧条目");
    // 两种 stopped 的 state 相同、staleReason 不同 ⇒ 面板才可能给出不同文案。
    assert.notEqual(
      afterCrash.staleReason,
      neverStarted.staleReason,
      "陈旧条目与从未开启必须可区分（否则面板那条文案是死分支）",
    );
  });
});

test("running-untrusted：端口上是个不认我们令牌的服务 ⇒ 不接管、也不重复启动", async () => {
  await withHarness(async (harness) => {
    const port = await pickFreePort();
    // 起一个**别人的**服务：它认自己的令牌文件，不认我们的。
    // （注意不能靠"改我们的令牌文件"来模拟 —— 替身服务每次请求都重读令牌文件，
    //   那正是 SIGHUP 热重载的语义，改了它反而会认新的那个。）
    const foreignTokenPath = join(harness.dir, "foreign-token");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(foreignTokenPath, `${"f".repeat(43)}\n`, { mode: 0o600 });
    const { spawn } = await import("node:child_process");
    const foreign = spawn(process.execPath, [STUB_SERVER_PATH], {
      env: {
        ...process.env,
        PORT: String(port),
        ZCODE_SERVER_HOST: "127.0.0.1",
        ZCODE_SERVER_AUTH_TOKENS_FILE: foreignTokenPath,
      },
      stdio: "ignore",
    });
    try {
      for (let i = 0; i < 80 && !(await isPortOpen("127.0.0.1", port)); i += 1) {
        await new Promise((r) => setTimeout(r, 25));
      }
      // 状态文件指向它，但 tokenFile 是我们的 ⇒ 探活必然 401。
      await writeWebServiceState(harness.statePath, {
        pid: foreign.pid ?? 0,
        host: "127.0.0.1",
        port,
        tokenFile: harness.tokenPath,
        startedAt: Date.now(),
        entry: "web-service-stub-server.mjs",
      });

      const controller = createWebServiceController(harness.deps);
      const status = await controller.status();
      assert.equal(status.state, "running-untrusted");
      assert.equal(status.adopted, false);

      const after = await controller.start({ scope: "loopback", port });
      assert.equal(after.state, "running-untrusted");
      assert.equal(harness.spawnCount(), 0, "untrusted 时不得（换端口或原地）起第二个进程");
    } finally {
      foreign.kill("SIGKILL");
    }
  });
});
