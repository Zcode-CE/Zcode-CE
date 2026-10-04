import { homedir } from "node:os";
import { Socket } from "node:net";
import type {
  IntegratedTerminalShellOption,
  IntranetProbeRequest,
  IntranetProbeResult,
  IntranetProbeServiceResponse,
  IntranetProbeServiceTarget,
  IntranetProbeTarget,
  IntranetProbeTcpTarget,
  SystemInfo,
} from "@zcode/shared";
import { BotAttachmentUrlRejectedError } from "../bots/attachmentUrlGuard.js";
import type { ISystemService } from "./system.js";
import {
  createIntranetProbeTcpConsentStore,
  type IntranetProbeTcpConsentStore,
  type IntranetProbeTcpTargetConsentRequest,
  type IntranetProbeTcpTargetConsentResult,
} from "./intranetProbeConsent.js";
import {
  fetchIntranetProbeServiceBytes,
  resolveProbeStrategy,
  runIntranetProbeTarget,
  type NormalizedProbeTarget,
  type NormalizedServiceProbeTarget,
  type NormalizedTarget,
  type ServiceProbeParams,
  type ServiceProbeResult,
  type TcpProbeParams,
} from "./probeTargetPolicy.js";
import { listIntegratedTerminalShellOptions } from "./integratedTerminalShells.js";

const DEFAULT_PROBE_TIMEOUT_MS = 800;
const DEFAULT_PROBE_ATTEMPTS = 2;
const MAX_PROBE_ATTEMPTS = 3;
const DEFAULT_PROBE_PORT = 22;

interface CreateSystemServiceOptions {
  env?: NodeJS.ProcessEnv;
  isExecutable?: (path: string) => boolean;
  platform?: NodeJS.Platform;
  tcpProbe?: (params: TcpProbeParams) => Promise<number>;
  serviceProbe?: (params: ServiceProbeParams) => Promise<ServiceProbeResult>;
  now?: () => number;
  /** tcp 探测确认记录存储（S3）；缺省在服务实例内新建一个内存实现。 */
  tcpConsentStore?: IntranetProbeTcpConsentStore;
}

function normalizeProbeAttempts(attempts: number | undefined): number {
  if (typeof attempts !== "number" || !Number.isFinite(attempts)) {
    return DEFAULT_PROBE_ATTEMPTS;
  }

  return Math.min(MAX_PROBE_ATTEMPTS, Math.max(1, Math.floor(attempts)));
}

function normalizeRequiredSuccessCount(
  requiredSuccessCount: number | undefined,
  totalTargets: number,
): number {
  if (totalTargets <= 0) {
    return 1;
  }

  if (typeof requiredSuccessCount !== "number" || !Number.isFinite(requiredSuccessCount)) {
    return 1;
  }

  return Math.min(totalTargets, Math.max(1, Math.floor(requiredSuccessCount)));
}

function normalizeProbeTimeout(timeoutMs: number | undefined): number {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
    ? Math.min(10_000, Math.max(100, Math.floor(timeoutMs)))
    : DEFAULT_PROBE_TIMEOUT_MS;
}

function normalizeTcpTarget(target: IntranetProbeTcpTarget): NormalizedProbeTarget | null {
  const host = target.host.trim();
  if (host.length === 0) {
    return null;
  }

  const resolvedPort =
    typeof target.port === "number" &&
    Number.isInteger(target.port) &&
    target.port >= 1 &&
    target.port <= 65535
      ? target.port
      : DEFAULT_PROBE_PORT;

  return {
    kind: "tcp",
    targetId: target.id?.trim() || `${host}:${resolvedPort}`,
    host,
    port: resolvedPort,
    timeoutMs: normalizeProbeTimeout(target.timeoutMs),
  };
}

function normalizeServiceTarget(
  target: IntranetProbeServiceTarget,
): NormalizedServiceProbeTarget | null {
  const urlText = target.url.trim();
  if (urlText.length === 0) {
    return null;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlText);
  } catch {
    return null;
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return null;
  }

  const expectedMarker = target.expectedMarker?.trim();
  const token = target.token?.trim();

  return {
    kind: "service",
    targetId: target.id?.trim() || parsedUrl.toString(),
    url: parsedUrl.toString(),
    expectedMarker: expectedMarker && expectedMarker.length > 0 ? expectedMarker : undefined,
    token: token && token.length > 0 ? token : undefined,
    timeoutMs: normalizeProbeTimeout(target.timeoutMs),
  };
}

function normalizeProbeTarget(target: IntranetProbeTarget): NormalizedTarget | null {
  if (target.kind === "service") {
    return normalizeServiceTarget(target);
  }

  return normalizeTcpTarget(target);
}

function parseProbeServiceResponse(payload: unknown): IntranetProbeServiceResponse {
  if (!payload || typeof payload !== "object") {
    throw new Error("invalid service response");
  }

  const response = payload as IntranetProbeServiceResponse;
  if (typeof response.ok !== "boolean") {
    throw new Error("invalid service response: missing ok");
  }

  if (
    "marker" in response &&
    response.marker !== undefined &&
    typeof response.marker !== "string"
  ) {
    throw new Error("invalid service response: marker must be string");
  }

  return response;
}

/**
 * 默认 service 探测实现（S3）：service target 的服务端 fetch 走与 bot 附件同一套
 * SSRF 加固——只公网、连接期 DNS pin、不跟随重定向（每跳重新判定）。service
 * target 的 URL 由调用方直接提供且响应 marker 会被读回，是比 tcp-connect 更强
 * 的信息外泄通道，因此判据收窄到公网；「探内网」的判定由 tcp target（每目标
 * 显式确认）承担。token 请求头经 fetchIntranetProbeServiceBytes 随请求发出
 * （每跳重定向都重新携带）；判据优先级不变：私网/回环一律拒绝，除非放行项登记。
 */
async function probeServiceEndpoint(params: ServiceProbeParams): Promise<ServiceProbeResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), params.timeoutMs);

  try {
    const { bytes, status } = await fetchIntranetProbeServiceBytes(params.url, {
      signal: controller.signal,
      headers: params.token ? { "x-zcode-intranet-token": params.token } : undefined,
    });
    if (status < 200 || status >= 300) {
      throw new Error(`HTTP ${status}`);
    }
    const responseBody = parseProbeServiceResponse(JSON.parse(new TextDecoder().decode(bytes)));
    if (!responseBody.ok) {
      throw new Error("service returned ok=false");
    }

    return {
      latencyMs: Math.max(0, Date.now() - startedAt),
      marker: responseBody.marker,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`timeout(${params.timeoutMs}ms)`);
    }
    // 判据拒绝（blocked_address / invalid_url / redirect_not_allowed；可能来自
    // choke point 之后的任何一跳，含重定向目标）统一转成探测口径，与 choke point
    // 的失败文案同形（reason 即可操作线索）。
    if (error instanceof BotAttachmentUrlRejectedError) {
      throw new Error(`intranet service target rejected (${error.reason}): ${params.url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function probeTcpPort(params: TcpProbeParams): Promise<number> {
  const { host, port, timeoutMs } = params;
  const startedAt = Date.now();

  return new Promise<number>((resolve, reject) => {
    const socket = new Socket();
    let settled = false;

    const finalize = (handler: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      handler();
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      const latencyMs = Math.max(0, Date.now() - startedAt);
      finalize(() => resolve(latencyMs));
    });
    socket.once("timeout", () => {
      finalize(() => reject(new Error(`timeout(${timeoutMs}ms)`)));
    });
    socket.once("error", (error) => {
      finalize(() => reject(error));
    });
    socket.connect(port, host);
  });
}

/**
 * 创建系统服务。tcp 探测的确认记录（S3）默认为实例内内存存储，生命周期
 * 见 createIntranetProbeTcpConsentStore 的注释（会话即授权作用域）；
 * 装配层可注入自定义存储（如按窗口/连接再隔离）。逐目标的策略与执行
 * 在 probeTargetPolicy.runIntranetProbeTarget，本函数只做输入归一化与结果聚合。
 */
export function createSystemService(options: CreateSystemServiceOptions = {}): ISystemService {
  const tcpProbe = options.tcpProbe ?? probeTcpPort;
  const serviceProbe = options.serviceProbe ?? probeServiceEndpoint;
  const now = options.now ?? Date.now;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const tcpConsent = options.tcpConsentStore ?? createIntranetProbeTcpConsentStore({ now });

  return {
    async info(): Promise<SystemInfo> {
      return { homedir: homedir(), platform: process.platform };
    },

    async listIntegratedTerminalShells(): Promise<IntegratedTerminalShellOption[]> {
      return listIntegratedTerminalShellOptions({
        env,
        isExecutable: options.isExecutable,
        platform,
      });
    },

    async getIntranetProbeTcpTargetConsent(
      request: IntranetProbeTcpTargetConsentRequest,
    ): Promise<IntranetProbeTcpTargetConsentResult> {
      return tcpConsent.query(request.targets);
    },

    async recordIntranetProbeTcpTargetConsent(
      request: IntranetProbeTcpTargetConsentRequest,
    ): Promise<IntranetProbeTcpTargetConsentResult> {
      return tcpConsent.record(request.targets);
    },

    async probeIntranet(request: IntranetProbeRequest): Promise<IntranetProbeResult> {
      const normalizedTargets = request.targets
        .map(normalizeProbeTarget)
        .filter((target): target is NormalizedTarget => target !== null);
      const attempts = normalizeProbeAttempts(request.attempts);
      const requiredSuccessCount = normalizeRequiredSuccessCount(
        request.requiredSuccessCount,
        normalizedTargets.length,
      );

      const results = await Promise.all(
        normalizedTargets.map((target) =>
          runIntranetProbeTarget(target, { attempts, tcpProbe, serviceProbe, tcpConsent }),
        ),
      );
      const reachedTargetCount = results.filter((result) => result.reachable).length;

      return {
        isIntranet: normalizedTargets.length > 0 && reachedTargetCount >= requiredSuccessCount,
        reachedTargetCount,
        requiredSuccessCount,
        totalTargets: normalizedTargets.length,
        checkedAt: now(),
        strategy: resolveProbeStrategy(normalizedTargets),
        results,
      };
    },
  };
}
