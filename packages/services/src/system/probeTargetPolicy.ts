import { Agent, fetch as undiciFetch } from "undici";

import type {
  IntranetProbeServiceTargetResult,
  IntranetProbeTargetResult,
  IntranetProbeTcpTargetResult,
} from "@zcode/shared";
import {
  assertAllowedAttachmentUrl,
  BotAttachmentUrlRejectedError,
  resolveAllowedAttachmentAddresses,
} from "../bots/attachmentUrlGuard.js";
import {
  intranetProbeConsentKey,
  intranetProbeConsentRequiredError,
  type IntranetProbeTcpConsentStore,
} from "./intranetProbeConsent.js";

/**
 * 内网探测的目标策略与逐目标执行（S3）。
 *
 * systemService.ts 只保留输入归一化与结果聚合；本模块承载「目标能不能探、
 * 怎么探」的策略：
 * - service target：在任何 serviceProbe 实现之前先断 SSRF 判据（只公网、DNS pin、
 *   不跟随重定向——默认实现 probeServiceEndpoint 也走同一判据，两层独立承重）；
 * - tcp target：不按地址拒绝（该功能的目的就是探内网），但每个 host:port 必须
 *   先获得用户显式确认，未确认的目标不建连。
 */

export interface NormalizedProbeTarget {
  kind: "tcp";
  targetId: string;
  host: string;
  port: number;
  timeoutMs: number;
}

export interface NormalizedServiceProbeTarget {
  kind: "service";
  targetId: string;
  url: string;
  expectedMarker?: string;
  token?: string;
  timeoutMs: number;
}

export type NormalizedTarget = NormalizedProbeTarget | NormalizedServiceProbeTarget;

export interface TcpProbeParams {
  host: string;
  port: number;
  timeoutMs: number;
}

export interface ServiceProbeParams {
  url: string;
  timeoutMs: number;
  token?: string;
}

export interface ServiceProbeResult {
  latencyMs: number;
  marker?: string;
}

async function runProbeWithRetry(
  target: NormalizedProbeTarget,
  attempts: number,
  tcpProbe: (params: TcpProbeParams) => Promise<number>,
): Promise<IntranetProbeTcpTargetResult> {
  let lastError = "";

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const latencyMs = await tcpProbe({
        host: target.host,
        port: target.port,
        timeoutMs: target.timeoutMs,
      });
      return {
        targetId: target.targetId,
        kind: "tcp",
        host: target.host,
        port: target.port,
        reachable: true,
        attemptCount: attempt,
        latencyMs,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    targetId: target.targetId,
    kind: "tcp",
    host: target.host,
    port: target.port,
    reachable: false,
    attemptCount: attempts,
    latencyMs: null,
    error: lastError || "probe failed",
  };
}

async function runServiceProbeWithRetry(
  target: NormalizedServiceProbeTarget,
  attempts: number,
  serviceProbe: (params: ServiceProbeParams) => Promise<ServiceProbeResult>,
): Promise<IntranetProbeServiceTargetResult> {
  let lastError = "";

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await serviceProbe({
        url: target.url,
        timeoutMs: target.timeoutMs,
        token: target.token,
      });

      if (target.expectedMarker && result.marker !== target.expectedMarker) {
        throw new Error(
          `marker mismatch(expected=${target.expectedMarker}, actual=${result.marker ?? "<empty>"})`,
        );
      }

      return {
        targetId: target.targetId,
        kind: "service",
        url: target.url,
        reachable: true,
        attemptCount: attempt,
        latencyMs: result.latencyMs,
        marker: result.marker,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    targetId: target.targetId,
    kind: "service",
    url: target.url,
    reachable: false,
    attemptCount: attempts,
    latencyMs: null,
    error: lastError || "probe failed",
  };
}

/**
 * service target 的 SSRF 加固 fetch（S3）：复用 attachmentUrlGuard 的 DNS 解析与
 * 网段判据，但支持自定义请求头（x-zcode-intranet-token 等）。
 *
 * fetchBotAttachmentFromUrl 的判据完全同源，但它不支持自定义请求头——service
 * target 携带 token 的能力不能靠它。这里在判据之上实现同源的 pinned fetch：
 * 只公网（resolveAllowedAttachmentAddresses 对每个解析地址做网段判定）、
 * 连接期 DNS pin（dispatcher 的 lookup 锁定预检地址，关闭 rebinding 窗口）、
 * 不跟随重定向（redirect: manual，每跳重新解析重新判定，上限 3 跳）。
 * 超时由调用方的 AbortSignal 控制；不退回裸 fetch、不绕过判据。
 */
const PROBE_SERVICE_MAX_REDIRECTS = 3;

function parseProbeServiceUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BotAttachmentUrlRejectedError("unsupported_protocol", url.protocol);
  }
  return url;
}

export interface IntranetProbeServiceFetchOptions {
  signal?: AbortSignal;
  /** 随请求发出的自定义头（如 token）；每跳重定向都重新携带。 */
  headers?: Record<string, string>;
}

export interface IntranetProbeServiceFetchResult {
  bytes: Uint8Array;
  /** HTTP 状态码（非 2xx 也会返回，由调用方按探测语义判失败）。 */
  status: number;
  contentType: string | null;
}

/**
 * 判据 + 建连 + 读 body；dispatcher 在 body 读完后关闭（调用方拿到的是完整字节，
 * 不再有悬挂的连接池）。
 */
export async function fetchIntranetProbeServiceBytes(
  rawUrl: string,
  options: IntranetProbeServiceFetchOptions = {},
): Promise<IntranetProbeServiceFetchResult> {
  let currentUrl = parseProbeServiceUrl(rawUrl);

  for (let hop = 0; hop <= PROBE_SERVICE_MAX_REDIRECTS; hop += 1) {
    const addresses = await resolveAllowedAttachmentAddresses(currentUrl);
    const dispatcher = new Agent({
      connect: {
        lookup: (_hostname, opts, callback) => {
          const first = addresses[0];
          if (!first) {
            callback(new Error("intranet probe service fetch failed"), "");
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
        method: "GET",
        redirect: "manual",
        headers: options.headers,
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
      if (!location || hop === PROBE_SERVICE_MAX_REDIRECTS) {
        throw new BotAttachmentUrlRejectedError("redirect_not_allowed", `HTTP ${response.status}`);
      }
      currentUrl = parseProbeServiceUrl(new URL(location, currentUrl).toString());
      continue;
    }

    try {
      const bytes = new Uint8Array(await response.arrayBuffer());
      return {
        bytes,
        status: response.status,
        contentType: response.headers.get("content-type"),
      };
    } finally {
      await dispatcher.close();
    }
  }

  throw new BotAttachmentUrlRejectedError("redirect_not_allowed", "too many redirects");
}

/**
 * service target 的 SSRF choke point：在交给任何 serviceProbe 实现之前先断 URL 策略。
 * 与 tcp target 不同，service target 不保留「探内网」能力（其响应内容会被读回）。
 */
async function guardIntranetProbeServiceUrl(url: string): Promise<void> {
  try {
    await assertAllowedAttachmentUrl(url);
  } catch (error) {
    if (error instanceof BotAttachmentUrlRejectedError) {
      throw new Error(`intranet service target rejected (${error.reason}): ${url}`);
    }
    throw error;
  }
}

/** 未获用户确认的 tcp target 的失败结果：不建连、不计尝试次数、给出可操作提示（S3）。 */
function unauthorizedTcpTargetResult(target: NormalizedProbeTarget): IntranetProbeTcpTargetResult {
  return {
    targetId: target.targetId,
    kind: "tcp",
    host: target.host,
    port: target.port,
    reachable: false,
    attemptCount: 0,
    latencyMs: null,
    error: intranetProbeConsentRequiredError(target.host, target.port),
  };
}

/** service target 在 SSRF 判据阶段即被拒绝的失败结果（不进入重试，重试不改变目标地址）。 */
function serviceTargetFailureResult(
  target: NormalizedServiceProbeTarget,
  error: string,
): IntranetProbeServiceTargetResult {
  return {
    targetId: target.targetId,
    kind: "service",
    url: target.url,
    reachable: false,
    attemptCount: 0,
    latencyMs: null,
    error,
  };
}

export interface IntranetProbeTargetRunnerDeps {
  attempts: number;
  tcpProbe: (params: TcpProbeParams) => Promise<number>;
  serviceProbe: (params: ServiceProbeParams) => Promise<ServiceProbeResult>;
  tcpConsent: IntranetProbeTcpConsentStore;
}

/**
 * 单个归一化 target 的执行（S3 的策略落点）：
 * - service target：先过 SSRF 判据，被拒即判失败（不重试——重试不改变目标地址）；
 * - tcp target：缺确认记录即判失败（不建连）；确认过的目标走正常重试。
 */
export async function runIntranetProbeTarget(
  target: NormalizedTarget,
  deps: IntranetProbeTargetRunnerDeps,
): Promise<IntranetProbeTargetResult> {
  if (target.kind === "service") {
    const guardError: Error | null = await guardIntranetProbeServiceUrl(target.url).then(
      () => null,
      (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
    );
    if (guardError) {
      return serviceTargetFailureResult(target, guardError.message);
    }
    return runServiceProbeWithRetry(target, deps.attempts, deps.serviceProbe);
  }

  // tcp：该功能的存在目的就是探内网，因此不按私网地址拒绝目标；但未获用户
  // 确认的 host:port 不得建连——「不问自探」必须消灭。即便客户端跳过弹窗，
  // 服务端这里也不会放行（纵深防护）。
  if (!deps.tcpConsent.hasConsent(target.host, target.port)) {
    return unauthorizedTcpTargetResult(target);
  }
  return runProbeWithRetry(target, deps.attempts, deps.tcpProbe);
}

/** 全部 target 都为 tcp / 全为 service / 混合，决定结果里的 strategy 字段。 */
export function resolveProbeStrategy(
  targets: readonly NormalizedTarget[],
): "tcp-connect" | "service-http" | "mixed" {
  if (targets.every((target) => target.kind === "tcp")) {
    return "tcp-connect";
  }
  if (targets.every((target) => target.kind === "service")) {
    return "service-http";
  }
  return "mixed";
}
