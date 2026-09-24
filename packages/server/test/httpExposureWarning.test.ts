import assert from "node:assert/strict";
import { networkInterfaces } from "node:os";
import test from "node:test";
import { ServiceCollection } from "@zcode/services";
import {
  buildNonLoopbackListenWarning,
  buildPlainHttpPeerWarning,
  createHttpServer,
  isNonLoopbackAddress,
} from "../src/http.js";
import { parseTrustedProxies } from "../src/authThrottle.js";

/**
 * task-35 起的**口径变化**（本文件里的 XFF 用法随之调整，不是放宽断言）：
 * 服务端不再默认采信 `X-Forwarded-For`（否则按地址限流可被伪造头绕过）。
 * 因此「用 XFF 伪装一个非回环对端」必须**显式把回环声明为可信代理**才成立 ——
 * 那正是真实反代部署的形态（反代在回环上，它给出真实客户端地址）。
 * 另外新增一条断言：**未声明可信代理时，XFF 不能伪造出「非回环对端」告警**。
 */
const LOOPBACK_AS_TRUSTED_PROXY = parseTrustedProxies("127.0.0.1");

/**
 * task-27 暴露检查：非回环绑定与「非回环对端 + 非 TLS」必须醒目告警但不得拒绝。
 *
 * 为什么必须钉住：① 不许静默 —— 非回环绑定下 agent 级服务只剩 token 一道屏障，明文 http 的
 * token cookie 不带 Secure，用户必须被明确告知；② 不许为了告警而拒绝明文 http —— 用户手机验收
 * 走的就是 http://<私网IP>:<port>/?token=... 这条合法用法（拒绝会打断它）。
 * 回环形态的否定式断言必须穷尽（127.x / ::1 / [::1] / localhost / ::ffff:127.x）。
 */

async function resolveListenPort(server: {
  listening: boolean;
  once: (event: "listening", listener: () => void) => unknown;
  address: () => unknown;
}): Promise<number> {
  if (!server.listening) {
    await new Promise<void>((resolve) => {
      server.once("listening", () => resolve());
    });
  }
  const address = server.address();
  return typeof address === "object" && address !== null && "port" in address
    ? Number(address.port)
    : 0;
}

async function closeServer(server: { close: (callback: () => void) => unknown }): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

function captureWarnings(run: () => Promise<void>): Promise<string[]> {
  const original = console.warn;
  const captured: string[] = [];
  console.warn = (...args: unknown[]) => {
    captured.push(args.map((value) => String(value)).join(" "));
  };
  return run()
    .then(() => captured)
    .finally(() => {
      console.warn = original;
    });
}

const LOOPBACK_FORMS = [
  "127.0.0.1",
  "127.1.2.3",
  "::1",
  "[::1]",
  "localhost",
  "LOCALHOST",
  "::ffff:127.0.0.1",
];

test("回环形态穷尽：不得判定为非回环，也不得产生启动期告警", () => {
  for (const host of LOOPBACK_FORMS) {
    assert.equal(isNonLoopbackAddress(host), false, host + " 必须被判定为回环");
    assert.equal(
      buildNonLoopbackListenWarning({ host, port: 38490, tokenAuth: true }),
      null,
      host + " 不得产生暴露面告警",
    );
  }
  assert.equal(isNonLoopbackAddress(undefined), false);
  assert.equal(isNonLoopbackAddress(""), false);
});

test("非回环启动告警必须含可操作指引，而不是只报一句绑定了", () => {
  for (const host of ["0.0.0.0", "10.122.18.101", "::"]) {
    const warning = buildNonLoopbackListenWarning({ host, port: 38490, tokenAuth: true });
    assert.ok(warning, host + " 必须产生告警");
    const fragments = [
      "agent 级服务",
      "token 是唯一屏障",
      "不带 Secure",
      "反向代理",
      "X-Forwarded-Proto: https",
      "可信局域网",
      "别绑 0.0.0.0",
    ];
    for (const fragment of fragments) {
      assert.ok(warning.includes(fragment), "告警缺少关键指引：" + fragment);
    }
    assert.ok(warning.includes("bind=" + host + ":38490"), "告警必须写明真实 bind");
  }
});

test("运行期告警只在非回环对端且非 TLS 时出现", () => {
  for (const remoteAddress of [...LOOPBACK_FORMS, undefined, ""]) {
    assert.equal(
      buildPlainHttpPeerWarning({ remoteAddress, secure: false }),
      null,
      String(remoteAddress) + " 是回环/未知对端，不得告警",
    );
  }
  assert.equal(
    buildPlainHttpPeerWarning({ remoteAddress: "10.122.18.101", secure: true }),
    null,
    "TLS（含反代 X-Forwarded-Proto: https）下不得告警",
  );
  const warning = buildPlainHttpPeerWarning({ remoteAddress: "10.122.18.101", secure: false });
  assert.ok(warning);
  assert.ok(warning.includes("10.122.18.101"), "必须写明对端地址");
  assert.ok(warning.includes("将不带 Secure"), "必须写明本次会话 cookie 不带 Secure");
  assert.ok(warning.includes("可信局域网"), "必须给出可信局域网口径");
});

test("非回环 + token 能启动，且启动期出现告警（真绑定；无本地非回环地址时跳过）", async (t) => {
  const lan = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry && !entry.internal && entry.family === "IPv4");
  if (!lan) {
    t.skip("本机没有非回环 IPv4 地址，无法真实绑定");
    return;
  }
  const server = createHttpServer(new ServiceCollection(), 0, {
    host: lan.address,
    authToken: "task27",
  });
  const warnings = await captureWarnings(async () => {
    await resolveListenPort(server);
  });
  try {
    assert.ok(
      warnings.some(
        (entry) =>
          entry.includes("agent 级服务") &&
          entry.includes("不带 Secure") &&
          entry.includes("可信局域网"),
      ),
      "非回环绑定必须打印含关键指引的告警，实际：" + JSON.stringify(warnings),
    );
    assert.ok(
      warnings.some((entry) => entry.includes("bind=" + lan.address)),
      "告警必须写明真实 bind 地址",
    );
  } finally {
    await closeServer(server);
  }
});

test("回环启动不得出现暴露面告警（127.0.0.1 真绑定）", async () => {
  const server = createHttpServer(new ServiceCollection(), 0, {
    host: "127.0.0.1",
    authToken: "task27",
  });
  const warnings = await captureWarnings(async () => {
    await resolveListenPort(server);
  });
  try {
    assert.deepEqual(
      warnings.filter((entry) => entry.includes("暴露面提醒")),
      [],
      "回环绑定不得出现暴露面告警",
    );
  } finally {
    await closeServer(server);
  }
});

test("运行期告警只出现一次，且明文 http 请求照常成功（不拒绝）", async () => {
  const server = createHttpServer(new ServiceCollection(), 0, {
    host: "127.0.0.1",
    authToken: "task27",
    // 模拟「反代在回环上」：只有声明可信后才采信 XFF（task-35 的口径，见文件头注释）。
    trustedProxies: LOOPBACK_AS_TRUSTED_PROXY,
  });
  const port = await resolveListenPort(server);
  try {
    const warnings = await captureWarnings(async () => {
      for (let index = 0; index < 2; index += 1) {
        const response = await fetch("http://127.0.0.1:" + port + "/api/server-info?token=task27", {
          headers: { "x-forwarded-for": "10.122.18.101" },
        });
        assert.equal(response.status, 200, "明文 http 请求必须照常成功");
      }
      const loopbackPeer = await fetch(
        "http://127.0.0.1:" + port + "/api/server-info?token=task27",
        {
          headers: { "x-forwarded-for": "127.0.0.1" },
        },
      );
      assert.equal(loopbackPeer.status, 200);
    });
    const exposure = warnings.filter((entry) => entry.includes("非回环对端"));
    assert.equal(exposure.length, 1, "运行期告警必须只出现一次，实际：" + JSON.stringify(exposure));
    assert.ok(exposure[0].includes("将不带 Secure"), "运行期告警必须写明 cookie 不带 Secure");
  } finally {
    await closeServer(server);
  }
});

test("未声明可信代理时，XFF 不得伪造出「非回环对端」告警（task-35 新口径）", async () => {
  const server = createHttpServer(new ServiceCollection(), 0, {
    host: "127.0.0.1",
    authToken: "task27",
  });
  const port = await resolveListenPort(server);
  try {
    const warnings = await captureWarnings(async () => {
      const response = await fetch("http://127.0.0.1:" + port + "/api/server-info?token=task27", {
        headers: { "x-forwarded-for": "10.122.18.101" },
      });
      assert.equal(response.status, 200);
    });
    assert.deepEqual(
      warnings.filter((entry) => entry.includes("非回环对端")),
      [],
      "未声明可信代理时对端一律取 socket（回环）⇒ 不得告警，伪造头不能制造告警噪音",
    );
  } finally {
    await closeServer(server);
  }
});

test("反代已声明 https 时运行期不得告警（X-Forwarded-Proto）", async () => {
  const server = createHttpServer(new ServiceCollection(), 0, {
    host: "127.0.0.1",
    authToken: "task27",
    // 同上：不声明可信代理时 XFF 根本不被采信，这条断言会退化成空断言。
    trustedProxies: LOOPBACK_AS_TRUSTED_PROXY,
  });
  const port = await resolveListenPort(server);
  try {
    const warnings = await captureWarnings(async () => {
      const response = await fetch("http://127.0.0.1:" + port + "/api/server-info?token=task27", {
        headers: { "x-forwarded-for": "10.122.18.101", "x-forwarded-proto": "https" },
      });
      assert.equal(response.status, 200);
    });
    assert.deepEqual(
      warnings.filter((entry) => entry.includes("暴露面提醒")),
      [],
      "已声明 https 时不得告警",
    );
  } finally {
    await closeServer(server);
  }
});
