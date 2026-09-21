import {
  localTtftNow,
  type LocalTtftCalibration,
  type LocalTtftContext,
  type LocalTtftFacts,
  type LocalTtftRecord,
} from "@zcode/shared";
import type {
  ConversationTopicFrame,
  TopicFrameDeliveryKind,
} from "@zcode/shared/zcode-protocol-v4";

/**
 * 本地 TTFT 观测器 —— **采集已停用，仅保留协议形状**。
 *
 * 为什么不直接删类：`envelope.ttft` 是 **v4 命令信封的协议字段**（schema 见
 * `packages/shared/src/zcode-protocol-v4/command.ts` 的 `ttft`），CLI 侧
 * `v4-gateway.ts` 会消费它并把 `ttftExcluded` 写回 ACK。删掉类就等于删掉协议的一端，
 * 两端解析立刻失败。因此这里保留全部 15 个公开方法的名称与签名，只把实现降级为 no-op
 * （一律返回 `undefined` / 不做任何事）。
 *
 * 收益：UI 侧 18 处调用点（ConversationComposer 7 / SessionPane 4 /
 * agentConversationTransport 5 / 其余 2）与 `packages/ui/src/index.ts` 的导出
 * **零改动**；同时本地采集、跨进程时钟校准、OTLP 出口全部停摆。
 *
 * 上游 `packages/shared/src/localTtft.ts` 与协议 schema 一并保留（协议契约）。
 */
export class LocalTtftObserver {
  /**
   * 采集开关恒为 false：即使 bootstrap 或灰度配置把它置 true，也不再产生任何样本。
   * 保留该字段而不是删掉，是为了让既有灰度配置链路继续写值而不报错。
   */
  enabled = false;

  constructor(
    // 构造参数保留只为兼容既有 bootstrap 的构造调用；停用采集后不再使用任何一项。
    _onRecord: (record: LocalTtftRecord) => void,
    _now = localTtftNow,
    _wallNow = Date.now,
    _readForeground?: () => boolean,
  ) {}

  /** 停用后不再登记观测上下文，调用方拿到的恒为 undefined。 */
  start(_workspace: string, _busy: boolean, _unsupported = false): LocalTtftContext | undefined {
    return undefined;
  }

  dispatch(
    _context: LocalTtftContext,
    _workspace: string,
    _commandId: string,
    _sessionId?: string | null,
  ): LocalTtftContext | undefined {
    return undefined;
  }

  ack(_context: LocalTtftContext, _status: string, _excluded?: "capacity"): void {}

  calibrate(_workspace: string, _clock: LocalTtftCalibration): void {}

  /** 恒为 false：不再触发 `clock:true` 校准 RPC。 */
  needsCalibration(_workspace: string): boolean {
    return false;
  }

  checkpoint(_workspace: string, _incoming: LocalTtftFacts): void {}

  receive(
    _workspace: string,
    _frame: ConversationTopicFrame,
    _delivery: TopicFrameDeliveryKind,
  ): void {}

  exclude(_context: LocalTtftContext, _outcome: LocalTtftRecord["outcome"]): void {}

  confirmationRetry(_context: LocalTtftContext): void {}

  confirmation(_context: LocalTtftContext, _waiting: boolean): void {}

  background(): void {}

  foreground(): void {}

  sampleClock(): void {}

  interrupt(_workspace?: string): void {}

  expire(): void {}
}

let observer: LocalTtftObserver | undefined;

export function setLocalTtftObserver(value: LocalTtftObserver | undefined): void {
  observer = value;
}

export function getLocalTtftObserver(): LocalTtftObserver | undefined {
  return observer;
}
