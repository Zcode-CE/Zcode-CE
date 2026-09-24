import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

/**
 * Bot 入站附件的出站下载防护（SSRF）。
 *
 * 背景：webhook 渠道的入站 payload 里 `attachments[].downloadUrl` 完全由请求方控制
 * （providers/webhookProvider.ts:93-95 直接透传），botsService 又对它直接 `fetch`。
 * 微信渠道同理（providers/weixinProvider.ts:651）。这等于把「任意 URL 取回内容」
 * 暴露给能打到入站面的人 —— 可用来探测内网、读云元数据（169.254.169.254）、
 * 访问回环上的本机服务。
 *
 * 判据不是「字符串前缀黑名单」：`http://127.0.0.1` 可以被写成
 * `http://2130706433/`、`http://0x7f.1/`、`http://[::ffff:127.0.0.1]/`、
 * 或用一个解析到私网的域名绕过。因此本模块：
 *   1. 解析 URL，只允许 http/https；
 *   2. 对主机名做 DNS 解析，对解析出的每一个地址做网段判定（拒绝任一命中即拒绝）；
 *   3. 把解析结果 pin 到连接阶段（dispatcher 的 lookup），关闭「预检公网、实连私网」
 *      的 DNS rebinding 窗口；
 *   4. 不跟随重定向（每一跳都重新判定，避免重定向到内网）。
 *
 * 这套做法与本仓库既有的 `packages/desktop/src/main/desktopSaveFile.ts:17-135`
 * 同源（那边保护的是 renderer 触发的下载），此处按 bot 附件的场景复用同一判据。
 */

const BOT_ATTACHMENT_MAX_REDIRECTS = 3;

/** 禁止的网段。与 desktopSaveFile.ts:18-45 同一份口径，便于两处一起审。 */
const blockedRemoteAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedRemoteAddresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
] as const) {
  blockedRemoteAddresses.addSubnet(network, prefix, "ipv6");
}

/**
 * 用户可配置的放行项。
 *
 * 判据：第三方可控输入要防，用户自配目标不防 —— 但"不防"不等于"一律禁止、无法放宽"，
 * 人的需要不同（例如附件放在自建 NAS 或内网对象存储上）。因此这里是默认安全 + 可配置：
 * 默认禁内网/回环/链路本地/云元数据；用户可显式登记要放行的主机。
 *
 * 配置来源（两级，后者覆盖前者）：
 *   1. 环境变量 `ZCODE_BOT_ATTACHMENT_ALLOWED_HOSTS`：逗号分隔的主机名或 IP 字面量。
 *      与既有 `ZCODE_SERVER_TRUSTED_HOSTS`（packages/server/src/entry-http.ts:65）
 *      同一形态，便于运维用一套习惯管理。
 *   2. 代码内联（测试与嵌入方）：`setBotAttachmentAllowedHosts()`。
 *
 * 语义边界（必须写明，否则用户会以为它放行了所有内网）：
 *   · 只按主机名精确匹配（大小写不敏感），不做通配符、不做后缀匹配 ——
 *     `evil.com` 不能因为登记了 `com` 而被放行；
 *   · 放行的是该主机的地址判定，协议与重定向规则不变；
 *   · 未配置时集合为空 ⇒ 行为与"默认安全"完全一致。
 */
const configuredAllowedHosts = new Set<string>();

/** 解析环境变量形式的主机清单。导出以便测试直接验证解析口径。 */
export function parseAllowedAttachmentHosts(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/** 设置内联放行项（覆盖环境变量）。传空数组即回到默认安全。 */
export function setBotAttachmentAllowedHosts(hosts: readonly string[]): void {
  configuredAllowedHosts.clear();
  for (const host of hosts) {
    const normalized = host.trim().toLowerCase();
    if (normalized) configuredAllowedHosts.add(normalized);
  }
}

function allowedHosts(): Set<string> {
  const fromEnv = parseAllowedAttachmentHosts(
    typeof process === "undefined" ? undefined : process.env["ZCODE_BOT_ATTACHMENT_ALLOWED_HOSTS"],
  );
  return new Set([...fromEnv, ...configuredAllowedHosts]);
}

/** 附件下载被拒绝的原因码。调用方据此给用户可操作文案。 */
export type BotAttachmentUrlRejection =
  | "invalid_url"
  | "unsupported_protocol"
  | "blocked_address"
  | "redirect_not_allowed";

export class BotAttachmentUrlRejectedError extends Error {
  readonly code = "bot_attachment_url_rejected";

  constructor(
    readonly reason: BotAttachmentUrlRejection,
    detail?: string,
  ) {
    super(
      `Bot attachment URL rejected (${reason})` +
        (detail ? `: ${detail}` : "") +
        ". Only http/https URLs that resolve exclusively to public addresses are allowed.",
    );
    this.name = "BotAttachmentUrlRejectedError";
  }
}

function parseAttachmentUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BotAttachmentUrlRejectedError("invalid_url", value.slice(0, 120));
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BotAttachmentUrlRejectedError("unsupported_protocol", url.protocol);
  }
  return url;
}

/**
 * 解析主机名并对每个地址做网段判定。
 *
 * 字面量 IP 也走同一条判定（`isIP` 命中时不做 DNS），这样
 * `http://169.254.169.254/` 与 `http://[::1]/` 不会因为「没走 DNS」而漏判。
 */
export async function resolveAllowedAttachmentAddresses(
  url: URL,
): Promise<{ address: string; family: number }[]> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  // 用户显式登记的放行项优先：允许连内网附件是本条能力的一部分（默认关闭）。
  if (allowedHosts().has(hostname)) {
    if (isIP(hostname)) {
      return [{ address: hostname, family: isIP(hostname) === 6 ? 6 : 4 }];
    }
    try {
      const resolved = await lookup(hostname, { all: true, verbatim: true });
      if (resolved.length > 0) return resolved;
    } catch {
      // 放行项解析失败时落回下面的默认判定，给出统一的可操作错误。
    }
  }
  // 这些名字在多数解析器里都指向回环，但不要依赖解析结果 —— 直接拒。
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new BotAttachmentUrlRejectedError("blocked_address", hostname);
  }

  if (isIP(hostname)) {
    const family = isIP(hostname) === 6 ? 6 : 4;
    if (blockedRemoteAddresses.check(hostname, family === 6 ? "ipv6" : "ipv4")) {
      throw new BotAttachmentUrlRejectedError("blocked_address", hostname);
    }
    return [{ address: hostname, family }];
  }

  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new BotAttachmentUrlRejectedError("invalid_url", `DNS lookup failed for ${hostname}`);
  }
  if (addresses.length === 0) {
    throw new BotAttachmentUrlRejectedError("invalid_url", `no address for ${hostname}`);
  }
  // 任一地址命中禁用网段就整体拒绝：多地址（含 IPv6）只放行其中一个等于留后门。
  for (const { address, family } of addresses) {
    if (blockedRemoteAddresses.check(address, family === 6 ? "ipv6" : "ipv4")) {
      throw new BotAttachmentUrlRejectedError("blocked_address", `${hostname} → ${address}`);
    }
  }
  return addresses;
}

/**
 * 校验并下载附件。返回 body 字节。
 *
 * 重定向不跟随（`redirect: "manual"`）：跟随会让「公网 URL 302 到内网」绕过首跳判定。
 * 每一跳都重新解析 + 重新判定，最多 `BOT_ATTACHMENT_MAX_REDIRECTS` 跳。
 */
export async function fetchBotAttachmentFromUrl(
  rawUrl: string,
  options: { signal?: AbortSignal; maxRedirects?: number } = {},
): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  const maxRedirects = options.maxRedirects ?? BOT_ATTACHMENT_MAX_REDIRECTS;
  let currentUrl = parseAttachmentUrl(rawUrl);

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const addresses = await resolveAllowedAttachmentAddresses(currentUrl);
    // DNS 校验结果必须绑定到连接阶段：dispatcher 不再自行解析域名，
    // 从而关闭「预检公网、实际连接私网」的 DNS rebinding 窗口。
    const dispatcher = new Agent({
      connect: {
        lookup: (_hostname, opts, callback) => {
          const first = addresses[0];
          if (!first) {
            callback(new Error("bot attachment download failed"), "");
            return;
          }
          if ((opts as { all?: boolean }).all) {
            callback(null, addresses as never);
            return;
          }
          callback(null, first.address, first.family);
        },
      },
    });
    let response: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      response = await undiciFetch(currentUrl, {
        dispatcher,
        redirect: "manual",
        signal: options.signal,
      });
    } catch (error) {
      await dispatcher.close();
      throw error;
    }

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      await dispatcher.close();
      const location = response.headers.get("location");
      if (!location) {
        throw new BotAttachmentUrlRejectedError("redirect_not_allowed", `HTTP ${response.status}`);
      }
      if (hop === maxRedirects) {
        throw new BotAttachmentUrlRejectedError("redirect_not_allowed", "too many redirects");
      }
      currentUrl = parseAttachmentUrl(new URL(location, currentUrl).toString());
      continue;
    }

    try {
      if (!response.ok) {
        throw new Error(`download failed: HTTP ${response.status}`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      return { bytes, contentType: response.headers.get("content-type") };
    } finally {
      await dispatcher.close();
    }
  }

  throw new BotAttachmentUrlRejectedError("redirect_not_allowed", "too many redirects");
}
