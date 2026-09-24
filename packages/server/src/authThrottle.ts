import { isIP } from "node:net";

/**
 * 对端地址解析（**可信代理**口径，task-35 / G10②）与鉴权失败限流（G3）。
 *
 * ## 为什么这两件事必须同批
 *
 * 修改前 `http.ts` 的 `resolvePeerAddress` **无条件**采信 `X-Forwarded-For` 首跳
 * （原注释的理由是「伪造只会多打一次告警」—— 在只有告警时成立）。一旦按 IP 做限流，
 * 这个头就成了**攻击者自选的键**：每次请求换一个假 IP，限流形同不存在。
 * 所以「按 IP 限流」与「只在显式声明的可信代理后才采信 XFF」是同一个改动的两半。
 *
 * ## 口径
 *
 * - `ZCODE_SERVER_TRUSTED_PROXIES`：逗号分隔的可信代理（IP 或 CIDR，如 `127.0.0.1,10.0.0.0/8`）。
 *   **默认空 = 谁都不信**，直接取 socket 对端地址。这与 Open WebUI 的
 *   `FORWARDED_ALLOW_IPS`（默认 `*`，文档要求按拓扑收紧）反向选择：我们默认收紧，
 *   因为「默认信任转发头」的失败模式（限流可绕过 + 审计日志被伪造）比「反代后限流粒度偏粗」更贵。
 * - 采信时**从右往左**取第一个不在可信列表里的地址（标准的「最近一跳不可信客户端」算法，
 *   与 Portainer 的 `libhttp.ClientIP(r, trustedProxies)` 同思路）：
 *   `XFF: <client>, <proxy1>, <proxy2>` 且两跳代理都可信 ⇒ 取 `<client>`。
 *   左侧多出来的伪造值会被忽略，因为我们是「从右往左找第一个不可信」。
 * - 没有 XFF（直连）⇒ socket 地址。
 * - 畸形地址（非 IP 字面量）⇒ 不采信，退回 socket 地址（宁可粒度粗，也不给伪造留缝）。
 *
 * ## 限流
 *
 * 计数维度是**解析后的客户端地址**（不是 XFF 原文），所以伪造 XFF 换不来新的额度。
 * 阈值取「正常用户不可能踩到」的量级（默认 10 次 / 5 分钟 ⇒ 封 15 分钟）：本服务的正确凭据是
 * 一条 192 bit 令牌或它的 cookie，正常使用不会连续失败 10 次；而暴力破解在 10 次内绝无机会。
 * 命中后返回 403（而不是 429）：这是**拒绝服务**语义，与「请求太频繁请稍后重试」不同，
 * 客户端不该自动重试；具体原因写在响应体里，便于运维区分「被限流」与「凭据不对」。
 */

export interface TrustedProxyRange {
  /** 归一化后的网络地址（IPv4 十进制 / IPv6 原样小写）。 */
  network: string;
  /** 前缀长度；单 IP 记录为其满长。 */
  prefix: number;
  family: 4 | 6;
}

function ipv4ToInt(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return null;
  }
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const octet = Number(part);
    if (octet > 255) {
      return null;
    }
    value = value * 256 + octet;
  }
  return value >>> 0;
}

function ipv6ToBytes(address: string): number[] | null {
  const trimmed = address.trim().toLowerCase();
  const zoneIndex = trimmed.indexOf("%");
  const withoutZone = zoneIndex === -1 ? trimmed : trimmed.slice(0, zoneIndex);
  const halves = withoutZone.split("::");
  if (halves.length > 2) {
    return null;
  }
  const parseGroups = (segment: string): number[] | null => {
    if (!segment) {
      return [];
    }
    const groups: number[] = [];
    for (const group of segment.split(":")) {
      if (group.includes(".")) {
        const embedded = ipv4ToInt(group);
        if (embedded === null) {
          return null;
        }
        groups.push((embedded >>> 16) & 0xffff, embedded & 0xffff);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(group)) {
        return null;
      }
      groups.push(Number.parseInt(group, 16));
    }
    return groups;
  };
  const head = parseGroups(halves[0] ?? "");
  const tail = halves.length === 2 ? parseGroups(halves[1] ?? "") : [];
  if (head === null || tail === null) {
    return null;
  }
  const total = head.length + tail.length;
  if (halves.length === 2) {
    if (total > 8) {
      return null;
    }
    const bytes: number[] = [];
    for (const group of [...head, ...new Array(8 - total).fill(0), ...tail]) {
      bytes.push((group >> 8) & 0xff, group & 0xff);
    }
    return bytes;
  }
  if (total !== 8) {
    return null;
  }
  const bytes: number[] = [];
  for (const group of head) {
    bytes.push((group >> 8) & 0xff, group & 0xff);
  }
  return bytes;
}

/** 解析 `ZCODE_SERVER_TRUSTED_PROXIES`：接受 IP 与 CIDR；非法项丢弃（启动日志会列出生效项）。 */
export function parseTrustedProxies(raw: string | undefined): TrustedProxyRange[] {
  if (!raw?.trim()) {
    return [];
  }
  const ranges: TrustedProxyRange[] = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const slash = trimmed.lastIndexOf("/");
    const addressPart = slash === -1 ? trimmed : trimmed.slice(0, slash);
    const prefixPart = slash === -1 ? undefined : trimmed.slice(slash + 1);
    const family = isIP(addressPart) as 0 | 4 | 6;
    if (family === 0) {
      continue;
    }
    const maxPrefix = family === 4 ? 32 : 128;
    let prefix = maxPrefix;
    if (prefixPart !== undefined) {
      if (!/^\d{1,3}$/.test(prefixPart)) {
        continue;
      }
      prefix = Number(prefixPart);
      if (prefix > maxPrefix) {
        continue;
      }
    }
    ranges.push({ network: canonicalAddress(addressPart, family), prefix, family });
  }
  return ranges;
}

function canonicalAddress(address: string, family: number): string {
  if (family === 4) {
    const value = ipv4ToInt(address);
    return value === null ? address : String(value);
  }
  return address.trim().toLowerCase();
}

function isInRange(address: string, range: TrustedProxyRange): boolean {
  const family = isIP(address) as 0 | 4 | 6;
  if (family !== range.family) {
    return false;
  }
  if (family === 4) {
    const value = ipv4ToInt(address);
    const network = Number(range.network);
    if (value === null || Number.isNaN(network)) {
      return false;
    }
    if (range.prefix === 0) {
      return true;
    }
    const mask = range.prefix >= 32 ? 0xffffffff : (0xffffffff << (32 - range.prefix)) >>> 0;
    return (value & mask) === (network & mask);
  }
  const bytes = ipv6ToBytes(address);
  const networkBytes = ipv6ToBytes(range.network);
  if (!bytes || !networkBytes) {
    return false;
  }
  let remaining = range.prefix;
  for (let index = 0; index < 16; index += 1) {
    if (remaining <= 0) {
      return true;
    }
    const bits = Math.min(8, remaining);
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if (((bytes[index] ?? 0) & mask) !== ((networkBytes[index] ?? 0) & mask)) {
      return false;
    }
    remaining -= bits;
  }
  return true;
}

/** 地址是否落在任一可信代理范围内。 */
export function isTrustedProxy(
  address: string | undefined,
  ranges: readonly TrustedProxyRange[],
): boolean {
  if (!address) {
    return false;
  }
  const family = isIP(address);
  if (family === 0) {
    return false;
  }
  return ranges.some((range) => isInRange(address, range));
}

/**
 * 求客户端地址：默认只信 socket；仅在 socket 对端是**显式声明的可信代理**时才看 XFF，
 * 且从右往左取第一个不可信地址。
 */
export function resolveClientAddress(params: {
  socketAddress?: string;
  forwardedFor?: string;
  trustedProxies: readonly TrustedProxyRange[];
}): string | undefined {
  const { socketAddress, forwardedFor, trustedProxies } = params;
  if (socketAddress && isTrustedProxy(socketAddress, trustedProxies) && forwardedFor) {
    const hops = forwardedFor
      .split(",")
      .map((hop) => hop.trim())
      .filter(Boolean);
    for (let index = hops.length - 1; index >= 0; index -= 1) {
      const hop = hops[index] ?? "";
      if (isIP(hop) === 0) {
        // 畸形跳（含端口、域名、垃圾）不采信，退回 socket：宁可粒度粗，也不给伪造留缝。
        return socketAddress;
      }
      if (!isTrustedProxy(hop, trustedProxies)) {
        return hop;
      }
    }
    // 全是可信跳（例如只有一层反代却没带客户端地址）⇒ 取最左那条，仍比 socket 更接近真实客户端。
    return hops[0] ?? socketAddress;
  }
  return socketAddress;
}

export interface AuthThrottleOptions {
  /** 允许的失败次数（达到即封禁）。 */
  maxFailures?: number;
  /** 失败计数窗口。 */
  windowMs?: number;
  /** 封禁时长。 */
  banDurationMs?: number;
  /** 同时跟踪的客户端上限（防伪造地址把内存撑爆）。 */
  maxTrackedClients?: number;
  now?: () => number;
  /** 告警回调：携带被处理的客户端地址，便于运维直接定位（`http.ts` 负责加日志前缀）。 */
  warn?: (address: string, message: string) => void;
}

export interface AuthThrottleDecision {
  allowed: boolean;
  /** 剩余封禁时间（毫秒）；仅 allowed=false 时有值。 */
  retryAfterMs?: number;
}

export interface AuthThrottle {
  /** 该地址当前是否被允许尝试鉴权。 */
  check(address: string | undefined): AuthThrottleDecision;
  /** 记一次鉴权失败；达到阈值即封禁并告警。返回是否因此被新封禁。 */
  recordFailure(address: string | undefined): boolean;
  /** 记一次鉴权成功（清掉该地址的失败计数与封禁）。 */
  recordSuccess(address: string | undefined): void;
  /** 已被封禁的地址数量（用于断言与日志）。 */
  bannedCount(): number;
  /** 当前失败计数（测试用）。 */
  failureCount(address: string): number;
}

interface ThrottleEntry {
  failures: number;
  windowStartedAt: number;
  bannedUntil: number;
}

const DEFAULT_MAX_FAILURES = 10;
const DEFAULT_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_BAN_MS = 15 * 60 * 1000;
const DEFAULT_MAX_TRACKED = 4096;

export function createAuthThrottle(options: AuthThrottleOptions = {}): AuthThrottle {
  const maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const banDurationMs = options.banDurationMs ?? DEFAULT_BAN_MS;
  const maxTrackedClients = options.maxTrackedClients ?? DEFAULT_MAX_TRACKED;
  const now = options.now ?? Date.now;
  const warn = options.warn;
  const entries = new Map<string, ThrottleEntry>();

  const prune = (at: number): void => {
    for (const [address, entry] of entries) {
      const windowExpired = at - entry.windowStartedAt > windowMs;
      const banExpired = entry.bannedUntil <= at;
      if (windowExpired && banExpired) {
        entries.delete(address);
      }
    }
  };

  const entryFor = (address: string, at: number): ThrottleEntry => {
    const existing = entries.get(address);
    if (existing) {
      if (at - existing.windowStartedAt > windowMs && existing.bannedUntil <= at) {
        existing.failures = 0;
        existing.windowStartedAt = at;
      }
      return existing;
    }
    if (entries.size >= maxTrackedClients) {
      prune(at);
      if (entries.size >= maxTrackedClients) {
        // 仍然满：丢掉最早的一条（不区分是不是被封禁的，避免无界增长）。
        const oldest = entries.keys().next();
        if (!oldest.done) {
          entries.delete(oldest.value);
        }
      }
    }
    const created: ThrottleEntry = { failures: 0, windowStartedAt: at, bannedUntil: 0 };
    entries.set(address, created);
    return created;
  };

  return {
    check(address) {
      if (!address) {
        return { allowed: true };
      }
      const at = now();
      const entry = entries.get(address);
      if (!entry || entry.bannedUntil <= at) {
        return { allowed: true };
      }
      return { allowed: false, retryAfterMs: entry.bannedUntil - at };
    },
    recordFailure(address) {
      if (!address) {
        return false;
      }
      const at = now();
      const entry = entryFor(address, at);
      entry.failures += 1;
      if (entry.failures >= maxFailures && entry.bannedUntil <= at) {
        entry.bannedUntil = at + banDurationMs;
        warn?.(
          address,
          "鉴权失败次数达到阈值（" +
            String(entry.failures) +
            "/" +
            String(maxFailures) +
            "），已封禁该客户端 " +
            String(Math.round(banDurationMs / 1000)) +
            " 秒。",
        );
        return true;
      }
      return false;
    },
    recordSuccess(address) {
      if (!address) {
        return;
      }
      entries.delete(address);
    },
    bannedCount() {
      const at = now();
      let count = 0;
      for (const entry of entries.values()) {
        if (entry.bannedUntil > at) {
          count += 1;
        }
      }
      return count;
    },
    failureCount(address) {
      return entries.get(address)?.failures ?? 0;
    },
  };
}
