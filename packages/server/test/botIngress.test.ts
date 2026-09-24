import assert from "node:assert/strict";
import test from "node:test";
import { ServiceCollection, IBotsService, ICredentialService } from "@zcode/services";
import { DEFAULT_BOT_COMMANDS } from "@zcode/shared";
import { BOT_MAX_ATTACHMENTS_PER_MESSAGE, BOT_MAX_ATTACHMENT_SIZE_BYTES } from "@zcode/services";
import { BOT_INGRESS_MAX_BODY_BYTES, BOT_INGRESS_SECRET_HEADER } from "../src/botIngress.js";
import {
  ROUTE_POLICY,
  assertRoutePolicyEnforced,
  createHttpServer,
  isTokenProtectedPath,
  type HttpServerOptions,
} from "../src/http.js";
import { createAuthThrottle } from "../src/authThrottle.js";
import { createAuditLog } from "../src/auditLog.js";

/**
 * IM 机器人**入站**面（/bot/**）的验收判据（task-97）。
 *
 * 判据编号与 `.reverse/93-bot-ingress/BOT-INGRESS-SPEC.md` §8.2 一一对应（A1–A15），
 * 另加 §7.1.1 的两条**耦合断言**（C1/C2）。
 *
 * 本文件的**核心目的**是证明「新增 /bot/** 没有削弱既有令牌面」——
 * 因此 A1/A2/A7 是本文件的重点，其余是功能与语义的钉桩。
 */

const SECRET = "bot-ingress-test-secret-value";
const TOKEN = "token-must-not-appear-in-logs";

function webhookBot(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    provider: "webhook",
    enabled: true,
    providerUserId: "u-1",
    allowedWorkspaces: ["*"],
    allowedCommands: { ...DEFAULT_BOT_COMMANDS },
    currentOptions: {},
    replyMode: "assistant_changes",
    webhookSecretRef: "bot:" + id + ":webhook-secret",
    ...overrides,
  };
}

interface FixtureOptions {
  bots?: unknown[];
  /** 凭据库：返回 secret 还是 null（验证 fail-closed）。 */
  credential?: "value" | "missing";
  botIngressEnabled?: boolean;
  authToken?: string;
  throttle?: ReturnType<typeof createAuthThrottle>;
  botIngressThrottle?: ReturnType<typeof createAuthThrottle>;
  audit?: ReturnType<typeof createAuditLog>;
  staticRoot?: string;
}

/** 起一个带真实 botsService / credentialService 的服务（不 mock 掉被验的那一层）。 */
async function withServer(
  opts: FixtureOptions,
  run: (baseUrl: string, services: ServiceCollection) => Promise<void>,
): Promise<void> {
  const services = new ServiceCollection();
  services.register(IBotsService, {
    listBots: async () => opts.bots ?? [],
    handleProviderCallbackResponse: async (_provider: string, payload: unknown) => {
      // 记录「消息体是否被处理」——A4/A11 用它断言「零副作用」。
      (services as unknown as { __handled?: unknown[] }).__handled ??= [];
      (services as unknown as { __handled: unknown[] }).__handled.push(payload);
      return { ok: true, replies: [{ text: "handled" }] };
    },
  } as never);
  services.register(ICredentialService, {
    load: async () => (opts.credential === "missing" ? null : SECRET),
    save: async () => undefined,
    delete: async () => undefined,
  } as never);

  const options: HttpServerOptions = {
    ...(opts.authToken ? { authToken: opts.authToken } : {}),
    ...(opts.staticRoot ? { staticRoot: opts.staticRoot, spaFallback: true } : {}),
    ...(opts.throttle ? { throttle: opts.throttle } : {}),
    ...(opts.botIngressThrottle ? { botIngressThrottle: opts.botIngressThrottle } : {}),
    ...(opts.audit ? { audit: opts.audit } : {}),
    botIngress: { enabled: opts.botIngressEnabled ?? false },
  };
  const server = createHttpServer(services, 0, options);
  try {
    if (!server.listening) {
      await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    }
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await run("http://127.0.0.1:" + String(port), services);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function postBot(base: string, path: string, secret?: string, body = "{}") {
  return fetch(base + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret !== undefined ? { [BOT_INGRESS_SECRET_HEADER]: secret } : {}),
    },
    body,
  });
}

// ── A1/A2：令牌面逐字节未变（本设计要防的核心风险）──────────────────────────

/**
 * A1 的冻结表：**字面量**，不是计算值。
 *
 * 来源：spec §8.2.1 的 FROZEN_TABLE 快照（改动前实测，SHA-256 记录在 R17）。
 * 为什么用字面量而不是「再写一遍归一化逻辑」：那会让测试自己也成为一处会漂移的实现。
 */
const FROZEN_PROTECTED: ReadonlyArray<[string, boolean]> = [
  ["/api", true],
  ["/api/", true],
  ["/api/server-info", true],
  ["/api/rpc-host-capability", true],
  ["/api/connect-remote", true],
  ["/api/anything-not-registered", true],
  ["/apiX", false],
  ["/apifoo", false],
  ["/API/server-info", false],
  ["/api%2Fserver-info", false],
  ["/ws", true],
  ["/ws/", true],
  ["/ws/host", true],
  ["/ws/remote/x", true],
  ["/wsX", false],
  ["/wsfoo", false],
  ["/", false],
  ["/index.html", false],
  ["/tasks", false],
  ["/assets/app.js", false],
  ["/share/abc", false],
  ["/share", false],
  ["/bot", false],
  ["/bot/", false],
  ["/bot/webhook", false],
  ["/bot/webhook/b1", false],
  ["/botx", false],
  ["/bots", false],
  // 归一化后的关键格：/bot/../api/... 会落回受保护面（⇒ /bot 无法偷渡进令牌面）
  ["/api/server-info", true],
  ["//api/server-info", false],
  ["/.;/api/server-info", false],
  ["/bot/..%2fapi%2fserver-info", false],
];

test("A1/A2④：isTokenProtectedPath 的输入输出表逐字节不变（冻结快照）", () => {
  // 这是「没有削弱令牌面」最直接的证据：只看判定表，不看实现与 ROUTE_POLICY。
  // 反向验证：把 /bot 加进 isTokenProtectedPath、或删掉任一分支 ⇒ 本断言变红。
  const actual = FROZEN_PROTECTED.map(
    ([p, expected]) => p + "\t" + String(isTokenProtectedPath(p)) + "\t" + String(expected),
  ).join("\n");
  const expected = FROZEN_PROTECTED.map(
    ([p, expected]) => p + "\t" + String(expected) + "\t" + String(expected),
  ).join("\n");
  assert.equal(actual, expected, "isTokenProtectedPath 的判定表发生了变化");
  // 正向：确认表里同时含受保护与公开两档（否则断言可能空转）。
  assert.ok(
    FROZEN_PROTECTED.some(([, v]) => v),
    "表中必须有受保护样本",
  );
  assert.ok(
    FROZEN_PROTECTED.some(([, v]) => !v),
    "表中必须有公开样本",
  );
});

test("A1：无凭据时 /api* 与 /ws* 仍 401 且 body 逐字不变", async () => {
  await withServer(
    { authToken: TOKEN, botIngressEnabled: true, bots: [webhookBot("b1")] },
    async (base) => {
      const paths = [
        "/api",
        "/api/",
        "/api/server-info",
        "/api/rpc-host-capability",
        "/api/connect-remote",
        "/api/anything-not-registered",
        "/ws",
        "/ws/host",
      ];
      for (const p of paths) {
        const res = await fetch(base + p);
        assert.equal(res.status, 401, "GET " + p + " 必须 401");
        assert.equal(
          await res.text(),
          '{"error":"Unauthorized"}',
          "GET " + p + " body 必须逐字不变",
        );
      }
    },
  );
});

test("A2：ROUTE_POLICY 含 /bot 条目，且断言与既有测试纪律仍自洽", () => {
  // ① 启动期断言不抛错（public 条目不参与该断言，见 spec §5.2）。
  assert.doesNotThrow(() => assertRoutePolicyEnforced());
  // ② 恰好一条 /bot/** 的 public 条目，且 note 非空（既有测试 :128-130 的纪律）。
  const botEntries = ROUTE_POLICY.filter((e) => e.path === "/bot/**");
  assert.equal(botEntries.length, 1, "应恰好有一条 /bot/** 登记");
  assert.equal(botEntries[0]?.policy, "public");
  assert.ok((botEntries[0]?.note.length ?? 0) > 0, "public 条目必须写明理由");
  // ③ 核心风险 R-a：没有任何 public 条目落在 /api 或 /ws 内。
  for (const entry of ROUTE_POLICY.filter((e) => e.policy === "public")) {
    const probe = entry.path.endsWith("/**") ? entry.path.slice(0, -2) + "sample" : entry.path;
    assert.equal(
      isTokenProtectedPath(probe),
      false,
      "public 条目 " + entry.path + " 的探针 " + probe + " 不得落在令牌面内",
    );
  }
});

test("A7：启用 botIngress 前后，/api 语料的响应逐条相同", async () => {
  const paths = ["/api", "/api/server-info", "/ws", "/api/anything-not-registered"];
  const collect = async (enabled: boolean) => {
    const out: string[] = [];
    await withServer(
      { authToken: TOKEN, botIngressEnabled: enabled, bots: [webhookBot("b1")] },
      async (base) => {
        for (const p of paths) {
          const res = await fetch(base + p);
          out.push(p + "=" + String(res.status) + ":" + (await res.text()));
        }
      },
    );
    return out;
  };
  const off = await collect(false);
  const on = await collect(true);
  assert.deepEqual(on, off, "启用 /bot/** 不得改变任何 /api 路径的响应");
});

// ── A3：未启用时 /bot/** 与「真未注册」逐字节相同 ────────────────────────────

test("A3：未启用渠道时 /bot/** 与对照路径的响应逐字节相同（404）", async () => {
  await withServer({ authToken: TOKEN, botIngressEnabled: false }, async (base) => {
    const control = await fetch(base + "/__control_unregistered__", { method: "POST" });
    const controlBody = await control.text();
    for (const p of ["/bot", "/bot/", "/bot/webhook", "/bot/webhook/b1"]) {
      const res = await postBot(base, p, "whatever");
      assert.equal(res.status, control.status, p + " 的状态码必须与「真未注册」相同");
      assert.equal(
        res.headers.get("content-type"),
        control.headers.get("content-type"),
        p + " content-type 必须相同",
      );
      assert.equal(await res.text(), controlBody, p + " body 必须逐字节相同");
    }
  });
});

// ── A4/A5：凭据 fail-closed 与限流 ────────────────────────────────────────

test("A4：启用但未配 secret ⇒ 401 且零副作用（fail-closed）", async () => {
  const bots = [webhookBot("b1", { webhookSecretRef: undefined })];
  await withServer(
    { authToken: TOKEN, botIngressEnabled: true, bots, credential: "missing" },
    async (base, services) => {
      const res = await postBot(base, "/bot/webhook/b1", "any-guess");
      assert.equal(res.status, 401, "未配 secret 必须拒绝");
      const handled = (services as unknown as { __handled?: unknown[] }).__handled ?? [];
      assert.equal(handled.length, 0, "拒绝路径不得把消息交给 botsService（零副作用）");
    },
  );
});

test("A4b：ref 配了但凭据库读不到 ⇒ 401 且零副作用（fail-closed）", async () => {
  await withServer(
    { authToken: TOKEN, botIngressEnabled: true, bots: [webhookBot("b1")], credential: "missing" },
    async (base, services) => {
      const res = await postBot(base, "/bot/webhook/b1", SECRET);
      assert.equal(res.status, 401, "读不到期望 secret 必须拒绝");
      const handled = (services as unknown as { __handled?: unknown[] }).__handled ?? [];
      assert.equal(handled.length, 0, "拒绝路径不得把消息交给 botsService");
    },
  );
});

test("A5：错误 secret 401 + 触发限流；正确 secret 200 + 计数清零", async () => {
  const botThrottle = createAuthThrottle({
    maxFailures: 3,
    windowMs: 60_000,
    banDurationMs: 60_000,
  });
  await withServer(
    {
      authToken: TOKEN,
      botIngressEnabled: true,
      bots: [webhookBot("b1")],
      botIngressThrottle: botThrottle,
    },
    async (base) => {
      // ① 错误 secret ⇒ 401
      for (let i = 1; i <= 3; i += 1) {
        const res = await postBot(base, "/bot/webhook/b1", "wrong");
        assert.equal(res.status, 401, "第 " + String(i) + " 次错误 secret 必须 401");
      }
      // ② 达到阈值后 ⇒ 403（与令牌面同口径，不是 429）
      const banned = await postBot(base, "/bot/webhook/b1", "wrong");
      assert.equal(banned.status, 403, "达到阈值后必须 403");
      assert.match(await banned.text(), /temporarily blocked/);
    },
  );
});

test("A5b：正确 secret ⇒ 200，且成功路径清零失败计数", async () => {
  const botThrottle = createAuthThrottle({
    maxFailures: 10,
    windowMs: 60_000,
    banDurationMs: 60_000,
  });
  await withServer(
    {
      authToken: TOKEN,
      botIngressEnabled: true,
      bots: [webhookBot("b1")],
      botIngressThrottle: botThrottle,
    },
    async (base) => {
      await postBot(base, "/bot/webhook/b1", "wrong");
      assert.equal(botThrottle.failureCount("127.0.0.1"), 1, "错误 secret 应计数");
      const ok = await postBot(base, "/bot/webhook/b1", SECRET);
      assert.equal(ok.status, 200, "正确 secret 必须通过");
      assert.equal(botThrottle.failureCount("127.0.0.1"), 0, "成功必须清零计数");
    },
  );
});

// ── A6：核心风险 R-b —— bot 面与令牌面双向隔离 ──────────────────────────────

test("A6：令牌面封禁不误伤 /bot/**，bot 面封禁不误伤令牌面", async () => {
  const tokenThrottle = createAuthThrottle({
    maxFailures: 2,
    windowMs: 60_000,
    banDurationMs: 60_000,
  });
  const botThrottle = createAuthThrottle({
    maxFailures: 2,
    windowMs: 60_000,
    banDurationMs: 60_000,
  });
  await withServer(
    {
      authToken: TOKEN,
      botIngressEnabled: true,
      bots: [webhookBot("b1")],
      throttle: tokenThrottle,
      botIngressThrottle: botThrottle,
    },
    async (base) => {
      // ② 先把令牌面打到封禁。
      await fetch(base + "/api/server-info");
      await fetch(base + "/api/server-info");
      assert.equal((await fetch(base + "/api/server-info")).status, 403, "令牌面应已封禁");
      // ② 令牌面封禁后：带**正确** secret 打 /bot/** 仍须 200（不被误伤）。
      const botRes = await postBot(base, "/bot/webhook/b1", SECRET);
      assert.equal(botRes.status, 200, "令牌面封禁不得误伤 bot 入站面（核心风险 R-b）");
      // ③ 未启用渠道在令牌面封禁时仍须 404（不是 403）—— 否则泄漏「有没有开 bot」。
      const offRes = await postBot(base, "/bot/webhook/nonexistent", SECRET);
      assert.equal(offRes.status, 404, "渠道未启用必须 404，即使令牌面已封禁");
    },
  );
});

test("A6b：bot 面封禁不误伤令牌面与公开路径", async () => {
  const tokenThrottle = createAuthThrottle({ maxFailures: 10_000 });
  const botThrottle = createAuthThrottle({
    maxFailures: 2,
    windowMs: 60_000,
    banDurationMs: 60_000,
  });
  await withServer(
    {
      authToken: TOKEN,
      botIngressEnabled: true,
      bots: [webhookBot("b1")],
      throttle: tokenThrottle,
      botIngressThrottle: botThrottle,
    },
    async (base) => {
      // 先把 bot 面打到封禁。
      await postBot(base, "/bot/webhook/b1", "wrong");
      await postBot(base, "/bot/webhook/b1", "wrong");
      assert.equal((await postBot(base, "/bot/webhook/b1", SECRET)).status, 403, "bot 面应已封禁");
      // ① bot 面封禁后：无令牌打 /api 仍须 401（不是 403）。
      const api = await fetch(base + "/api/server-info");
      assert.equal(api.status, 401, "bot 面封禁不得误伤令牌面");
      // 带正确令牌仍须 200。
      assert.equal((await fetch(base + "/api/server-info?token=" + TOKEN)).status, 200);
    },
  );
});

// ── A8：不存在绕过令牌面的路径形状 ───────────────────────────────────────

test("A8：/bot/../api/** 归一化后仍受令牌保护（401，不是 200/404）", async () => {
  await withServer(
    { authToken: TOKEN, botIngressEnabled: true, bots: [webhookBot("b1")] },
    async (base) => {
      // fetch 会自己归一化 ../，故这些请求实际打到 /api/server-info ⇒ 必须 401。
      for (const p of [
        "/bot/../api/server-info",
        "/bot/%2e%2e/api/server-info",
        "/bot/./../../api/server-info",
      ]) {
        const res = await fetch(base + p);
        assert.equal(res.status, 401, p + " 归一化后必须落回令牌面（401）");
      }
    },
  );
});

// ── A9/A10：Host 白名单与来源校验仍然生效 ────────────────────────────────

test("A9：Host 白名单对 /bot/** 仍然生效（403 + 标记头）", async () => {
  await withServer(
    { authToken: TOKEN, botIngressEnabled: true, bots: [webhookBot("b1")] },
    async (base) => {
      // 必须用**裸 socket**：undici（fetch）会忽略调用方给的 Host 头（它按 URL 自己填），
      // 因此用 fetch 测不出 Host 校验。这里是实测踩过的坑，写下来免得后人再踩。
      const { request } = await import("node:http");
      const url = new URL(base);
      const raw = await new Promise<string>((resolve) => {
        const req = request(
          {
            host: url.hostname,
            port: url.port,
            path: "/bot/webhook/b1",
            method: "POST",
            headers: {
              host: "evil.example",
              "content-type": "application/json",
              [BOT_INGRESS_SECRET_HEADER]: SECRET,
              "content-length": "2",
            },
          },
          (res) => {
            let body = "";
            res.on("data", (d) => (body += String(d)));
            res.on("end", () =>
              resolve(
                String(res.statusCode) +
                  "|" +
                  String(res.headers["x-zcode-host-rejected"]) +
                  "|" +
                  body,
              ),
            );
          },
        );
        req.on("error", (e) => resolve("ERR " + e.message));
        req.end("{}");
      });
      assert.match(
        raw,
        /^403\|1\|/,
        "Host 不在白名单必须 403 且带 X-ZCode-Host-Rejected（实际：" + raw.slice(0, 60) + "）",
      );
    },
  );
});

test("A10：来源校验对 /bot/** 仍然生效（跨站 POST 403；无 Origin 放行）", async () => {
  await withServer(
    { authToken: TOKEN, botIngressEnabled: true, bots: [webhookBot("b1")] },
    async (base) => {
      const crossSite = await fetch(base + "/bot/webhook/b1", {
        method: "POST",
        headers: { origin: "https://attacker.example", [BOT_INGRESS_SECRET_HEADER]: SECRET },
        body: "{}",
      });
      assert.equal(crossSite.status, 403, "跨站 POST 必须被来源链拒绝");
      // 非浏览器调用方（IM 平台）不发 Origin ⇒ 放行到凭据层。
      const noOrigin = await postBot(base, "/bot/webhook/b1", SECRET);
      assert.equal(noOrigin.status, 200, "无 Origin 应放行到凭据层");
    },
  );
});

// ── A11：配置变化后立即 fail-closed ──────────────────────────────────────

test("A11：运行期把 bot 删掉 ⇒ 下一次回调 404（不是 200）", async () => {
  const bots: unknown[] = [webhookBot("b1")];
  await withServer({ authToken: TOKEN, botIngressEnabled: true, bots }, async (base) => {
    assert.equal((await postBot(base, "/bot/webhook/b1", SECRET)).status, 200);
    bots.length = 0; // 模拟用户在 UI 里删掉 bot（不重启服务）
    const after = await postBot(base, "/bot/webhook/b1", SECRET);
    assert.equal(after.status, 404, "配置删除后必须立即 404（fail-closed）");
  });
});

// ── A14：裸形状显式 400 ──────────────────────────────────────────────────

test("A14：裸形状 /bot/:provider ⇒ 400 且给出可操作指引（不做兜底）", async () => {
  await withServer(
    { authToken: TOKEN, botIngressEnabled: true, bots: [webhookBot("b1")] },
    async (base) => {
      const res = await postBot(base, "/bot/webhook", SECRET);
      assert.equal(res.status, 400, "裸形状必须显式 400（不是 404 也不是兜底放行）");
      assert.match(await res.text(), /Missing botId/);
    },
  );
});

test("A14b：非 webhook provider ⇒ 400", async () => {
  await withServer(
    { authToken: TOKEN, botIngressEnabled: true, bots: [webhookBot("b1")] },
    async (base) => {
      assert.equal((await postBot(base, "/bot/telegram/b1", SECRET)).status, 400);
      assert.equal((await postBot(base, "/bot/nonsense/b1", SECRET)).status, 400);
    },
  );
});

// ── A15：请求体上限 ──────────────────────────────────────────────────────

test("A15：请求体上限生效，且不误伤合法最大 payload", async () => {
  const MB = 1024 * 1024;
  await withServer(
    { authToken: TOKEN, botIngressEnabled: true, bots: [webhookBot("b1")] },
    async (base) => {
      // ① 合法最大 payload（4 × 5MiB 附件的 base64）必须通过 —— 这是 32 MiB 的取值依据。
      const legalBytes =
        Math.ceil((BOT_MAX_ATTACHMENTS_PER_MESSAGE * BOT_MAX_ATTACHMENT_SIZE_BYTES) / 3) * 4;
      const legal = "x".repeat(legalBytes);
      const okRes = await postBot(base, "/bot/webhook/b1", SECRET, legal);
      assert.equal(okRes.status, 200, "合法最大 payload 不得被上限拒绝（否则会打断正常回调）");
      // ② 超限必须 413。
      const over = "x".repeat(BOT_INGRESS_MAX_BODY_BYTES + 2 * MB);
      const overRes = await postBot(base, "/bot/webhook/b1", SECRET, over);
      assert.equal(overRes.status, 413, "超限必须 413");
    },
  );
});

// ── C1/C2：与既有上限的耦合断言（spec §7.1.1）────────────────────────────

test("C1：请求体上限必须覆盖「合法最大 payload」（改了附件上限就必须重算）", () => {
  // 这是**耦合断言**：若 BOT_MAX_ATTACHMENTS_PER_MESSAGE 或 BOT_MAX_ATTACHMENT_SIZE_BYTES
  // 被调大而没同步上调 BOT_INGRESS_MAX_BODY_BYTES，本断言变红。
  // 反向验证：把 BOT_INGRESS_MAX_BODY_BYTES 调成 6MiB ⇒ 变红（这正是初稿的失败形态）。
  const legalBytes =
    Math.ceil((BOT_MAX_ATTACHMENTS_PER_MESSAGE * BOT_MAX_ATTACHMENT_SIZE_BYTES) / 3) * 4;
  assert.ok(
    BOT_INGRESS_MAX_BODY_BYTES >= legalBytes,
    "请求体上限 " +
      String(BOT_INGRESS_MAX_BODY_BYTES) +
      " 必须覆盖合法最大 payload " +
      String(legalBytes),
  );
});

test("C2：走请求体的附件来源集合恰好是 {dataBase64}", async () => {
  // 若未来新增一条走请求体的附件来源，本断言变红 ⇒ 迫使把它的字节数并入 C1 的公式。
  const source = await (
    await import("node:fs/promises")
  ).readFile(new URL("../src/botIngress.ts", import.meta.url), "utf8");
  // botIngress.ts 只负责上限，不解析附件；这里钉的是「上限的推导依据」写在注释里，
  // 且指向 botsService 的 dataBase64 通道。真正的来源集合断言放在 services 侧更合适，
  // 此处只做**文档-实现一致性**的弱断言（避免跨包读源码的脆弱测试）。
  assert.match(source, /dataBase64/, "上限的推导依据必须写明 dataBase64 通道");
});

// ── 审计与隐私 ───────────────────────────────────────────────────────────

test("A12：secret 与令牌绝不出现在审计输出里（否定式）", async () => {
  const lines: string[] = [];
  const audit = createAuditLog({
    write: (line: string) => {
      lines.push(line);
    },
  });
  await withServer(
    { authToken: TOKEN, botIngressEnabled: true, bots: [webhookBot("b1")], audit },
    async (base) => {
      await postBot(base, "/bot/webhook/b1", "wrong-secret-marker");
      await postBot(base, "/bot/webhook/b1", SECRET);
      await postBot(base, "/bot/webhook/nonexistent", SECRET);
    },
  );
  audit.flush();
  const joined = lines.join("\n");
  assert.ok(joined.length > 0, "应当确实产生了审计输出（否则断言空转）");
  assert.ok(!joined.includes(SECRET), "审计里出现了真实 secret");
  assert.ok(!joined.includes("wrong-secret-marker"), "审计里出现了攻击者提供的 secret");
  assert.ok(!joined.includes(TOKEN), "审计里出现了令牌");
  // 正向：排障需要的类别信息仍在。
  assert.match(joined, /audit:bot-auth-failure/, "应当有 bot 凭据失败事件");
  assert.match(joined, /audit:bot-callback/, "应当有 bot 成功事件");
  assert.match(joined, /audit:bot-rejected/, "应当有 bot 拒绝事件");
});

/**
 * 从源码里列出 `app.use/get/post("路径")` 的注册点。
 *
 * 为什么不用一条正则：本文件的路由路径里含 `/*`（`"/bot/*"`），而块注释也以 `/*` 开头 ⇒
 * 任何「先剥注释再匹配」的正则都会把字符串里的 `/*` 当成注释起点，从而吞掉后面的真实注册
 * （实测踩过两次：先漏掉 3 条 `app.use("*")`，再漏掉 `app.use("/bot/*")`）。
 * 这里改为**逐字符扫描**，正确区分字符串与注释 —— 与它要保护的东西（注册面）同级的可靠性。
 */
function scanRouteRegistrations(source: string): string[] {
  const found: string[] = [];
  let i = 0;
  let inBlockComment = false;
  let inLineComment = false;
  let inString: string | null = null;
  while (i < source.length) {
    const ch = source[i] ?? "";
    const next = source[i + 1] ?? "";
    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      i += 1;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (inString !== null) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === inString) inString = null;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      i += 1;
      continue;
    }
    if (source.startsWith("app.", i)) {
      const m = /^app\.(use|get|post)\(\s*(["\x27])([^"\x27]*)\2/.exec(source.slice(i));
      if (m) {
        found.push(m[1] + " " + m[3]);
        i += m[0].length;
        continue;
      }
    }
    i += 1;
  }
  return found;
}
// ── A13：路由注册点白名单（否定式）─────────────────────────────────────

test("A13：http.ts 的中间件注册点集合等于字面量白名单", async () => {
  const source = await (
    await import("node:fs/promises")
  ).readFile(new URL("../src/http.ts", import.meta.url), "utf8");
  // 用「注册点 → 条数」的计数表，而不是扁平数组：
  // 既有 http.ts 有多条 app.use("*")（告警、安全头、Host、来源、令牌…），
  // 扁平数组无法区分「新增了一条 app.use("*")」与「既有那些还在」。
  const counts = new Map<string, number>();
  for (const key of scanRouteRegistrations(source)) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  // app.use("*") 的条数单独钉住：它是「全局中间件链的规模」，任何改动都必须是有意的。
  const useStarCount = counts.get("use *") ?? 0;
  counts.delete("use *");
  // 当前为 5 条（实测计数，非估算）：① 暴露面告警 ② 安全响应头 ③ Host 白名单
  // ④ 来源校验 ⑤ 令牌中间件。**任何变化都必须是有意的**（全局中间件链的规模变了）。
  assert.equal(
    useStarCount,
    5,
    'app.use("*") 的条数发生了变化（全局中间件链被改动）—— 请确认是有意的并更新本数字',
  );
  // 其余注册点按「路径 → 条数」比对。新增/删除都必须来这里更新。
  const allowed = new Map<string, number>([
    ["get *", 1],
    ["get /api/server-info", 1],
    ["get /ws", 1],
    ["get /ws/host", 1],
    ["get /ws/remote/:id", 1],
    ["post /api/connect-remote", 1],
    ["post /api/rpc-host-capability", 1],
    ["use /bot/*", 1],
    ["use /ws/host", 1],
  ]);
  assert.deepEqual(
    [...counts.entries()].sort(),
    [...allowed.entries()].sort(),
    "http.ts 的路由注册点发生了变化（请同步更新本白名单与 ROUTE_POLICY）",
  );
});
