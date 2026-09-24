import type { TrustedHostEntry } from "./hostAllowlist.js";
import type { TrustedProxyRange } from "./authThrottle.js";

/**
 * 「这个部署会被本机之外的人访问」的**信号判定**（本批加固：回环绑定不再等于可以关掉令牌）。
 *
 * ## 为什么需要它（真实的绕过路径）
 *
 * 既有的四道闸各自都成立，但它们**合起来仍留了一条完整的绕过路径**：
 *
 * 1. 非回环绑定 ⇒ 强制令牌（fail-closed）—— 这条**只认监听地址**；
 * 2. 于是「绑回环」被当成「只有本机能访问」，令牌允许关闭（为"本机开箱即用"的有意取舍）；
 * 3. 但运维完全可以把**回环端口**放到同机反代 / 隧道 / 容器端口映射之后：请求的对端地址
 *    就是回环 ⇒ 令牌那道闸**按设计不生效**；
 * 4. Host 白名单挡不住它：攻击者自己写 \`Host: 127.0.0.1\` 就在白名单里（回环恒放行）；
 * 5. 来源校验对**不带 \`Origin\`** 的客户端放行（那是为 CLI/桌面客户端留的有意取舍）——
 *    而 \`curl\` 恰好不带 \`Origin\`。
 *
 * ⇒ 净结果：**一个 curl 就等于无需令牌的完全控制权**（可执行命令、读写工作区）。
 *
 * ## 判据（一句话）
 *
 * **回环绑定只在「运维没有给出任何"我在用代理 / 这东西会被外部访问"的信号」时才允许关掉令牌。**
 * 一旦给出信号，"回环可达 = 只有本机能到"这个前提就不成立了 ⇒ 令牌必须开着。
 *
 * ## 两类信号：**拒绝类（A）** 与 **仅告警类（B）**
 *
 * 两个变量的语义足够硬，可以直接据此**拒绝启动**：
 *
 * | 信号 | 为什么算信号 | 档 |
 * | --- | --- | --- |
 * | \`ZCODE_SERVER_TRUSTED_PROXIES\` **解析后有生效项** | 它存在的唯一用途就是"我前面有反代/隧道，请采信 \`X-Forwarded-For\`"。配了它却说"只有本机在用"是自相矛盾 | **A（拒绝）** |
 * | \`ZCODE_SERVER_TRUSTED_HOSTS\` **解析后有生效项** | 它存在的唯一用途是登记**默认集合之外**的主机名（默认 = 回环 + 本机网卡 + 实际监听地址）。登记了域名 = 承认有外部域名指向本服务 | **A（拒绝）** |
 * | \`ZCODE_SERVER_TRUSTED_ORIGINS\` **解析后有生效项** | 它说明"面板的前端来自**另一个来源**" ⇒ 存在代理/隧道。但**只登记它**也可能是既有的跨源部署在配错，**拒绝启动会打死一种此前能起来的形态** | **B（仅告警）** |
 *
 * **"解析后有生效项"是刻意的**（不是"设置了变量"）：与 \`parseTrustedProxies\` /
 * \`parseTrustedHosts\` / \`parseTrustedOrigins\` 的既有口径一致 —— 一个写错的值会被静默丢弃，
 * 此时运维并没有真的给出可用信号，不该因此拒绝启动（那会把"打错字"变成"服务起不来"）。
 *
 * ## (B) 到底在什么条件下触发（**如实说明，不是永不触发的分支**）
 *
 * 先看 (A) 的覆盖面：(A) 在「A 类信号非空 + 无可用令牌」时拒绝启动，且**不分回环/非回环**
 * （非回环那一档本来就被既有的 fail-closed 分支拒绝）。于是 (B) **不可能**在下面两种形态触发：
 * - A 类信号（可信代理 / 登记域名）+ 无可用令牌 ⇒ 服务起不来，跑不到告警；
 * - 非回环 + 无可用令牌 ⇒ 同上。
 *
 * ⇒ **剩下的、唯一可达的形态是**：**回环绑定 + 只有 \`ZCODE_SERVER_TRUSTED_ORIGINS\` 这一条
 * 生效信号 + 没有任何可用令牌**（完全没配令牌来源，或配了令牌文件却解析出 0 条）。
 * 典型场景：反代/隧道把 \`Host\` 改写成回环（例如隧道设了 \`httpHostHeader: 127.0.0.1\`），
 * 于是运维只登记了跨源白名单、没登记域名 —— 那个被放行的来源（以及任何 \`curl\`）
 * 就拿到了**没有任何鉴权的完全控制权**。这正是告警要说的后果。
 *
 * 这条可达性由 \`exposureGateHttp.test.ts\` 的「矩阵」用例逐格钉住：**只要 (A) 会拒绝，
 * (B) 就必须返回 null；同时必须存在 (B) 会触发的格子**（否则就是死分支）。
 */

/** 触发的信号（用于日志与错误文案；顺序即展示顺序）。 */
export type ExposureSignalKind = "trusted-proxies" | "trusted-hosts" | "trusted-origins";

export interface ExposureSignal {
  kind: ExposureSignalKind;
  /** 人话描述（进错误文案与启动日志）。 */
  label: string;
  /** 触发该信号的生效项（**只写主机名/网段/来源，不含凭据**）。 */
  entries: string[];
}

/** 把生效的白名单条目渲染成日志/文案里的短串（\`host\` 或 \`host:port\`）。 */
function formatHostEntry(entry: TrustedHostEntry): string {
  return entry.port === undefined ? entry.host : entry.host + ":" + String(entry.port);
}

/** 把生效的可信代理渲染成短串（单 IP 写地址；CIDR 写 \`network/prefix\`）。 */
function formatProxyRange(range: TrustedProxyRange): string {
  if (range.family === 4) {
    const value = Number(range.network);
    const address = Number.isNaN(value)
      ? range.network
      : [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join(".");
    return range.prefix >= 32 ? address : address + "/" + String(range.prefix);
  }
  return range.prefix >= 128 ? range.network : range.network + "/" + String(range.prefix);
}

/**
 * 判定这次部署有没有给出「会被外部访问」的明确信号。
 *
 * 纯函数：只读**已经解析过**的生效项，不读环境变量、不看监听地址（监听地址由调用方另行判定）。
 */
export function collectExposureSignals(params: {
  /** 生效的可信代理（\`parseTrustedProxies\` 的结果；空数组 = 没配或全部非法）。 */
  trustedProxies?: readonly TrustedProxyRange[];
  /** **运维显式登记**的 Host 白名单条目（\`options.trustedHosts\`，不含回环/网卡/监听地址）。 */
  configuredTrustedHosts?: readonly TrustedHostEntry[];
  /** 生效的跨源白名单（\`parseTrustedOrigins\` 的结果）。 */
  trustedOrigins?: readonly string[];
}): ExposureSignal[] {
  const signals: ExposureSignal[] = [];
  const proxies = params.trustedProxies ?? [];
  if (proxies.length > 0) {
    signals.push({
      kind: "trusted-proxies",
      label: "配置了 ZCODE_SERVER_TRUSTED_PROXIES（声明自己在反向代理/隧道之后）",
      entries: proxies.map(formatProxyRange),
    });
  }
  const hosts = params.configuredTrustedHosts ?? [];
  if (hosts.length > 0) {
    signals.push({
      kind: "trusted-hosts",
      label: "在 ZCODE_SERVER_TRUSTED_HOSTS 里登记了默认集合之外的主机名",
      entries: hosts.map(formatHostEntry),
    });
  }
  const origins = params.trustedOrigins ?? [];
  if (origins.length > 0) {
    signals.push({
      kind: "trusted-origins",
      label: "在 ZCODE_SERVER_TRUSTED_ORIGINS 里登记了跨源来源（前端来自另一个来源 ⇒ 有代理/隧道）",
      entries: [...origins],
    });
  }
  return signals;
}

/**
 * 可用于**拒绝启动**的信号（A 类）：可信代理与登记域名。
 *
 * 跨源白名单被**刻意排除**在拒绝之外：它同样说明"有代理"，但**只登记它**是此前能起来的
 * 一种部署形态，把"配错"直接升级成"起不来"会打死合法路径 —— 因此它走 (B) 告警。
 */
export function refusalSignals(signals: readonly ExposureSignal[]): ExposureSignal[] {
  return signals.filter((signal) => signal.kind !== "trusted-origins");
}

/**
 * 触发时**拒绝启动**的可操作错误文案（照 \`assertListenSecurity\` 既有的文案风格：
 * 先说为什么，再给两条修法）。
 */
export function buildLoopbackExposureRefusal(params: {
  host: string;
  signals: readonly ExposureSignal[];
}): string {
  return [
    '拒绝启动：绑定回环地址 "' +
      params.host +
      '"，但配置里给出了"这东西会被本机之外访问"的信号，且没有可用的令牌。',
    "",
    "触发的信号：",
    ...params.signals.map(
      (signal) => "  · " + signal.label + "（生效项：" + signal.entries.join(", ") + "）",
    ),
    "",
    "原因：回环绑定本身只说明「监听在哪」，不说明「谁能到达」。",
    "  把回环端口放到同机反向代理、隧道或容器端口映射之后时，请求的对端地址就是回环，",
    "  于是「回环不要求令牌」这条判断会让鉴权关卡整条不生效：",
    "  - Host 白名单挡不住它（攻击者自己写 Host: 127.0.0.1 就在白名单里）；",
    "  - 来源校验对不带 Origin 的客户端放行（那是为 CLI/桌面客户端留的取舍），而 curl 恰好不带 Origin。",
    "  ⇒ 结果是**一个 curl 就等于无需令牌的完全控制权**（执行命令、读写工作区）。",
    "",
    "两种做法：",
    "  1. 配一个令牌（推荐）：ZCODE_SERVER_AUTH_TOKEN=$(openssl rand -hex 32)，",
    "     或把每行一条令牌的文件路径写进 ZCODE_SERVER_AUTH_TOKENS_FILE；",
    " 2. 或去掉上面那些登记项：如果你确实只在本机用（不经反代/隧道），",
    "     就不要配 ZCODE_SERVER_TRUSTED_PROXIES，也不要在 ZCODE_SERVER_TRUSTED_HOSTS 里登记域名。",
  ].join("\n");
}

/**
 * 「有外部访问信号、却没有任何可用令牌」的启动告警（B，**不改行为**）。
 *
 * **可达条件**（与模块头注释同一份口径，由测试的矩阵用例逐格钉住）：
 * - A 类信号（可信代理 / 登记域名）非空时，\`assertListenSecurity\` 已经拒绝启动 ⇒ 这里返回 null；
 * - 非回环绑定下，无可用令牌同样被既有的 fail-closed 分支拒绝 ⇒ 这里返回 null；
 * - ⇒ **唯一可达的形态**：回环绑定 + **只有** \`ZCODE_SERVER_TRUSTED_ORIGINS\` 这一条信号
 *   + 没有任何可用令牌。那时服务能起来，而那个被放行的来源（以及任何不带 Origin 的 \`curl\`）
 *   拿到的是**没有鉴权的完全控制权** —— 这正是必须被说出来的后果。
 *
 * 返回 \`null\` 表示这个组合没有额外风险，不告警（正常路径不得产生噪音）。
 */
export function buildProxySignalWithoutTokenWarning(params: {
  host: string;
  signals: readonly ExposureSignal[];
  /** 令牌集合是否真的可用。false = 没配令牌来源，或配了却解析出 0 条。 */
  tokenSourceEnabled: boolean;
  /**
   * 监听地址是否回环。由调用方传入（与 \`assertListenSecurity\` 同一判定函数），
   * 这样"哪一档已经被拒绝"的推理留在本模块里、可被测试逐格验证。
   */
  loopback: boolean;
}): string | null {
  if (params.tokenSourceEnabled) return null;
  if (!params.loopback) return null;
  // A 类信号 + 无令牌 ⇒ 已由 assertListenSecurity 拒绝启动（跑不到这里）；返回 null 让
  // "拒绝"与"告警"互斥，避免出现"既拒绝又告警"或"都不做"的第三种状态。
  if (refusalSignals(params.signals).length > 0) return null;
  if (params.signals.length === 0) return null;
  return [
    '暴露面提醒：这个部署给出了"会被本机之外访问"的信号，但当前**没有任何可用的令牌**。',
    ...params.signals.map(
      (signal) => "  · " + signal.label + "（生效项：" + signal.entries.join(", ") + "）",
    ),
    "  · 当前：bind=" + params.host + " token-auth=disabled。",
    "  · 后果：任何能到达该域名/端口的人（包括任何不带 Origin 的 curl）都能**完全控制本机工作台**",
    "    （执行命令、读写工作区）—— 你登记的那个来源等于拿到了没有鉴权的完整控制权。",
    "  · 注意：服务端在**非回环**绑定下会直接拒绝这种配置；回环绑定下能起来，是因为「回环不要求令牌」",
    "    这条判断先命中 —— 但你登记了跨源来源，说明回环已经不再是「只有本机能到」。",
    "  · 修法：配一个令牌（ZCODE_SERVER_AUTH_TOKEN，或 ZCODE_SERVER_AUTH_TOKENS_FILE 指向的令牌文件），",
    "    或删掉 ZCODE_SERVER_TRUSTED_ORIGINS（同一 origin 部署本来就不需要它）。",
  ].join("\n");
}
