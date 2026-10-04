import type { IntranetProbeTcpTarget } from "@zcode/shared";

/**
 * 内网探测 tcp 目标的用户确认（S3）。
 *
 * probeIntranet 的 tcp target 由客户端直接传入 host/port，且该接口存在的意义
 * 就是探内网——因此不按私网地址拒绝目标（那样等于删功能），而是消灭
 * 「不问自探」：每个 host:port 在被探测前必须经过用户显式确认，服务端记录
 * 后本次确认可复用；换目标（不同 host:port）需重新确认。
 *
 * 记录的所有者与生命周期：存储是 createSystemService 实例内的内存 Map（见
 * createIntranetProbeTcpConsentStore），随宿主装配（createLocalServices：一个
 * desktop 窗口 Host / 一个 server 进程）存活，进程或窗口关闭即失效——不落盘、
 * 不跨会话保留。
 */

export interface IntranetProbeTcpTargetConsentEntry {
  host: string;
  port: number;
  /** 该 host:port 是否已获得用户确认。 */
  consented: boolean;
}

export interface IntranetProbeTcpTargetConsentRequest {
  targets: IntranetProbeTcpTarget[];
}

export interface IntranetProbeTcpTargetConsentResult {
  /** 与 request.targets 逐项对齐（顺序一致），调用方可按下标回配原 target。 */
  entries: IntranetProbeTcpTargetConsentEntry[];
}

/** 归一化用于确认记录的 tcp target：host 去空白、port 落在 1-65535，否则返回 null。 */
export function normalizeIntranetProbeConsentTcpTarget(
  target: IntranetProbeTcpTarget,
): { host: string; port: number } | null {
  const host = target.host.trim();
  if (host.length === 0) {
    return null;
  }
  const port =
    typeof target.port === "number" &&
    Number.isInteger(target.port) &&
    target.port >= 1 &&
    target.port <= 65535
      ? target.port
      : 22;
  return { host: host.toLowerCase(), port };
}

/** 确认记录的键：host 小写 + 规范端口，与 normalizeIntranetProbeConsentTcpTarget 同口径。 */
export function intranetProbeConsentKey(host: string, port: number): string {
  return `${host.toLowerCase()}:${port}`;
}

/** 未确认的 tcp target 在探测结果中的错误文案（客户端据此给出明确提示）。 */
export function intranetProbeConsentRequiredError(host: string, port: number): string {
  return `consent required for ${host}:${port}（未确认的探测目标，需在界面显式确认后重试）`;
}

/**
 * 确认记录的条数上限：记录即「一次确认可复用的探测许可」，恶意客户端可
 * 通过不断登记新 host:port 把表撑大；FIFO 上限让最旧记录先出局
 * （被淘汰目标下次探测需重新确认）。
 */
const MAX_INTRANET_PROBE_CONSENT_ENTRIES = 256;

/** tcp 探测确认记录的读写面（query/record 的实现由 createIntranetProbeTcpConsentStore 提供）。 */
export interface IntranetProbeTcpConsentStore {
  hasConsent(host: string, port: number): boolean;
  query(targets: readonly IntranetProbeTcpTarget[]): IntranetProbeTcpTargetConsentResult;
  record(targets: readonly IntranetProbeTcpTarget[]): IntranetProbeTcpTargetConsentResult;
}

/**
 * 创建确认记录存储（S3）。
 *
 * 所有者 = createSystemService 实例（由 createLocalServices 装配：一个 desktop
 * 窗口 Host / 一个 server 进程）；生命周期 = 实例存活期，不落盘、不跨进程保留——
 * 重启或换窗口后必须重新确认（会话即授权的作用域）。同一 host:port 一次确认在
 * 本实例内复用，换目标（不同 host:port）重新确认。存储为内存 Map，无并发原语：
 * probeIntranet 与两个方法都在 host 进程的事件循环里串行执行。
 */
export function createIntranetProbeTcpConsentStore(
  options: { now?: () => number } = {},
): IntranetProbeTcpConsentStore {
  const now = options.now ?? Date.now;
  const consents = new Map<string, number>();

  return {
    hasConsent(host, port) {
      return consents.has(intranetProbeConsentKey(host, port));
    },

    query(targets) {
      // 与 request.targets 逐项对齐（含非法 target：返回 consented:false，
      // probeIntranet 的归一化会先丢弃它们，不会因对齐而误判）。
      const entries = targets.map((target): IntranetProbeTcpTargetConsentEntry => {
        const normalized = normalizeIntranetProbeConsentTcpTarget(target);
        return {
          host: normalized?.host ?? target.host.trim(),
          // port 兜底与探测侧一致（缺省/越界端口即默认端口 22）。
          port: normalized?.port ?? 22,
          consented:
            normalized !== null &&
            consents.has(intranetProbeConsentKey(normalized.host, normalized.port)),
        };
      });
      return { entries };
    },

    record(targets) {
      const entries: IntranetProbeTcpTargetConsentEntry[] = [];
      for (const target of targets) {
        const normalized = normalizeIntranetProbeConsentTcpTarget(target);
        if (normalized === null) {
          // 非法 target 不予记录（探测侧的归一化同样会丢弃）。
          continue;
        }
        const key = intranetProbeConsentKey(normalized.host, normalized.port);
        if (!consents.has(key)) {
          if (consents.size >= MAX_INTRANET_PROBE_CONSENT_ENTRIES) {
            const oldestKey = consents.keys().next().value;
            if (oldestKey !== undefined) {
              consents.delete(oldestKey);
            }
          }
          consents.set(key, now());
        }
        entries.push({ host: normalized.host, port: normalized.port, consented: true });
      }
      return { entries };
    },
  };
}
