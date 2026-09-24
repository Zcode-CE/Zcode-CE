import { createLocalServices, getAppConfigDir } from "@zcode/services/node";
import {
  materializeBundledZCodeBuiltinProviderConfig,
  readBundledZCodeBuiltinProviderConfig,
} from "./bundledZCodeBuiltinProviderConfig.js";
import { DEFAULT_HTTP_LISTEN_HOST, assertListenSecurity, createHttpServer } from "./http.js";
import { createAuthTokenStore, loadAuthTokensFromFile, type AuthTokenRecord } from "./authToken.js";
import { parseTrustedProxies } from "./authThrottle.js";
import { parseTrustedHosts } from "./hostAllowlist.js";

/** `ZCODE_SERVER_HSTS`：只认显式的真值，缺省与拼错都当 false（安全默认值）。 */
function isTruthyEnv(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
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
  assertListenSecurity({
    host: host ?? DEFAULT_HTTP_LISTEN_HOST,
    ...(authToken ? { authToken } : {}),
    authSourceConfigured: Boolean(authTokensFilePath || authToken),
    authSourceEnabled: authEnabled,
  });

  const zcodeBuiltinProviderConfigFilePath = await materializeBundledZCodeBuiltinProviderConfig({
    environmentConfigRoot: getAppConfigDir(),
    content: readBundledZCodeBuiltinProviderConfig(),
  });
  const services = createLocalServices({
    zcodeBuiltinProviderConfigFilePath,
    providerProvisioningTargetEnabled: authEnabled,
  });

  const server = createHttpServer(services, port, {
    ...(host ? { host } : {}),
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
      if (!result.ok) {
        console.warn(
          "[zcode-server:http] SIGHUP 重载失败，继续使用上一份令牌集合：" +
            (result.error ?? "未知原因"),
        );
      }
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
