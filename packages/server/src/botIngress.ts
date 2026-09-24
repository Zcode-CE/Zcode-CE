import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { IBotsService, ICredentialService, type ServiceCollection } from "@zcode/services";
import { botProviders, type BotProvider } from "@zcode/shared";
import type { AuditLog } from "./auditLog.js";
import { resolveClientAddress, type AuthThrottle, type TrustedProxyRange } from "./authThrottle.js";

/**
 * IM 机器人入站回调的独立接入面（/bot/**）。
 *
 * 设计依据：`.reverse/93-bot-ingress/BOT-INGRESS-SPEC.md`（本文的 § 引用均指该 spec）。
 *
 * ## 为什么是独立前缀而不是 /api/bots
 *
 * 上游把该路由挂在 /api/bots/:provider[/:botId]（上游 http.ts:414-415），而本仓库与上游
 * 都用令牌保护 /api 前缀（本仓库 isTokenProtectedPath；上游 :239-240）。
 * ⇒ 第三方 IM 不带我们的令牌，注册了也会被 401 挡在门外。给 /api 开豁免等于在令牌面上
 * 打洞 —— 而那正是本仓库投入最多防护的一层。
 *
 * ⇒ 改为平行前缀 /bot/**：它不以 /api 开头，因此 isTokenProtectedPath 对它恒为 false，
 * 完全不触碰令牌面；它有自己的凭据（x-zcode-bot-secret，逐 bot，存在 credentialService）。
 *
 * ## 为什么注册在令牌中间件之前（关键，spec §4.3 方案 D1）
 *
 * 令牌面的封禁闸门是 app.use("*") 且在路径分派之前执行（throttle.check(peer)），它
 * 不看路径 ⇒ 若本 gate 注册在其后，一个被令牌面封禁的地址打 /bot/** 会拿到 403 而不是
 * 404（「渠道未启用」的语义），且 bot 入站会被令牌面的封禁误伤。
 *
 * 实测对比（spec §8.4 R12，12 格矩阵）后的取舍：本 gate 注册在令牌中间件之前、并自行终结
 * 请求（不 next()） ⇒ 既有令牌中间件零改动。
 * ⇒ 这比「在令牌中间件里加一条路径判断让路」更强：结构性保证 > 断言保证（后者靠一条 if
 * 正确，一旦写错就会静默把 bot 面重新暴露给令牌面闸门）。
 *
 * ## 默认状态 = 攻击面为零
 *
 * 未启用任何 webhook 渠道时，gate 在第一个判断就返回 c.notFound()：不读配置、不读凭据、
 * 不读请求体、零 I/O，其响应与「这条路由根本不存在」逐字节相同（实测 spec §8.4 R3/R15）
 * ⇒ 「未注册」与「注册了但拒绝」在可观测层面不可区分。
 *
 * ## 安全边界在哪一层（不要误读）
 *
 * options.enabled 只是快速短路（省掉未启用时的全部工作），不承担安全边界。
 * 真正的边界是逐请求的：③ 运行期判定 + ④ 凭据校验 + ⑤ 限流。
 * ⇒ 即使 enabled 因竞态或陈旧快照误为 true，也不会放行任何请求（③ 会挡回 404）；
 * 反向误为 false 只会让入站暂时不可用（fail-closed），不会造成放行。
 */

/**
 * /bot/** 的请求体上限（spec §7.1）。
 *
 * 取值依据：入站附件有一条 dataBase64 通道走请求体（botsService 的 resolveAttachmentBytes），
 * 而附件上限是 4 个 × 5 MiB ⇒ base64 膨胀后合法最大值 = 26.67 MB。
 * 取 32 MiB 覆盖合法值并留余量；32 * 1024 * 1024 也是仓库既有的常量口径
 * （packages/shared/src/zcode-protocol-v4/core.ts 等 5 处）。
 *
 * ⚠️ 耦合：若 BOT_MAX_ATTACHMENTS_PER_MESSAGE 或 BOT_MAX_ATTACHMENT_SIZE_BYTES 变了，
 * 本值必须同步重算 —— 否则会静默打断合法流量（这正是初稿取 6 MiB 时的实测失败形态）。
 * 该耦合由 test/botIngress.test.ts 的耦合断言钉住（spec §7.1.1 的 C1/C2）。
 */
export const BOT_INGRESS_MAX_BODY_BYTES = 32 * 1024 * 1024;

/**
 * 入站凭据头名。固定，不跟随出站的 webhookAuthHeaderName（spec §3.6 的 P7 裁决）：
 * 可配头名会让攻击者可控的语义进入凭据面（绕开按头名写的限流/审计规则）。
 */
export const BOT_INGRESS_SECRET_HEADER = "x-zcode-bot-secret";

/**
 * 常量时间字符串比较。
 *
 * 口径照抄本仓库既有两处先例（apps/zcode-cli 的 cua-broker.ts 与 node-repl-browser-broker.ts
 * 的 length !== length || !timingSafeEqual(...)）。timingSafeEqual 在长度不等时抛错，
 * 故长度检查必须前置。
 *
 * 诚实边界：只保证「用了正确的原语」，不能证明端到端无时序侧信道。
 */
/**
 * 有界流式读请求体：超过 `maxBytes` 立即中止并返回 null。
 *
 * 为什么不用 `hono/body-limit`：它的机制是「把 body 换成计数流 → 调 next() → 若下游读了体
 * 并触发 BodyLimitError，则在 next() 之后把 c.res 换成 413」。本 gate 是自行终结请求的
 * （不把请求交给下游 handler），因此 bodyLimit 的错误永远不会浮现 —— 实测：把 33MB 打进来
 * 仍返回 200（上限完全失效）。⇒ 改为在 gate 内自己读，顺序与上限都完全可控。
 *
 * 性质（与 spec §7.1 的承诺一致）：
 * - 流式：只保留到上限为止的字节，不把超大体积整块读进内存；
 * - 不依赖 Content-Length：chunked 请求同样受限（逐 chunk 累加），故无法绕过；
 * - 顺序可控：调用点决定它在凭据校验之前还是之后。
 */
async function readBodyWithLimit(
  c: Context,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false }> {
  const body = c.req.raw.body;
  if (!body) {
    return { ok: true, text: "" };
  }
  // 快路径：有 Content-Length 且已超限 ⇒ 不必读。
  const declared = Number(c.req.header("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        // 超限即停：不再继续读，也不保留已读内容。
        await reader.cancel().catch(() => undefined);
        return { ok: false };
      }
      chunks.push(value);
    }
  } catch {
    // 读体失败（对端中断等）⇒ 按「拿不到完整体」处理，交给上层给 400/503。
    return { ok: false };
  }
  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}
function isConstantTimeEqual(actual: string | undefined, expected: string): boolean {
  const actualBytes = Buffer.from(actual ?? "", "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (actualBytes.length !== expectedBytes.length) {
    return false;
  }
  return timingSafeEqual(actualBytes, expectedBytes);
}

export interface BotIngressGateOptions {
  /**
   * 启动期判定：是否存在 enabled 的 webhook bot。
   *
   * 只做快速短路，不承担安全边界（见文件头）。由 entry-http.ts 求出 ——
   * 因为 listBots() 是异步的而 createHttpServer 是同步的，且 entry 本来就是
   * 「读环境 → 判定 → 传 options」的位置。
   */
  enabled: boolean;
  /** bot 面独立限流桶（spec §4.2：与令牌面共享会造出跨面拒绝服务）。 */
  throttle: AuthThrottle;
  audit: AuditLog;
  warn: (message: string) => void;
  trustedProxies: readonly TrustedProxyRange[];
  /** 请求体上限；默认 BOT_INGRESS_MAX_BODY_BYTES。 */
  maxBodyBytes?: number;
}

/**
 * 从 /bot/:provider[/:botId] 取路径参数。
 *
 * 为什么不用 c.req.param：本 gate 是 app.use 中间件，Hono 不在这一层解析路由参数。
 */
function parseBotPath(pathname: string): { provider: string; botId?: string } | null {
  // 归一化已在 new URL(...).pathname 阶段完成（spec §1.3）：.. 形式会落回 /api/...，
  // 于是被令牌中间件接走，不会到这里。
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "bot" || segments.length < 2) {
    return null;
  }
  const provider = segments[1] ?? "";
  const botId = segments[2];
  return { provider, ...(botId ? { botId } : {}) };
}

function isBotProvider(value: string): value is BotProvider {
  return (botProviders as readonly string[]).includes(value);
}

/**
 * 创建 /bot/** 的惰性闸门（spec §2.1 的 D1 注册模型）。
 *
 * 必须注册在令牌中间件之前，且无条件注册（「是否启用」是 gate 内部的第一个判断）。
 */
export function createBotIngressGate(
  services: ServiceCollection,
  options: BotIngressGateOptions,
): MiddlewareHandler {
  const maxBodyBytes = options.maxBodyBytes ?? BOT_INGRESS_MAX_BODY_BYTES;

  // 注意签名里不接 next：本 gate 对 /bot/** 一律自行终结请求（永不把请求交给下游）。
  // 这不是省参数 —— 它是 D1 的结构性保证的代码形态：没有 next 就不可能意外放行到
  // 令牌中间件（后者注册在本 gate 之后）。
  return async (c) => {
    // ① 未启用 ⇒ 与「这条路由根本不存在」逐字节相同。零 I/O（不读配置/凭据/请求体）。
    //    这是「默认不注册 = 攻击面为零」的落点。
    if (!options.enabled) {
      return c.notFound();
    }

    const pathname = new URL(c.req.url).pathname;
    const peer = resolveClientAddress({
      socketAddress: (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
        ?.incoming?.socket?.remoteAddress,
      forwardedFor: c.req.header("x-forwarded-for"),
      trustedProxies: options.trustedProxies,
    });
    const method = c.req.method;

    // ③ 路径与运行期判定。
    const parsed = parseBotPath(pathname);
    if (!parsed) {
      // 理论上不会到这里（gate 只挂在 /bot/* 上）；保守返回 404 而不是继续。
      return c.notFound();
    }
    if (!isBotProvider(parsed.provider) || parsed.provider !== "webhook") {
      // 400：调用方错误、不可重试。只回显入参 provider，不回显本机支持的 provider 列表
      // （否则等于免费告诉攻击者该试探什么）。
      options.audit.record({
        kind: "audit:bot-rejected",
        peer: peer ?? "unknown",
        method,
        path: pathname,
        reason: "provider 不受支持或非 webhook",
      });
      return c.json({ error: "Unsupported provider: " + parsed.provider }, 400);
    }
    if (!parsed.botId) {
      // 裸形状 /bot/:provider：注册但显式 400（spec §10.1 的 P1 裁决）。
      // 为什么不做「用配置里唯一的 webhook bot」兜底：那与「鉴权先于读体」不兼容
      // （secret 逐 bot），且「唯一」会随配置条数静默变化 —— 上游的该兜底正是
      // 服务层 fail-open 的成因之一。明确（400）优于猜测。
      options.audit.record({
        kind: "audit:bot-rejected",
        peer: peer ?? "unknown",
        method,
        path: pathname,
        reason: "缺少 botId",
      });
      return c.json({ error: "Missing botId. Use /bot/<provider>/<botId>." }, 400);
    }

    const botsService = services.getOptional(IBotsService);
    const credentialService = services.getOptional(ICredentialService);
    if (!botsService || !credentialService) {
      // 服务面缺失：不可重试的部署问题。503 让 IM 平台稍后重试（而非静默 200）。
      options.audit.record({
        kind: "audit:bot-rejected",
        peer: peer ?? "unknown",
        method,
        path: pathname,
        reason: "Bots service is not available",
      });
      return c.json({ error: "Bots service is not available." }, 503);
    }

    let bots;
    try {
      bots = await botsService.listBots();
    } catch (error) {
      options.warn(
        "读取 bot 配置失败（入站回调被拒绝）：" +
          (error instanceof Error ? error.message : String(error)),
      );
      return c.json({ error: "Bots service is not available." }, 503);
    }
    const bot = bots.find(
      (item) => item.id === parsed.botId && item.provider === "webhook" && item.enabled,
    );
    if (!bot) {
      // 404：与「路由未注册」逐字节相同 ⇒ 攻击者无法用状态码区分
      // 「这台机器上有没有开 bot 入站」。写审计（可观测）但不计限流（不封禁）。
      options.audit.record({
        kind: "audit:bot-rejected",
        peer: peer ?? "unknown",
        method,
        path: pathname,
        reason: "渠道未启用或 bot 不存在",
      });
      return c.notFound();
    }

    // ④ 封禁闸门（在凭据校验之前，与令牌面的 ⓪ 同口径）。
    //    顺序理由：被封禁的地址应当在做任何校验之前就被拒 —— 否则「已封禁」的语义会退化成
    //    「每次都重新算一遍凭据再给 401」，攻击者仍能持续消耗我们的校验预算，而且状态码会在
    //    「401（本次凭据错）」与「403（已被封禁）」之间摇摆，让 IM 平台无法区分该不该重试。
    //    实测发现（本批）：把闸门放在凭据之后时，第 maxFailures+1 次仍返回 401 而非 403。
    const gate = options.throttle.check(peer);
    if (!gate.allowed) {
      options.audit.record({
        kind: "audit:bot-ban",
        peer: peer ?? "unknown",
        path: pathname,
        reason: "已被封禁的地址再次请求（bot 入站面）",
      });
      return c.json(
        {
          error:
            "Too many failed authentication attempts. This client address is temporarily blocked.",
        },
        403,
      );
    }

    // ⑤ 凭据校验：必须在读请求体之前（auth-before-parse）。上游是先 JSON.parse 再交 service
    //    校验（上游 http.ts:382-390），本实现把顺序反过来。
    const providedSecret = c.req.header(BOT_INGRESS_SECRET_HEADER);
    const expectedSecret = bot.webhookSecretRef
      ? await credentialService.load(bot.webhookSecretRef).catch(() => null)
      : null;
    // fail-closed：未配（null）与读不到（load 抛错/返回 null）一律拒绝 —— 没有「跳过校验」这条路径。
    const secretOk =
      typeof expectedSecret === "string" &&
      expectedSecret.length > 0 &&
      isConstantTimeEqual(providedSecret, expectedSecret);
    if (!secretOk) {
      const banned = options.throttle.recordFailure(peer);
      options.audit.record({
        kind: "audit:bot-auth-failure",
        peer: peer ?? "unknown",
        method,
        path: pathname,
        // 只写类别，不写期望值/实际值/长度（否则泄漏给攻击者）。
        reason: expectedSecret ? "secret 不匹配" : "secret 未配置或不可读",
      });
      if (banned) {
        options.audit.record({
          kind: "audit:bot-ban",
          peer: peer ?? "unknown",
          path: pathname,
          reason: "同一地址连续失败达到阈值，已临时封禁（bot 入站面）",
        });
      }
      options.warn(
        "bot 入站凭据校验失败（" +
          (banned
            ? "已触发封禁"
            : "累计 " + String(options.throttle.failureCount(peer ?? "")) + " 次") +
          "）：" +
          method +
          " " +
          pathname +
          "，对端=" +
          (peer ?? "unknown"),
      );
      return c.json({ error: "Unauthorized" }, 401);
    }
    // 成功即清零：正常平台的偶发重试不该累积到阈值。
    options.throttle.recordSuccess(peer);

    // ⑦ 有界读体（上限见 BOT_INGRESS_MAX_BODY_BYTES）：在凭据校验之后读，
    //    这样「未鉴权的大体」不会消耗我们的读取预算（auth-before-parse）。
    const bounded = await readBodyWithLimit(c, maxBodyBytes);
    if (!bounded.ok) {
      options.audit.record({
        kind: "audit:bot-rejected",
        peer: peer ?? "unknown",
        method,
        path: pathname,
        reason: "请求体超过上限",
      });
      return c.json({ error: "Payload too large" }, 413);
    }
    const rawBodyText = bounded.text;
    let rawBody: unknown = {};
    if (rawBodyText) {
      try {
        rawBody = JSON.parse(rawBodyText) as unknown;
      } catch {
        rawBody = { payload: rawBodyText };
      }
    }
    const payload =
      typeof rawBody === "object" && rawBody !== null ? (rawBody as Record<string, unknown>) : {};

    options.audit.record({
      kind: "audit:bot-callback",
      peer: peer ?? "unknown",
      method,
      path: pathname,
      reason: "凭据通过",
    });

    let result;
    try {
      result = await botsService.handleProviderCallbackResponse("webhook", {
        ...payload,
        botId: parsed.botId,
        rawBody: rawBodyText,
        // secret 继续往下传：服务层还有一层独立的 fail-closed 校验（纵深，spec §3.7）。
        webhookSecret: providedSecret,
      });
    } catch (error) {
      // 抛错 = 业务失败 ⇒ 503 透传（绝不能 200：那会让 webhook 发送方以为消息已消费，
      // 效果与提前提交 Telegram offset 相同 —— 上游 http.ts:407-408 的原文理由）。
      options.warn(
        "bot 入站回调处理异常：" + (error instanceof Error ? error.message : String(error)),
      );
      return c.json({ error: "Bot callback failed" }, 503);
    }

    const responseBody = result.responseBody ?? { ok: result.ok, replies: result.replies };
    if (result.status === 400) {
      return c.json(responseBody, 400);
    }
    if (result.status === 401) {
      return c.json(responseBody, 401);
    }
    if (result.status === 503) {
      // Bugfix（照搬上游同款理由）：Bot 业务失败必须把可重试状态透传给 HTTP provider；
      // 返回 200 会让 webhook/网关误以为消息已消费，效果与提前提交 Telegram offset 相同。
      return c.json(responseBody, 503);
    }
    if (!result.ok) {
      // 服务层表达了失败但没有显式 status ⇒ 仍按可重试处理（不静默 200）。
      return c.json(responseBody, 503);
    }
    return c.json(responseBody, 200);
  };
}
