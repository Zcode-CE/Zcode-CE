import { createLocalServices, getAppConfigDir } from "@zcode/services/node";
import { IBotsService, type ServiceCollection } from "@zcode/services";
import {
  materializeBundledZCodeBuiltinProviderConfig,
  readBundledZCodeBuiltinProviderConfig,
} from "./bundledZCodeBuiltinProviderConfig.js";
import { DEFAULT_HTTP_LISTEN_HOST, assertListenSecurity, createHttpServer } from "./http.js";
import { createAuthTokenStore, loadAuthTokensFromFile, type AuthTokenRecord } from "./authToken.js";
import { parseTrustedProxies } from "./authThrottle.js";
import { parseTrustedHosts } from "./hostAllowlist.js";
import { createAuditLog } from "./auditLog.js";

/** `ZCODE_SERVER_HSTS`：只认显式的真值，缺省与拼错都当 false（安全默认值）。 */
function isTruthyEnv(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

/**
 * 启动期判定：是否存在 enabled 的 webhook bot（决定 `/bot/**` 入站面是否挂载）。
 *
 * 只做快速短路，不承担安全边界：真正的边界在 gate 内逐请求判定。
 * 失败时返回 `false`（fail-closed：读不到配置 ⇒ 不挂载入站面，而不是「读不到就当有」）。
 */
async function resolveBotIngressEnabled(services: ServiceCollection): Promise<boolean> {
  const botsService = services.getOptional(IBotsService);
  if (!botsService) {
    return false;
  }
  try {
    const bots = await botsService.listBots();
    return bots.some((bot) => bot.provider === "webhook" && bot.enabled);
  } catch (error) {
    // fail-closed：配置读不出来就不开放入站面。如实告警，不静默。
    console.warn(
      "[zcode-server:http] 读取 bot 配置失败，/bot 入站回调面**不挂载**（fail-closed）：" +
        (error instanceof Error ? error.message : String(error)),
    );
    return false;
  }
}

/** `ZCODE_SERVER_CSP`：unset = report-only（观察期）；off / enforce 显式覆盖。 */
function resolveCspMode(value: string | undefined): "report-only" | "enforce" | "off" | undefined {
  switch (value?.trim().toLowerCase()) {
    case "off":
      return "off";
    case "enforce":
      return "enforce";
    case undefined:
    case "":
    case "report-only":
    case "report_only":
      return undefined;
    default:
      // 未知值不静默降级成 enforce：回落到默认的 report-only，并在启动日志里说明。
      console.warn(
        '[zcode-server:http] 未知的 ZCODE_SERVER_CSP 值 "' +
          value +
          '"（只认 off/enforce/report-only），已回落到默认 report-only。',
      );
      return undefined;
  }
}

async function main(): Promise<void> {
  const port = Number(process.env["PORT"]) || 3030;
  // 这里只表达「用户是否显式指定了监听地址」：未指定时**不传 host**，
  // 由 createHttpServer 落到默认回环地址，并执行「非回环 + 无 token ⇒ 拒绝启动」
  // 的 fail-closed 检查（判定与默认值的唯一所有者在 http.ts）。
  const host = process.env["ZCODE_SERVER_HOST"]?.trim() || process.env["HOST"]?.trim() || undefined;
  const staticRoot = process.env["ZCODE_WEB_STATIC_ROOT"]?.trim() || undefined;
  const authToken = process.env["ZCODE_SERVER_AUTH_TOKEN"]?.trim() || undefined;
  // 跨源合法部署的白名单（反代把前端放在另一个域名/端口时）。缺省为空 = 只接受同源请求。
  // 解析与判定口径的唯一所有者在 http.ts/webExposureGuard.ts；这里只做「读环境变量」。
  const trustedOrigins = (process.env["ZCODE_SERVER_TRUSTED_ORIGINS"] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  // CSP 模式与 HSTS 都默认关闭/观察期：CSP 需要先观察构建产物里的内联脚本，HSTS 一旦下发
  // 就无法回退（用户会被浏览器强制跳 https）。两者都要用户显式开启。
  const cspMode = resolveCspMode(process.env["ZCODE_SERVER_CSP"]);
  const hsts = isTruthyEnv(process.env["ZCODE_SERVER_HSTS"]);
  // 可信代理：**默认空 = 不采信 X-Forwarded-For**（见 authThrottle.ts 的模块注释）。
  // 这是为了让 A3 的按地址限流无法被伪造头绕过；反代后要拿真实客户端地址才需要显式配置。
  const trustedProxies = parseTrustedProxies(process.env["ZCODE_SERVER_TRUSTED_PROXIES"]);
  // Host 白名单（G6）：**默认 = 回环 + 本机网卡 + 实际监听地址**，这里只追加运维显式登记的域名。
  // 与 TRUSTED_ORIGINS 是两道不同防线（Host 挡 DNS rebinding、Origin 挡跨站），不要互相替代；
  // 非法项丢弃（一个写错的域名不该让服务起不来），生效项由 http.ts 在监听后打印。
  const trustedHosts = parseTrustedHosts(process.env["ZCODE_SERVER_TRUSTED_HOSTS"]);
  // 令牌文件（A4）：多条令牌 + SIGHUP 重载，让「撤销一台设备」不必重启、也不影响其他设备。
  // 读取失败**直接抛错**（fail-closed）：配了一个读不了 / 为空的令牌文件，绝不能静默退化成无鉴权。
  const authTokensFilePath = process.env["ZCODE_SERVER_AUTH_TOKENS_FILE"]?.trim() || undefined;
  const authFileRecords: AuthTokenRecord[] = authTokensFilePath
    ? loadAuthTokensFromFile(authTokensFilePath)
    : [];
  const explicitTokenRecords: AuthTokenRecord[] = authToken
    ? [{ token: authToken, label: "<env>" }]
    : [];
  const tokenSource =
    explicitTokenRecords.length > 0 || authFileRecords.length > 0
      ? createAuthTokenStore({
          records: explicitTokenRecords,
          fileRecords: authFileRecords,
          ...(authTokensFilePath ? { filePath: authTokensFilePath } : {}),
          log: (...args: unknown[]) => console.log(...args),
          warn: (...args: unknown[]) => console.warn(...args),
        })
      : undefined;
  const authEnabled = Boolean(tokenSource?.enabled);

  // 先做监听安全前置检查，再初始化任何服务：被拒绝时不应该先拉起 provider runtime /
  // CUA 等一堆子系统再报错（那些日志会淹没真正的拒绝原因），也不应产生副作用。
  // 同一判定在 createHttpServer 内再执行一次，保证任何调用方都绕不过。
  // 「配了令牌文件却没解析出令牌」在这里就拒绝启动（authSourceConfigured + 未 enabled）。
  // 判定口径与 createHttpServer 内那次**完全一致**（同一函数、同一组参数），因此这里传
  // 「回环 + 外部访问信号」时也会在**拉起任何子系统之前**就拒绝 —— 那正是本函数放在最前面的理由。
  // 注意 trustedHosts 是**解析后**的生效项：非法项已被丢弃，一个写错的域名不会让服务起不来
  // （与 parseTrustedHosts 的既有取舍一致），但一个**生效**的登记项就是"会被外部访问"的信号。
  assertListenSecurity({
    host: host ?? DEFAULT_HTTP_LISTEN_HOST,
    ...(authToken ? { authToken } : {}),
    authSourceConfigured: Boolean(authTokensFilePath || authToken),
    authSourceEnabled: authEnabled,
    trustedProxies,
    configuredTrustedHosts: trustedHosts.map((entry) =>
      entry.port === undefined
        ? { host: entry.host, label: "configured" }
        : { host: entry.host, port: entry.port, label: "configured" },
    ),
    trustedOrigins,
  });

  const zcodeBuiltinProviderConfigFilePath = await materializeBundledZCodeBuiltinProviderConfig({
    environmentConfigRoot: getAppConfigDir(),
    content: readBundledZCodeBuiltinProviderConfig(),
  });
  const services = createLocalServices({
    zcodeBuiltinProviderConfigFilePath,
    providerProvisioningTargetEnabled: authEnabled,
  });

  // 审计日志（B1）由入口创建并注入：这样入口自己也能为「令牌重载」写审计事件 —— 重载发生在
  // http 服务之外，却是最需要留痕的动作之一（谁在什么时候撤销了哪把钥匙）。
  const audit = createAuditLog();
  // IM 机器人入站面（/bot/**）的启动期判定：是否存在 enabled 的 webhook bot。
  //
  // 为什么在入口判定而不是在 createHttpServer 里：createHttpServer 是同步函数，
  // 而 listBots() 是异步的；把它改成异步会波及全部调用点与既有测试。入口本来就是
  // 「读环境 → 判定 → 传 options」的位置，加一个布尔量与既有形态同构。
  //
  // 注意 enabled 只是快速短路，不承担安全边界 —— 真正的边界是 gate 内逐请求的
  // 「运行期判定 + 凭据校验 + 限流」（见 botIngress.ts 文件头）。因此这里的快照即使
  // 陈旧也不会放行任何请求；而「配了 bot 却需要重启才生效」是有意的取舍（新增方向
  // fail-safe，删除方向即时生效 = fail-closed），须在 UI 与文档里如实说明。
  const botIngressEnabled = await resolveBotIngressEnabled(services);
  const server = createHttpServer(services, port, {
    botIngress: { enabled: botIngressEnabled },
    ...(host ? { host } : {}),
    audit,
    ...(staticRoot ? { staticRoot, spaFallback: true } : {}),
    ...(authEnabled ? { authRequired: true } : {}),
    ...(tokenSource ? { tokenSource } : {}),
    ...(trustedOrigins.length > 0 ? { trustedOrigins } : {}),
    ...(trustedProxies.length > 0 ? { trustedProxies } : {}),
    ...(trustedHosts.length > 0 ? { trustedHosts } : {}),
    ...(cspMode ? { cspMode } : {}),
    ...(hsts ? { hsts } : {}),
  });

  // SIGHUP ⇒ 重载令牌文件（`kill -HUP <pid>`）。这是本进程对 SIGHUP 的全部语义：
  // http 入口（`zcode --web`）此前**没有** SIGHUP 处理器（那套在 entry-stdio.ts 的桌面 stdio
  // 链路里，互不影响），所以注册它不会覆盖既有行为；注册后 SIGHUP 不再走 Node 默认的终止进程。
  if (tokenSource && authTokensFilePath) {
    process.on("SIGHUP", () => {
      const result = tokenSource.reload();
      const snapshot = tokenSource.snapshot();
      if (result.ok) {
        // 审计：重载成功（只写条数与标签，**绝不写令牌**）。
        audit.record({
          kind: "audit:token-reload",
          peer: "local", // SIGHUP 是本机信号：发起方不是网络对端，写 "local" 比写对方 IP 诚实。
          reason: "SIGHUP 重载令牌文件",
          tokenCount: snapshot.count,
          tokenLabels: snapshot.labels,
        });
        return;
      }
      console.warn(
        "[zcode-server:http] SIGHUP 重载失败，继续使用上一份令牌集合：" +
          (result.error ?? "未知原因"),
      );
      // 失败也要留痕：一次「撤销没生效」必须能从审计里看出来。
      audit.record({
        kind: "audit:token-reload-failed",
        peer: "local",
        reason: "SIGHUP 重载失败，保持上一份令牌集合",
        tokenCount: snapshot.count,
        tokenLabels: snapshot.labels,
      });
    });
  }
  void server;
}

void main().catch((error: unknown) => {
  console.error("[zcode-server:http] startup failed", error);
  // 与 packages/zcode-server-cli/src/server-core/entry.ts 同理：启动失败往往发生在
  // 服务已部分初始化之后（provider runtime、CUA pip session 等仍持有事件循环句柄），
  // 只设 exitCode 会让进程挂着不退出 —— 使用者会以为服务在跑，而监听从未建立。
  process.exit(1);
});
