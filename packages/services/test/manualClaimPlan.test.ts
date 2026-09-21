import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { classifyManualClaimCode, pickManualClaimPlan, ZCODE_VERSION } from "@zcode/shared";
import { BigModelCodingPlanSubscriptionProvider } from "../src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.js";
import { createCodingPlanSubscriptionService } from "../src/coding-plan-subscription/codingPlanSubscriptionService.js";
import { createManualClaimCaptcha } from "../src/coding-plan-subscription/manualClaimCaptcha.js";
import { createManualClaimPlanClient } from "../src/coding-plan-subscription/manualClaimPlanClient.js";
import { ensureDeviceMid } from "../src/device/deviceMid.js";
import { createNodeApiClient } from "../src/providers/api/nodeApiClient.js";

/**
 * claim 平面（周末 / 体验套餐领取）测试。
 *
 * 全程本地 mock HTTP server：不登录、不带真实账号、不消耗任何额度。
 * 端点 origin 通过 ZCODE_BASE_URL 指向 mock，顺带证明 claim 平面没有硬编码 zcode.z.ai。
 */

interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

type Responder = (req: CapturedRequest, res: ServerResponse) => void;

const captured: CapturedRequest[] = [];
let responder: Responder = (_req, res) => {
  res.writeHead(500);
  res.end();
};
let baseUrl = "";

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const entry: CapturedRequest = {
      method: req.method ?? "GET",
      url: req.url ?? "/",
      headers: Object.fromEntries(
        Object.entries(req.headers).flatMap(([key, value]) =>
          typeof value === "string" ? [[key.toLowerCase(), value]] : [],
        ),
      ),
      body: Buffer.concat(chunks).toString("utf-8"),
    };
    captured.push(entry);
    responder(entry, res);
  });
});

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

/** 每次请求前调用：清空捕获并按需设置响应。 */
function expectResponse(next: Responder): void {
  captured.length = 0;
  responder = next;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 平台头必须跟随运行环境，不能写死 linux-x64（仓库需兼容 Windows/macOS/Linux）。 */
const PLATFORM = process.platform + "-" + process.arch;
const DEVICE_MID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const JWT = "test-only-jwt";

const apiClient = createNodeApiClient();
const client = createManualClaimPlanClient({
  apiClient,
  deviceMid: DEVICE_MID,
  appVersion: ZCODE_VERSION,
  platform: PLATFORM,
});

const CREDENTIAL_SERVICE = {
  load: async (key: string): Promise<string | null> => (key === "zcodejwttoken" ? JWT : null),
};

const PREVIEW_PAYLOAD = {
  code: 0,
  data: {
    server_time: 1758000000,
    plans: [
      {
        plan_id: "wk-0918",
        name: "Weekend Plan",
        description: "weekend",
        priority: 10,
        starts_at: 1758000000,
        ends_at: 1758086400,
        entitlements: [
          {
            entitlement_id: "ent-1",
            show_name: "Weekend quota",
            meter: "tokens",
            unit_type: "token",
            capabilities: ["chat"],
            grant_units: 1000000,
            period: "day",
            priority: 1,
            effective_at: 1758010000,
          },
          // 缺 entitlement_id 的脏条目必须被丢弃，而不是让整条 preview 失败
          { show_name: "dirty" },
        ],
      },
      // 缺 plan_id 的脏套餐必须被丢弃
      { name: "no-plan-id" },
    ],
  },
};

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  baseUrl = "http://127.0.0.1:" + port;
  // 端点 origin 指向本地 mock：证明 claim 平面跟随运行时 endpoint 而非硬编码线上域名。
  process.env["ZCODE_BASE_URL"] = baseUrl;
  process.env["ZCODE_ENDPOINT_ORIGIN"] = baseUrl;
});

after(() => {
  server.close();
});

test("preview 解析：snake_case 归一化 + 脏条目丢弃", async () => {
  expectResponse((_req, res) => json(res, 200, PREVIEW_PAYLOAD));
  const plans = await client.getPreviews({ jwt: JWT });
  assert.equal(plans.length, 1, "缺 plan_id 的脏套餐应被丢弃");
  assert.equal(plans[0]!.planId, "wk-0918");
  assert.equal(plans[0]!.name, "Weekend Plan");
  assert.equal(plans[0]!.priority, 10);
  assert.equal(plans[0]!.startsAt, 1758000000);
  assert.equal(plans[0]!.endsAt, 1758086400);
  assert.equal(plans[0]!.entitlements.length, 1, "缺 entitlement_id 的脏权益应被丢弃");
  assert.equal(plans[0]!.entitlements[0]!.grantUnits, 1000000);
  assert.equal(plans[0]!.entitlements[0]!.effectiveAt, 1758010000);
  assert.deepEqual(plans[0]!.entitlements[0]!.capabilities, ["chat"]);
});

test("preview 头契约：UUID X-Device-Mid + Bearer JWT", async () => {
  expectResponse((_req, res) => json(res, 200, PREVIEW_PAYLOAD));
  await client.getPreviews({ jwt: JWT });
  const req = captured[0]!;
  assert.equal(req.method, "GET");
  assert.ok(req.url.startsWith("/api/v1/zcode-plan/billing/preview?"), req.url);
  assert.ok(req.url.includes("app_version=" + ZCODE_VERSION), req.url);
  assert.ok(req.url.includes("platform=" + PLATFORM), req.url);
  assert.equal(req.headers["x-device-mid"], DEVICE_MID);
  assert.ok(UUID_RE.test(req.headers["x-device-mid"] ?? ""), "X-Device-Mid 必须是 UUID");
  assert.equal(req.headers["authorization"], "Bearer " + JWT);
});

test("匿名 preview：保留 X-Device-Mid，省略 Authorization", async () => {
  // 活动网关对缺 X-Device-Mid 的请求一律回 biz 3001；未登录也必须带该头。
  expectResponse((_req, res) => json(res, 200, PREVIEW_PAYLOAD));
  await client.getPreviews({});
  assert.equal(captured[0]!.headers["x-device-mid"], DEVICE_MID);
  assert.equal(captured[0]!.headers["authorization"], undefined);
});

test("claim 头契约：captcha/app-version/platform/device-mid 全带", async () => {
  expectResponse((_req, res) =>
    json(res, 200, {
      code: 0,
      data: { plan: { plan_id: "wk-0918", starts_at: 1758010000, ends_at: 1758086400 } },
    }),
  );
  const outcome = await client.claim(
    "wk-0918",
    { verifyParam: "verify-param-value", region: "sgp" },
    { jwt: JWT },
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok && outcome.startsAt, 1758010000);
  assert.equal(outcome.ok && outcome.endsAt, 1758086400);

  const req = captured[0]!;
  assert.equal(req.method, "POST");
  assert.equal(req.url, "/api/v1/zcode-plan/billing/claim");
  assert.deepEqual(JSON.parse(req.body), { plan_id: "wk-0918" });
  assert.equal(req.headers["authorization"], "Bearer " + JWT);
  assert.equal(req.headers["content-type"], "application/json");
  assert.equal(req.headers["x-aliyun-captcha-verify-param"], "verify-param-value");
  assert.equal(req.headers["x-aliyun-captcha-verify-region"], "sgp");
  assert.equal(req.headers["x-zcode-app-version"], ZCODE_VERSION);
  assert.equal(req.headers["x-platform"], PLATFORM);
  assert.equal(req.headers["x-device-mid"], DEVICE_MID);
});

test("claim 无 region 时不发 X-Aliyun-Captcha-Verify-Region", async () => {
  expectResponse((_req, res) =>
    json(res, 200, { code: 0, data: { plan: { plan_id: "wk-0918" } } }),
  );
  await client.claim("wk-0918", { verifyParam: "vp" }, { jwt: JWT });
  assert.equal(captured[0]!.headers["x-aliyun-captcha-verify-region"], undefined);
});

test("未登录：短路为 login_required，不发请求", async () => {
  expectResponse((_req, res) => json(res, 500, {}));
  const outcome = await client.claim("wk-0918", { verifyParam: "vp" }, {});
  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.failureKind, "login_required");
  assert.equal(captured.length, 0, "未登录不应发出 claim 请求");
});

test("biz code 映射：8 个已知码 + unknown 兜底", () => {
  const cases: Array<[number, string]> = [
    [1001, "not_found"],
    [1002, "unavailable"],
    [1003, "already_claimed"],
    [1004, "ineligible"],
    [1005, "quota_exhausted"],
    [3001, "invalid_request"],
    [3007, "captcha"],
    [401, "login_required"],
    [9999, "unknown"],
  ];
  for (const [code, kind] of cases) {
    assert.equal(classifyManualClaimCode(code), kind, "code " + code + " → " + kind);
  }
  // 服务端偶尔用字符串承载 code，必须同样归类
  assert.equal(classifyManualClaimCode("1005"), "quota_exhausted");
  assert.equal(classifyManualClaimCode(undefined), "unknown");
});

test("HTTP 200 + biz 1005 → quota_exhausted（按业务码而非 HTTP 状态归类）", async () => {
  expectResponse((_req, res) => json(res, 200, { code: 1005, msg: "quota exhausted", data: null }));
  const outcome = await client.claim("wk-0918", { verifyParam: "vp" }, { jwt: JWT });
  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.failureKind, "quota_exhausted");
  assert.equal(!outcome.ok && outcome.code, 1005);
  assert.equal(!outcome.ok && outcome.message, "quota exhausted");
});

test("失败响应带 ends_at 时透传 failureEndsAt（下次可尝试窗口）", async () => {
  expectResponse((_req, res) =>
    json(res, 200, { code: 1003, msg: "already claimed", data: { plan: { ends_at: 1758086400 } } }),
  );
  const outcome = await client.claim("wk-0918", { verifyParam: "vp" }, { jwt: JWT });
  assert.equal(!outcome.ok && outcome.failureKind, "already_claimed");
  assert.equal(!outcome.ok && outcome.failureEndsAt, 1758086400);
});

test("HTTP 401 无业务码 → login_required", async () => {
  expectResponse((_req, res) => json(res, 401, {}));
  const outcome = await client.claim("wk-0918", { verifyParam: "vp" }, { jwt: JWT });
  assert.equal(!outcome.ok && outcome.failureKind, "login_required");
});

test("HTTP 500 无业务码 → http_error（不是 unknown）", async () => {
  expectResponse((_req, res) => json(res, 500, {}));
  const outcome = await client.claim("wk-0918", { verifyParam: "vp" }, { jwt: JWT });
  assert.equal(!outcome.ok && outcome.failureKind, "http_error");
});

test("非 JSON 响应 → 结构化失败（不抛异常）", async () => {
  // 支付/领取接口偶发返回 WAF HTML；原样透传会把整段 HTML 渲到界面。
  expectResponse((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<!DOCTYPE html><html>blocked</html>");
  });
  const outcome = await client.claim("wk-0918", { verifyParam: "vp" }, { jwt: JWT });
  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.failureKind, "unknown");
});

test("preview 失败：biz 3001 → 抛 ApiError（含服务端文案）", async () => {
  expectResponse((_req, res) => json(res, 400, { code: 3001, msg: "parameter error" }));
  await assert.rejects(() => client.getPreviews({ jwt: JWT }), /parameter error/);
});

test("验证码：配置缺失 → manual_claim_captcha_config_unavailable", async () => {
  expectResponse((_req, res) => json(res, 200, { code: 0, data: { configs: { captcha: null } } }));
  const captcha = createManualClaimCaptcha({ apiClient });
  await assert.rejects(
    () => captcha.getCaptchaCredential(),
    /manual_claim_captcha_config_unavailable/,
  );
});

test("验证码：活动未开启 → manual_claim_captcha_disabled", async () => {
  expectResponse((_req, res) =>
    json(res, 200, {
      code: 0,
      data: {
        configs: {
          captcha: { enabled: false, prefix: "no8xfe", sceneId: "11xygtvd", region: "sgp" },
        },
      },
    }),
  );
  const captcha = createManualClaimCaptcha({ apiClient });
  await assert.rejects(() => captcha.getCaptchaCredential(), /manual_claim_captcha_disabled/);
});

test("验证码：未注入求解器 → manual_claim_captcha_solver_unavailable", async () => {
  expectResponse((_req, res) =>
    json(res, 200, {
      code: 0,
      data: {
        configs: {
          captcha: { enabled: true, prefix: "no8xfe", sceneId: "11xygtvd", region: "sgp" },
        },
      },
    }),
  );
  const captcha = createManualClaimCaptcha({ apiClient });
  assert.deepEqual(await captcha.getConfig(), {
    enabled: true,
    prefix: "no8xfe",
    sceneId: "11xygtvd",
    region: "sgp",
  });
  await assert.rejects(
    () => captcha.getCaptchaCredential(),
    /manual_claim_captcha_solver_unavailable/,
  );
});

test("验证码：注入求解器 → verifyParam 透传 + region 回落配置", async () => {
  expectResponse((_req, res) =>
    json(res, 200, {
      code: 0,
      data: {
        configs: {
          captcha: { enabled: true, prefix: "no8xfe", sceneId: "11xygtvd", region: "sgp" },
        },
      },
    }),
  );
  const captcha = createManualClaimCaptcha({
    apiClient,
    solve: async () => ({ verifyParam: "solved-param" }),
  });
  assert.deepEqual(await captcha.getCaptchaCredential(), {
    verifyParam: "solved-param",
    region: "sgp",
  });
});

test("验证码配置：60s 快照复用 + forceRefresh 绕过", async () => {
  expectResponse((_req, res) =>
    json(res, 200, {
      code: 0,
      data: {
        configs: {
          captcha: { enabled: true, prefix: "no8xfe", sceneId: "11xygtvd", region: "sgp" },
        },
      },
    }),
  );
  const captcha = createManualClaimCaptcha({
    apiClient,
    solve: async () => ({ verifyParam: "p" }),
  });
  await captcha.getConfig();
  captured.length = 0;
  // 快照内第二次读取不应再打 /client/configs（灰度翻转最长 60s 不可见，是刻意的）
  await captcha.getConfig();
  assert.equal(captured.length, 0, "60s 快照内不应重复请求");
  await captcha.getConfig({ forceRefresh: true });
  assert.equal(captured.length, 1, "forceRefresh 必须绕过快照");
  assert.ok(captured[0]!.url.startsWith("/api/v1/client/configs"), captured[0]!.url);
});

test("默认目标：priority 最高者；显式 planId 缺失返回 null", () => {
  const plans = [
    { planId: "a", name: "a", description: "", priority: 1, entitlements: [] },
    { planId: "b", name: "b", description: "", priority: 9, entitlements: [] },
  ];
  assert.equal(pickManualClaimPlan(plans)?.planId, "b");
  assert.equal(pickManualClaimPlan(plans, "a")?.planId, "a");
  assert.equal(pickManualClaimPlan(plans, "nope"), null);
  assert.equal(pickManualClaimPlan([]), null);
});

test("deviceMid：复用 ensureDeviceMid，身份落盘且稳定不变", async () => {
  // claim 平面不接受自造身份：X-Device-Mid 必须与 CLI/Desktop 共享同一个设备身份文件。
  const homeDir = await mkdtemp(join(tmpdir(), "zcode-claim-device-"));
  try {
    const deviceMid = await ensureDeviceMid({ homeDir });
    assert.ok(UUID_RE.test(deviceMid), "ensureDeviceMid 必须产出 UUID，实际 " + deviceMid);
    const stateFile = JSON.parse(
      await readFile(join(homeDir, ".zcode", "v2", "telemetry-state.json"), "utf-8"),
    ) as { deviceMid?: string };
    assert.equal(stateFile.deviceMid, deviceMid, "deviceMid 必须落盘到既有设备身份文件");
    // 换身份 = 权益头失效：二次调用必须读回同一身份。
    assert.equal(await ensureDeviceMid({ homeDir }), deviceMid);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("provider：preview 注入账号 JWT + 设备身份", async () => {
  const provider = new BigModelCodingPlanSubscriptionProvider({
    apiClient,
    credentialService: CREDENTIAL_SERVICE,
    resolveDeviceMid: async () => DEVICE_MID,
  });
  expectResponse((_req, res) => json(res, 200, PREVIEW_PAYLOAD));
  const plans = await provider.getManualClaimPlanPreviews();
  assert.equal(plans.length, 1);
  assert.equal(captured[0]!.headers["authorization"], "Bearer " + JWT);
  assert.equal(captured[0]!.headers["x-device-mid"], DEVICE_MID);
});

test("provider：无 JWT → login_required 且不发请求", async () => {
  const provider = new BigModelCodingPlanSubscriptionProvider({
    apiClient,
    credentialService: { load: async () => null },
    resolveDeviceMid: async () => DEVICE_MID,
  });
  expectResponse((_req, res) => json(res, 500, {}));
  const outcome = await provider.claimManualPlan({ planId: "wk-0918" });
  assert.equal(!outcome.ok && outcome.failureKind, "login_required");
  assert.equal(captured.length, 0, "无 JWT 不应发出 claim 请求");
});

test("provider：有 JWT 无求解器 → captcha_unavailable（稳定码，不抛异常）", async () => {
  const provider = new BigModelCodingPlanSubscriptionProvider({
    apiClient,
    credentialService: CREDENTIAL_SERVICE,
    resolveDeviceMid: async () => DEVICE_MID,
  });
  const outcome = await provider.claimManualPlan({ planId: "wk-0918" });
  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.failureKind, "captcha_unavailable");
  assert.equal(!outcome.ok && outcome.code, "manual_claim_captcha_solver_unavailable");
});

test("provider：UI 传入 verifyParam → 走完整 claim 路径", async () => {
  // 桌面端主路径：UI 在内嵌 WebView 求解后把 verifyParam 直接传进来。
  const provider = new BigModelCodingPlanSubscriptionProvider({
    apiClient,
    credentialService: CREDENTIAL_SERVICE,
    resolveDeviceMid: async () => DEVICE_MID,
  });
  expectResponse((_req, res) =>
    json(res, 200, {
      code: 0,
      data: { plan: { plan_id: "wk-0918", starts_at: 100, ends_at: 200 } },
    }),
  );
  const outcome = await provider.claimManualPlan({
    planId: "wk-0918",
    captcha: { verifyParam: "ui-verify-param", region: "sgp" },
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok && outcome.endsAt, 200);
  assert.equal(captured[0]!.headers["x-aliyun-captcha-verify-param"], "ui-verify-param");
});

test("provider：空 planId → invalid_request 且不发请求", async () => {
  const provider = new BigModelCodingPlanSubscriptionProvider({
    apiClient,
    credentialService: CREDENTIAL_SERVICE,
    resolveDeviceMid: async () => DEVICE_MID,
  });
  expectResponse((_req, res) => json(res, 500, {}));
  const outcome = await provider.claimManualPlan({ planId: "   " });
  assert.equal(!outcome.ok && outcome.failureKind, "invalid_request");
  assert.equal(captured.length, 0);
});

test("service：preview / captchaConfig / claim 三个新方法均可装配调用", async () => {
  const service = createCodingPlanSubscriptionService({
    apiClient,
    credentialService: CREDENTIAL_SERVICE,
    resolveDeviceMid: async () => DEVICE_MID,
  });
  expectResponse((_req, res) => json(res, 200, PREVIEW_PAYLOAD));
  assert.equal((await service.getManualClaimPlanPreviews()).length, 1);

  expectResponse((_req, res) =>
    json(res, 200, {
      code: 0,
      data: {
        configs: {
          captcha: { enabled: true, prefix: "no8xfe", sceneId: "11xygtvd", region: "sgp" },
        },
      },
    }),
  );
  assert.deepEqual(await service.getManualClaimCaptchaConfig(), {
    enabled: true,
    prefix: "no8xfe",
    sceneId: "11xygtvd",
    region: "sgp",
  });

  const outcome = await service.claimManualPlan({ planId: "wk-0918" });
  assert.equal(!outcome.ok && outcome.failureKind, "captcha_unavailable");
});
