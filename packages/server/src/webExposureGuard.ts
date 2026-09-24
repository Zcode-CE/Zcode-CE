import type { MiddlewareHandler } from "hono";

/**
 * 跨站请求防护（CSRF）与安全响应头。
 *
 * 背景（威胁模型，依据 `.reverse/43-web-security/SURVEY.md` 的 G1/G2/G5）：
 * - 本服务的凭据是 cookie（`zcode_lite_token`），而 cookie 会被浏览器**自动附带**；
 * - WebSocket 握手**不受同源策略约束**：RFC 6455 §10.2 指出，当 WebSocket 由浏览器里的
 *   网页使用时，浏览器用 origin 模型限制哪些页面能连；而该协议**唯一**的服务端防护手段就是
 *   §4.1 说的「校验 `Origin` 头，不接受就回一个 HTTP 错误码」；
 * - HTTP 侧的写操作（如 `POST /api/rpc-host-capability`）同样可被跨站表单触发。
 *
 * 因此：**不做来源校验时，一个已授权的浏览器会话 + 任意一个恶意页面 = 完全接管工作区**。
 *
 * 语义与取舍（与 docs/development/web-remote-control.md「跨站请求防护与安全响应头」同口径）：
 * 1. **只校验来源，不校验用户**：用户身份仍由网关的令牌中间件负责；本模块是并列的第二道闸。
 * 2. **保护面**：全部 `/ws*` 升级请求 + 写方法的 HTTP 请求（非 GET/HEAD/OPTIONS）。
 *    读方法的 GET 不做拦截（跨站读会被浏览器同源策略挡住，且我们不发 CORS 头）。
 * 3. **同源定义**：`Origin` 去掉默认端口后的串 == 请求 `Host` 去掉默认端口后的串
 *    （附协议/主机/端口三元组一致性检查）。不比 IP，因此 127.0.0.1 与 localhost 视为**不同源**
 *    —— 这是标准口径，宁可让运维显式登记，也不放宽判定。
 * 4. **缺 `Origin` 时放行**（**这是有意的取舍，不是遗漏**）：非浏览器客户端（CLI、桌面、
 *    `ws` 库、本仓库的鉴权覆盖测试）不发该头，而浏览器对**任何跨站请求都会发**，
 *    所以「无 Origin 即放行」不放宽浏览器的跨站面，却避免打断既有非浏览器链路。
 *    代价写清：该策略无法防御一个「不发 Origin 的非浏览器恶意客户端」——但那种客户端
 *    本来就不受浏览器规则约束（它可以随意伪造 Origin），所以来源校验对它毫无意义，
 *    真正拦住它的是令牌那一层。
 * 5. **跨源合法部署**由 `trustedOrigins`（环境变量 `ZCODE_SERVER_TRUSTED_ORIGINS`，
 *    逗号分隔）放行：反代在不同域名、端口映射不同时才需要显式声明。此项与前四项不同，
 *    是**新增**的配置机制。
 * 6. **拒绝语义**：统一 403 且带可操作原因（不泄漏内部地址）。
 */

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** 在 HTTP 层拒绝升级时用的状态行文案（避免为一个 3 项映射引入 node:http 依赖）。 */
const STATUS_CODES_BY_CODE: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
};

/** 默认端口：用于把 `https://a` 与 `https://a:443` 视为同一来源（标准端口等价）。 */
const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443" };

/** 把 `host[:port]` 归一成 `host:port`（缺端口时按协议补默认端口）。 */
function normalizeEndpoint(value: string, protocol: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  // 拒绝把路径/查询塞进 host 的畸形值，避免 "``a/b``" 这类输入被当作同源。
  if (trimmed.includes("/") || trimmed.includes("?") || trimmed.includes("#")) {
    return null;
  }
  const bracket = trimmed.startsWith("[") ? trimmed.indexOf("]") : -1;
  const hostPart = bracket >= 0 ? trimmed.slice(1, bracket) : (trimmed.split(":")[0] ?? "");
  if (!hostPart) {
    return null;
  }
  const portPart = bracket >= 0 ? trimmed.slice(bracket + 1) : trimmed.slice(hostPart.length);
  if (portPart && !portPart.startsWith(":")) {
    return null;
  }
  const port = portPart ? portPart.slice(1) : (DEFAULT_PORTS[protocol] ?? "");
  if (portPart && !/^\d+$/.test(port)) {
    return null;
  }
  const hostname = hostPart.toLowerCase();
  // 把默认端口归一掉：`https://a` 与 `https://a:443` 是同一个来源，白名单登记两种写法
  // 也必须都能命中（否则运维登记 `https://a:443` 时同源请求反而被拒）。
  return port === DEFAULT_PORTS[protocol] ? hostname : hostname + ":" + port;
}

/** 由协议 + 归一化后的 endpoint 生成来源串（缺省端口不写出来）。 */
function toOrigin(protocol: string, endpoint: string): string {
  const defaultPort = DEFAULT_PORTS[protocol] ?? "";
  return (
    protocol +
    "//" +
    (endpoint.endsWith(":" + defaultPort) ? endpoint.slice(0, -(defaultPort.length + 1)) : endpoint)
  );
}

/** 解析一条来源配置（`https://host[:port]`），非法值返回 null。 */
export function parseTrustedOrigins(raw: string | undefined): string[] {
  if (!raw?.trim()) {
    return [];
  }
  const parsed: string[] = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const url = new URL(trimmed);
      const endpoint = normalizeEndpoint(url.host, url.protocol);
      if (endpoint) {
        parsed.push(toOrigin(url.protocol, endpoint));
      }
    } catch {
      // 非法项忽略：一个写错的域名不应让整个服务起不来（启动期会告警）。
    }
  }
  return parsed;
}

/**
 * 求请求的「自我来源」：浏览器在同源时给出的 Origin 就是它。
 *
 * `Host` 头是唯一第一手信息（`c.req.url` 在 Hono/Node 下由它派生）。
 */
function resolveSelfOrigin(
  hostHeader: string | undefined,
  protocol: string | undefined,
  requestUrl: string,
): string | null {
  if (!hostHeader) {
    return null;
  }
  let effectiveProtocol = protocol === "https:" ? "https:" : "http:";
  if (!protocol && requestUrl) {
    try {
      effectiveProtocol = new URL(requestUrl).protocol === "https:" ? "https:" : "http:";
    } catch {
      // 调用方给了畸形 URL：按 http 处理（不影响来源判定的严格性，只是默认端口口径）。
    }
  }
  const endpoint = normalizeEndpoint(hostHeader, effectiveProtocol);
  return endpoint ? toOrigin(effectiveProtocol, endpoint) : null;
}

export interface CrossSiteDecision {
  allowed: boolean;
  /** 拒绝原因（写入 403 响应体，不含内部地址）。 */
  reason?: string;
}

/**
 * 保护面判定：`/ws` 与 `/ws/**`（WebSocket 升级）恒在保护面内；HTTP 只在写方法时保护。
 * 静态资产、SPA 壳与 GET 读接口**不在**保护面内（跨站读会被浏览器同源策略挡住，我们也不发 CORS 头）。
 */
export function shouldGuardRequest(method: string, pathname: string): boolean {
  if (pathname === "/ws" || pathname.startsWith("/ws/")) {
    return true;
  }
  return STATE_CHANGING_METHODS.has(method.toUpperCase());
}

/**
 * 判定一次请求是否允许通过。导出为纯函数，便于逐档钉测试与反向验证。
 */
export function evaluateRequestOrigin(
  params: {
    method: string;
    pathname: string;
    originHeader?: string;
    hostHeader?: string;
    /** 请求协议（http:/https:），用于把自身 host 与 Origin 归一化到同一口径。 */
    protocol?: string;
    /** 完整请求 URL；仅在缺 protocol 时用于推断协议。 */
    requestUrl?: string;
  },
  trustedOrigins: readonly string[] = [],
): CrossSiteDecision {
  const origin = params.originHeader?.trim();
  if (!origin) {
    // 见文件头第 4 条：非浏览器客户端不发 Origin，放行是有意的取舍。
    return { allowed: true };
  }
  // 浏览器在跨站时会把 Origin 设成字面量 "null"（sandbox iframe、data:、部分重定向场景）。
  // 它不是任何合法来源，直接拒绝。
  if (origin === "null") {
    return { allowed: false, reason: "Origin 为 null（跨源隔离上下文），拒绝" };
  }

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return { allowed: false, reason: "Origin 头无法解析" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { allowed: false, reason: "Origin 协议不是 http(s)" };
  }
  const originEndpoint = normalizeEndpoint(parsed.host, parsed.protocol);
  if (!originEndpoint) {
    return { allowed: false, reason: "Origin 主机无效" };
  }
  const exactOrigin = toOrigin(parsed.protocol, originEndpoint);

  const selfOrigin = resolveSelfOrigin(params.hostHeader, params.protocol, params.requestUrl ?? "");
  if (selfOrigin && exactOrigin === selfOrigin) {
    return { allowed: true };
  }
  if (trustedOrigins.includes(exactOrigin)) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason:
      "跨站请求被拒绝：本服务只接受同源请求" +
      (trustedOrigins.length > 0 ? "或 ZCODE_SERVER_TRUSTED_ORIGINS 中登记的来源" : "") +
      "。若你把面板放在反向代理后、前端与后端的域名/端口不同，请把前端的来源登记进 ZCODE_SERVER_TRUSTED_ORIGINS（逗号分隔）。",
  };
}

/**
 * 判定一次 **WebSocket 升级请求**是否允许。与 HTTP 的判定共用同一份口径
 * （`evaluateRequestOrigin`），差别只在调用点与响应通道（见 `rejectUpgrade`）。
 */
export function evaluateUpgradeOrigin(
  params: {
    pathname: string;
    originHeader?: string;
    hostHeader?: string;
    protocol?: string;
    requestUrl?: string;
  },
  trustedOrigins: readonly string[] = [],
): CrossSiteDecision {
  if (!shouldGuardRequest("GET", params.pathname)) {
    return { allowed: true };
  }
  return evaluateRequestOrigin({ method: "GET", ...params }, trustedOrigins);
}

/**
 * 在 **HTTP 层**拒绝一次 WebSocket 升级。
 *
 * 为什么不能只在 Hono 中间件里 `return c.json(..., 403)`：`@hono/node-ws` 的升级适配器
 * 拿到响应后**只取 statusCode，自己拼一条 `Content-Length: 0` 的响应**，我们的 JSON 原因
 * 与安全响应头**都会丢掉**（实测见 webOriginGuard.test.ts 的「跨站 WS 拒绝」两档断言）。
 * 这里直接写 socket，才能保证被拒的客户端拿到可操作原因与安全头。
 *
 * 返回 true 表示已拒绝（调用方必须**不要**再 `wss.handleUpgrade`）。
 */
export function rejectUpgrade(params: {
  socket: { write(data: string): unknown; destroy?(): unknown; end(data?: string): unknown };
  statusCode?: number;
  reason: string;
  extraHeaders?: Record<string, string>;
}): true {
  const status = params.statusCode ?? 403;
  const body = JSON.stringify({ error: params.reason });
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(body, "utf8")),
    Connection: "close",
    ...(params.extraHeaders ?? {}),
  };
  const head =
    "HTTP/1.1 " +
    status +
    " " +
    (STATUS_CODES_BY_CODE[status] ?? "Forbidden") +
    "\r\n" +
    Object.entries(headers)
      .map(([name, value]) => name + ": " + value)
      .join("\r\n") +
    "\r\n\r\n";
  try {
    params.socket.write(head + body);
    params.socket.end();
  } catch {
    // 对端已断开时写失败不算异常路径；销毁 socket 收尾即可，不要让它变成未捕获错误。
    params.socket.destroy?.();
  }
  return true;
}

export interface CrossSiteGuardOptions {
  trustedOrigins: readonly string[];
  warn?: (message: string) => void;
  /**
   * 拒绝响应要带上的额外响应头（由调用方传入安全头构造器，见 http.ts）。
   *
   * 为什么要显式传：**WS 升级被拒的那条 403 不会经过任何后续中间件**，
   * 实测（见 webOriginGuard.test.ts 的「跨站 WS 拒绝」断言）「在 handler 返回之后统一写头」
   * 的中间件对这条响应无效 —— 于是它的响应里一个安全头都没有。宁可多传一个函数，
   * 也不要让最关键的拒绝路径裸奔。
   */
  denialHeaders?: () => Record<string, string>;
  /**
   * 拒绝回调（审计埋点，B1）。**只传判定所需的字段**，不透传请求对象 —— 这样审计实现无法
   * "顺手"把 `Origin` / 查询串 / cookie 抄进日志。
   *
   * 本模块**不持有可信代理配置**，所以给出的只是原始信息（socket 对端 + 原始 XFF 头），
   * 由调用方（http.ts）用**它自己的口径**解析出真正的客户端地址，避免审计日志与限流
   * 用两套地址口径（那会让"谁被限流了"和"谁出现在审计里"对不上）。
   */
  onReject?: (params: {
    socketPeer?: string;
    forwardedFor?: string;
    method: string;
    path: string;
    reason: string;
  }) => void;
}

/**
 * 中间件：所有路径生效，只对 WebSocket 升级与写方法请求做来源判定。
 *
 * 必须注册在令牌中间件**之前**，且不依赖 cookie —— 这样「未授权且跨站」的请求会走到
 * 来源拒绝（403），而不是先被令牌层拦成 401。
 */
export function createCrossSiteGuard(options: CrossSiteGuardOptions): MiddlewareHandler {
  const once = new Set<string>();
  return async (c, next) => {
    const decision = evaluateRequestOrigin(
      {
        method: c.req.method,
        pathname: new URL(c.req.url).pathname,
        originHeader: c.req.header("origin"),
        hostHeader: c.req.header("host"),
        protocol: new URL(c.req.url).protocol,
        requestUrl: c.req.url,
      },
      options.trustedOrigins,
    );
    // WebSocket 升级由 HTTP 层的 gate 处理（见 evaluateUpgradeOrigin / rejectUpgrade）：
    // 在 fetch 层返回的 403 会被 @hono/node-ws 丢掉响应体与响应头，所以不在这一层做。
    if (c.req.header("upgrade")?.toLowerCase() === "websocket") {
      await next();
      return;
    }
    if (decision.allowed) {
      await next();
      return;
    }
    const requestPath = new URL(c.req.url).pathname;
    // 审计埋点：**先记事件、再做"只告警一次"的降噪** —— 审计与告警是两条流，
    // 告警（warn）要防刷屏，审计要能计数（由 auditLog 的合并策略负责，不在这里丢）。
    options.onReject?.({
      socketPeer: (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
        ?.incoming?.socket?.remoteAddress,
      forwardedFor: c.req.header("x-forwarded-for"),
      method: c.req.method,
      path: requestPath,
      reason: decision.reason ?? "Cross-site request rejected",
    });
    // 每个「路径 + 方法」只告警一次：跨站探测会持续打，不能让日志被淹掉（可观测但不噪音）。
    const key = c.req.method + " " + requestPath;
    if (!once.has(key)) {
      once.add(key);
      options.warn?.(
        "[cross-site] 已拒绝跨站 " +
          c.req.method +
          " " +
          requestPath +
          "（Origin=" +
          (c.req.header("origin") ?? "") +
          "，对端=" +
          (c.req.header("x-forwarded-for") ?? "socket") +
          "）",
      );
    }
    return c.json(
      { error: decision.reason ?? "Cross-site request rejected" },
      403,
      options.denialHeaders?.() as Record<string, string> | undefined,
    );
  };
}

export interface SecurityHeadersOptions {
  /** 是否随 https 请求下发 HSTS。默认 false（见 docs：HSTS 一旦下发就无法回退）。 */
  hsts?: boolean;
  hstsMaxAgeSeconds?: number;
  /**
   * CSP 模式：
   * - "report-only"（默认）：只上报不拦截，给运维观察期（我们尚未盘点构建产物里的内联脚本）；
   * - "enforce"：真正拦截；
   * - "off"：完全不发。
   * 注意：`frame-ancestors 'none'` 与 `X-Frame-Options: DENY` 是**无条件**下发的（点击劫持
   * 这一条与 CSP 的其余部分无关，面板能执行命令，不能用观察期换风险）。
   */
  cspMode?: "report-only" | "enforce" | "off";
  secure: boolean;
}

export function buildSecurityHeaders(options: SecurityHeadersOptions): Record<string, string> {
  const headers: Record<string, string> = {
    // 同源内容嗅探会让「工作区里产出的文件」有机会被当作脚本执行，而同源脚本能直接继承
    // 令牌 cookie（HttpOnly 拦不住同源脚本发请求）。
    "X-Content-Type-Options": "nosniff",
    // 首次落地页可能带 ?token=，不要把它经 Referer 泄给第三方。
    "Referrer-Policy": "no-referrer",
    // 双保险：老浏览器认 X-Frame-Options，新浏览器认 frame-ancestors。
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  };
  const cspMode = options.cspMode ?? "report-only";
  if (cspMode !== "off") {
    const policy = "frame-ancestors 'none'";
    headers[
      cspMode === "enforce" ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only"
    ] = policy;
  }
  if (options.hsts && options.secure) {
    headers["Strict-Transport-Security"] =
      "max-age=" + (options.hstsMaxAgeSeconds ?? 31_536_000) + "; includeSubDomains";
  }
  return headers;
}

/** 中间件：给所有响应加安全响应头。 */
export function createSecurityHeaders(options: SecurityHeadersOptions): MiddlewareHandler {
  return async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(buildSecurityHeaders(options))) {
      c.header(name, value);
    }
  };
}
