import type { IntranetProbeRequest, IntranetProbeTcpTarget } from "@zcode/shared";
import type { ISystemService } from "@zcode/services";
import type { ConfirmDialogRequest } from "@/store/confirmDialogStore.js";

/**
 * 内网探测 tcp 目标的探测前确认（S3）。
 *
 * probeIntranet 的 tcp target 由调用方直接传入 host/port；服务端现在
 * 要求每个 host:port 先获得用户显式确认（未确认的目标在建连前被拒绝）。
 * 本模块把「查询授权 → 弹确认（显示真实 host:port）→ 记录授权」三步收敛成
 * 一个纯依赖注入的函数，供 useIntranetProbe 在发起探测前调用；抽出来才能
 * 在不渲染 React 组件的前提下直接做行为测试（假 systemService + 假弹窗）。
 */

export interface IntranetProbeConsentGateDeps {
  systemService: Pick<
    ISystemService,
    "getIntranetProbeTcpTargetConsent" | "recordIntranetProbeTcpTargetConsent"
  >;
  requestConfirmation: (payload: ConfirmDialogRequest) => Promise<boolean>;
  formatMessage: (descriptor: { id: string }, values?: Record<string, string | number>) => string;
}

export type IntranetProbeConsentGateOutcome = { ok: true } | { ok: false; error: Error };

/**
 * 从探测请求中取出 tcp target（kind 为 "tcp" 或缺省；service target 不走确认，
 * 其 URL 判据在服务端执行）。
 */
export function collectIntranetProbeTcpTargets(
  request: IntranetProbeRequest,
): IntranetProbeTcpTarget[] {
  return request.targets.filter((target) => target.kind !== "service");
}

/** 按服务端返回的对齐条目筛出未确认的 tcp target。 */
export function selectUnconsentedIntranetProbeTcpTargets(
  targets: readonly IntranetProbeTcpTarget[],
  entries: ReadonlyArray<{ host: string; port: number; consented: boolean }>,
): IntranetProbeTcpTarget[] {
  return targets.filter((_target, index) => entries[index]?.consented !== true);
}

/** 构建确认弹窗请求：描述里列出真实 host:port（每目标一行；port 缺省即探测默认端口 22）。 */
export function buildIntranetProbeConsentDialogRequest(
  targets: ReadonlyArray<{ host: string; port?: number }>,
  formatMessage: IntranetProbeConsentGateDeps["formatMessage"],
): ConfirmDialogRequest {
  const targetLines = targets.map((target) => `${target.host}:${target.port ?? 22}`).join("\n");
  return {
    testId: "intranet-probe-consent-dialog",
    title: formatMessage({ id: "intranetProbe.consent.title" }),
    description: formatMessage(
      { id: "intranetProbe.consent.description" },
      { targets: targetLines },
    ),
    confirmLabel: formatMessage({ id: "intranetProbe.consent.confirm" }),
    confirmVariant: "default",
  };
}

/**
 * 探测前的授权门：
 * 1. 查询服务端已记录的授权（同一 host:port 一次确认可复用）；
 * 2. 未授权的目标逐列展示在确认弹窗（真实 host:port），用户确认后记录到服务端；
 * 3. 用户取消 ⇒ 返回 { ok: false }，调用方不得发起探测（服务端也会拒绝）。
 */
export async function ensureIntranetProbeTcpConsent(
  request: IntranetProbeRequest,
  deps: IntranetProbeConsentGateDeps,
): Promise<IntranetProbeConsentGateOutcome> {
  const tcpTargets = collectIntranetProbeTcpTargets(request);
  if (tcpTargets.length === 0) {
    return { ok: true };
  }

  let entries;
  try {
    const consent = await deps.systemService.getIntranetProbeTcpTargetConsent({
      targets: tcpTargets,
    });
    entries = consent.entries;
  } catch (error) {
    return {
      ok: false,
      error: new Error(deps.formatMessage({ id: "intranetProbe.error.consentQueryFailed" }), {
        cause: error instanceof Error ? error : new Error(String(error)),
      }),
    };
  }

  const unconsented = selectUnconsentedIntranetProbeTcpTargets(tcpTargets, entries);
  if (unconsented.length === 0) {
    return { ok: true };
  }

  const confirmed = await deps.requestConfirmation(
    buildIntranetProbeConsentDialogRequest(unconsented, deps.formatMessage),
  );
  if (!confirmed) {
    return {
      ok: false,
      error: new Error(deps.formatMessage({ id: "intranetProbe.error.consentDeclined" })),
    };
  }

  try {
    await deps.systemService.recordIntranetProbeTcpTargetConsent({ targets: unconsented });
  } catch (error) {
    return {
      ok: false,
      error: new Error(deps.formatMessage({ id: "intranetProbe.error.consentRecordFailed" }), {
        cause: error instanceof Error ? error : new Error(String(error)),
      }),
    };
  }

  return { ok: true };
}
