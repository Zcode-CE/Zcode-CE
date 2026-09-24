import { isIP } from "node:net";
import { networkInterfaces } from "node:os";

/**
 * Host 白名单（task-39 / SURVEY.md 的 G6）：**关掉 DNS rebinding 那条链**。
 *
 * ## 为什么来源校验挡不住它
 *
 * A-1 的来源校验（webExposureGuard.ts）判定的是「`Origin` 与 `Host` 是否同一来源」。
 * 在 DNS rebinding 攻击里，攻击者页面 `http://evil.com` 解析到受害者的 LAN 地址，
 * 于是浏览器发出的请求 `Origin: http://evil.com` 与 `Host: evil.com` **彼此一致** ⇒ 判定放行；
 * 而浏览器又认为这是自己的同源，**能直接读响应**。⇒ 只有 **Host 白名单**能关掉这条链。
 *
 * 判据（一句话）：**Host 是攻击者无法伪造的东西，也是唯一能把「浏览器认为它在跟 evil.com 说话」
 * 与「浏览器其实在跟本机服务说话」区分开的信号**。所以规则是：
 * **Host（含端口）必须落在白名单里，否则 403** —— 而且**回环访问也照样校验**，
 * 因为默认部署就是「绑回环 + 浏览器在本机打开」，那正是这条链的目标场景。
 *
 * ## 白名单来源（三者取并集）
 *
 * 1. **回环**：`127.0.0.0/8` 的任意形式、`::1`、`localhost`（含大小写与尾随点）；
 * 2. **本机网络接口地址**：`os.networkInterfaces()` 当前所有非内部地址（这样「绑局域网 IP
 *    然后用该 IP 访问」这条默认用法仍然可用 —— 局域网里用 IP 直接访问本来就不存在 rebinding 面，
 *    因为攻击者不能注册一个指向你的 IP 的域名后又让浏览器把它当成自己的同源）；
 * 3. **运维显式登记的域名**：`ZCODE_SERVER_TRUSTED_HOSTS`（逗号分隔）。
 *
 * **未配置域名时不得放行任意 Host** —— 这正是「默认安全」的落点：白名单只有回环 + 本机网卡，
 * 于是 `Host: evil.com` 在任何默认部署下都会被拒。反代带域名时必须显式登记（见 §配置面）。
 *
 * ## 与 ZCODE_SERVER_TRUSTED_ORIGINS 的关系（**两道不同防线，不要互相替代**）
 *
 * - `TRUSTED_HOSTS`（本模块）：校验 `Host` ⇒ 挡 **DNS rebinding**（"浏览器以为在跟 evil.com 说话"）；
 * - `TRUSTED_ORIGINS`（webExposureGuard.ts）：校验 `Origin` ⇒ 挡 **跨站请求**（"别的网站代浏览器发请求"）。
 *
 * 两者都必要且都不充分：只配 ORIGINS 挡不住 rebinding（Origin 与 Host 自洽）；只配 HOSTS 挡不住
 * 跨站（攻击者不需要伪造 Host 就能让受害者浏览器替他发请求）。**反代换域名时通常两个都要配。**
 *
 * ## 配置面
 *
 * - `ZCODE_SERVER_TRUSTED_HOSTS`：逗号分隔。支持 ```host```（任意端口）与 ```host:port```（只该端口）；
 *   IPv6 支持 `[::1]` / `[::1]:3030`。默认与上面 1、2 两项取并集（**不替换默认值**）。
 * - 错误行为：入口把非法项丢弃（与 TRUSTED_ORIGINS 同口径：一个写错的域名不该让服务起不来），
 *   生效项由 http.ts 在监听后打印（`trusted hosts: ...`）便于核对。
 * - 端口语义：**登记时不写端口 ⇒ 该主机的任意端口都接受**（运维通常只知道域名，不知道用户会绑哪个端口）；
 *   写了端口 ⇒ 只有该端口接受。这条必须写清，否则「配了域名却被端口卡住」会很难排查。
 *
 * ## 缺失 / 畸形 Host 的处理（**fail-closed**）
 *
 * 判据与上面同一条：既然 Host 是唯一信号，那**没有这个信号时必须拒绝**，不能"没 Host 就当同源"。
 * - HTTP/1.0 请求**可以不带 Host** ⇒ 这类请求会被拒（403 且原因写明）。
 * - 畸形 Host（空、含路径/空白/非法字符）⇒ 拒绝。
 * - 端口非数字 ⇒ 拒绝。
 *
 * 已知代价（如实记在 spec 里）：用 HTTP/1.1 且**不发送 Host** 的手工探针 / 老健康检查脚本会被拒。
 * 这是可接受的有意取舍 —— 那种请求同样不带 `Origin`，本来就被来源校验当作"非浏览器客户端"放行过，
 * 如果在这里也放行，rebinding 链上"浏览器不带 Host"这一格就永远是敞开的（浏览器确实总会带 Host，
 * 但服务端无法区分"是浏览器没带"与"是别的客户端没带"）。用诊断工具时请带 `Host`（curl 默认就带）。
 */

/** 白名单条目：host 已归一化（小写、去尾随点、IPv6 去方括号）；port 为 undefined 表示任意端口。 */
export interface TrustedHostEntry {
  host: string;
  port?: number;
  /** 来源标签，仅用于启动日志与排障。 */
  label: string;
}

export type TrustedHostSource = "loopback" | "interface" | "configured";

/**
 * 把主机名归一化：小写、去尾随点（**一个或多个**：`localhost` / `localhost.` / `localhost..` 等价，
 * 实测 `LOCALHOST.:port` 是第一版漏掉的形态）。IPv6 的方括号由上层剥离。
 */
function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.+$/, "");
}

/**
 * 拆分 `host[:port]`（含 IPv6 的 `[::1]:3030`）。
 *
 * 返回 `null` 表示畸形（空、端口非数字、含路径/空白/非法字符）—— 调用方据此 fail-closed。
 */
export function splitHostPort(raw: string | undefined): { host: string; port?: number } | null {
  if (raw === undefined) {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  // 主机头里不该出现路径、查询、空白或控制字符。
  if (/[\s/?#\\]/.test(trimmed) || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    return null;
  }
  let hostPart: string;
  let portPart: string | undefined;
  if (trimmed.startsWith("[")) {
    const closing = trimmed.indexOf("]");
    if (closing === -1) {
      return null;
    }
    hostPart = trimmed.slice(1, closing);
    const rest = trimmed.slice(closing + 1);
    if (rest) {
      if (!rest.startsWith(":")) {
        return null;
      }
      portPart = rest.slice(1);
    }
  } else {
    const separator = trimmed.lastIndexOf(":");
    if (separator !== -1 && trimmed.indexOf(":") !== separator) {
      // 多个冒号：要么是**不带方括号的 IPv6 字面量**（`::1`、`fe80::1` —— 合法 Host，
      // RFC 7230 允许，实测 Node 的 http 解析器也接受这个形态），要么是畸形。
      // 判据是「整体本身是不是合法 IPv6」，而不是「有没有多个冒号」。
      if (isIP(trimmed) === 6) {
        return { host: normalizeHostname(trimmed) };
      }
      return null;
    }
    if (separator === -1) {
      hostPart = trimmed;
    } else {
      hostPart = trimmed.slice(0, separator);
      portPart = trimmed.slice(separator + 1);
    }
  }
  const host = normalizeHostname(hostPart);
  if (!host) {
    return null;
  }
  if (portPart === undefined) {
    return { host };
  }
  if (!/^\d{1,5}$/.test(portPart)) {
    return null;
  }
  const port = Number(portPart);
  if (port <= 0 || port > 65535) {
    return null;
  }
  return { host, port };
}

function isLoopbackIpv4(address: string): boolean {
  return /^127\./.test(address);
}

/** 是否是本机地址形态（回环 / 本机网卡）。用于默认白名单与「本机地址」判定。 */
export function isLocalAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  if (normalized === "localhost") {
    return true;
  }
  const family = isIP(normalized);
  if (family === 4) {
    return isLoopbackIpv4(normalized) || localInterfaceAddresses().has(normalized);
  }
  if (family === 6) {
    if (normalized === "::1") {
      return true;
    }
    return localInterfaceAddresses().has(normalized);
  }
  return false;
}

/** 本机所有非内部网络接口地址（缓存一次：接口不会在进程生命周期内频繁变化）。 */
let cachedInterfaceAddresses: Set<string> | undefined;
export function localInterfaceAddresses(): Set<string> {
  if (cachedInterfaceAddresses) {
    return cachedInterfaceAddresses;
  }
  const addresses = new Set<string>();
  try {
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.internal) {
          continue;
        }
        const address = normalizeHostname(entry.address);
        // IPv6 的 scope 后缀（fe80::1%eth0）要去掉才能比较。
        const withoutZone = address.includes("%")
          ? address.slice(0, address.indexOf("%"))
          : address;
        addresses.add(withoutZone);
      }
    }
  } catch {
    // 取接口失败不该让服务起不来：白名单退化成「回环 + 配置项」。
  }
  cachedInterfaceAddresses = addresses;
  return addresses;
}

/** 仅供测试：清掉接口地址缓存（测试会改 hostname/接口快照时用）。 */
export function resetLocalInterfaceCacheForTest(): void {
  cachedInterfaceAddresses = undefined;
}

/**
 * 构造默认白名单条目（回环各形态 + 本机网卡地址 + 显式配置）。
 *
 * `listenHost`（服务实际绑定的地址）总是被加入：把服务绑在某张网卡上却访问不了它，
 * 是「安全加固打死合法路径」的典型翻车方式。
 */
export function buildTrustedHostEntries(params: {
  configuredEntries?: readonly { host: string; port?: number }[];
  listenHost?: string;
  /** 额外注入的本机地址（测试用；缺省取 os.networkInterfaces()）。 */
  extraLocalAddresses?: readonly string[];
}): TrustedHostEntry[] {
  const entries: TrustedHostEntry[] = [];
  const seen = new Set<string>();
  const push = (entry: TrustedHostEntry): void => {
    const key = entry.host + ":" + (entry.port ?? "*");
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    entries.push(entry);
  };

  // 1) 回环：精确三种形态 + 整个 127/8（`127.1.2.3` 也解析到本机）。
  for (const host of ["127.0.0.1", "::1", "localhost"]) {
    push({ host, label: "loopback" });
  }
  // 整个 127/8 不逐条展开：`evaluateHost` 里对 127/8 单独放行（都指向本机，列举没有意义）。

  // 2) 本机网卡地址（默认绑局域网仍要能用）。
  for (const address of localInterfaceAddresses()) {
    push({ host: address, label: "interface" });
  }
  for (const address of params.extraLocalAddresses ?? []) {
    push({ host: normalizeHostname(address), label: "interface" });
  }

  // 3) 服务实际监听的地址（含 `0.0.0.0`/`::` 这种通配形式不加入：它们不是可访问的主机名）。
  const listenHost = params.listenHost ? normalizeHostname(params.listenHost) : undefined;
  if (listenHost && listenHost !== "0.0.0.0" && listenHost !== "::" && listenHost !== "*") {
    push({ host: listenHost, label: "listen" });
  }

  // 4) 运维显式登记。
  for (const entry of params.configuredEntries ?? []) {
    push({ host: entry.host, label: "configured", ...(entry.port ? { port: entry.port } : {}) });
  }
  return entries;
}

/** 解析 `ZCODE_SERVER_TRUSTED_HOSTS`：非法项丢弃（与 TRUSTED_ORIGINS 同口径）。 */
export function parseTrustedHosts(raw: string | undefined): { host: string; port?: number }[] {
  if (!raw?.trim()) {
    return [];
  }
  const parsed: { host: string; port?: number }[] = [];
  for (const entry of raw.split(",")) {
    const split = splitHostPort(entry);
    if (!split) {
      continue;
    }
    parsed.push(
      split.port === undefined ? { host: split.host } : { host: split.host, port: split.port },
    );
  }
  return parsed;
}

export interface HostDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * 判定一个 `Host` 头是否在白名单内。
 *
 * 端口语义：条目不带端口 ⇒ 任意端口接受；带端口 ⇒ 必须相等（含默认端口归一：`host:80`/`host:443`
 * 这类写法与不带端口等价，由调用方在解析配置时保持原样即可，这里只做精确比较）。
 */
export function evaluateHost(
  hostHeader: string | undefined,
  entries: readonly TrustedHostEntry[],
): HostDecision {
  const split = splitHostPort(hostHeader);
  if (!split) {
    return {
      allowed: false,
      reason:
        "请求的 Host 头缺失或畸形。本服务校验 Host 以阻断 DNS rebinding（攻击者用自己的域名解析到本机）。" +
        "HTTP/1.1 请带上 Host；curl 默认会带，手工探针请显式带上要访问的主机名。",
    };
  }
  const { host, port } = split;
  // 整个 127/8 都指向本机，逐条列举没有意义 ⇒ 单独放行（与 loopback 条目同一意图）。
  if (isIP(host) === 4 && isLoopbackIpv4(host)) {
    return { allowed: true };
  }
  for (const entry of entries) {
    if (entry.host !== host) {
      continue;
    }
    if (entry.port === undefined || entry.port === port) {
      return { allowed: true };
    }
  }
  return {
    allowed: false,
    reason:
      "请求的 Host（" +
      host +
      (port === undefined ? "" : ":" + String(port)) +
      "）不在允许的主机名单里。" +
      "本服务校验 Host 以阻断 DNS rebinding：攻击者用自己的域名解析到本机时，Host 会是那个域名。" +
      "如果你确实要通过这个域名访问（例如反向代理），请把它登记进 ZCODE_SERVER_TRUSTED_HOSTS（逗号分隔，" +
      "支持 host 或 host:port）。注意它与 ZCODE_SERVER_TRUSTED_ORIGINS 是两道不同防线：Host 挡 DNS rebinding，" +
      "Origin 挡跨站请求，反代换域名时通常两个都要配。",
  };
}
