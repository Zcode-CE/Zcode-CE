import type {
  IntegratedTerminalShellOption,
  IntranetProbeRequest,
  IntranetProbeResult,
  SystemInfo,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type {
  IntranetProbeTcpTargetConsentRequest,
  IntranetProbeTcpTargetConsentResult,
} from "./intranetProbeConsent.js";

export interface ISystemService {
  info(): Promise<SystemInfo>;
  listIntegratedTerminalShells(): Promise<IntegratedTerminalShellOption[]>;
  probeIntranet(request: IntranetProbeRequest): Promise<IntranetProbeResult>;
  /**
   * 查询 tcp 探测目标的用户确认状态（S3）：UI 在发起探测前据此决定是否弹确认。
   * 返回条目与 request.targets 逐项对齐。
   */
  getIntranetProbeTcpTargetConsent(
    request: IntranetProbeTcpTargetConsentRequest,
  ): Promise<IntranetProbeTcpTargetConsentResult>;
  /**
   * 记录用户已确认的 tcp 探测目标（S3）：同一 host:port 在本服务实例内可复用，
   * 换目标需重新确认。未确认的 host:port 在 probeIntranet 中会被拒绝。
   */
  recordIntranetProbeTcpTargetConsent(
    request: IntranetProbeTcpTargetConsentRequest,
  ): Promise<IntranetProbeTcpTargetConsentResult>;
}

export const ISystemService = createServiceDescriptor<ISystemService>(ServiceChannels.System);
