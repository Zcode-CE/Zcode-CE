/**
 * scheduler.ts 顶到 oxlint max-lines 上限（400 行），把 Boundary B 的两条向上回报
 * （submit_result 到达、turn 结束）及其 repair / nudge 预算与 submit 归一化拆到本文件；
 * 公开面仍从 scheduler.ts 导出。
 *
 * 自由函数经 {@link SubmitSeam} 拿到调度器的 live 节点表与两条结算入口；AskScheduler 上的
 * submitAttempted / turnEnded 只是薄委托。
 */

import type { AskNode, SchedulerHost } from "./scheduler-types.js";
import { refToString } from "./types.js";
import type { InstanceRef, NodeRecord, Violation } from "./types.js";
import { REPAIR_ATTEMPTS, WorkflowError } from "./types.js";

/** 调度器暴露给回报处理的最小接缝：查 live 节点、按结果结算。 */
export interface SubmitSeam {
  readonly host: SchedulerHost;
  /** 按实例查 live 节点（已离开 liveNodes 的返回 undefined）。 */
  liveNode(instance: InstanceRef): AskNode | undefined;
  settleOk(node: AskNode, artifact: unknown): void;
  settleFailed(node: AskNode, error: WorkflowError): void;
}

export function handleSubmitAttempted(
  seam: SubmitSeam,
  instance: InstanceRef,
  payload: unknown,
): void {
  const node = seam.liveNode(instance);
  if (node === undefined || node.settled) return;
  // untyped ask 不提供 submit_result；即便收到也不据其结算。
  if (!node.spec.typed) return;

  const { value, violations } = normalizeSubmit(seam.host, node.spec.schema, payload);
  if (violations.length === 0) {
    seam.host.driver.respondToSubmit(instance, { kind: "accept" });
    seam.settleOk(node, value);
    return;
  }
  if (node.repairsRemaining > 0) {
    node.repairsRemaining--;
    const attempt = REPAIR_ATTEMPTS - node.repairsRemaining;
    seam.host.driver.respondToSubmit(instance, { kind: "reject", violations });
    seam.host.record({ type: "node-repairing", instance, attempt, violations });
    return;
  }
  seam.host.driver.cancelAsk(instance);
  seam.settleFailed(
    node,
    new WorkflowError(
      "ValidationFailed",
      "submit_result failed schema validation repeatedly and the repair budget is exhausted.",
      { violations },
    ),
  );
}

/**
 * 宽松归一化 submit payload：先按原值校验；仅当原值不过、且原值是 string 时，做一次 JSON.parse
 * 再校验，成功则以解析后的值为准（既回裁决也落 journal）。
 *
 * 实盘发现（GLM-5.3 经 Anthropic 兼容端点）：真实模型常把 submit_result 的 `result` 参数序列化成
 * JSON 字符串（如 `"{\"title\":...}"`）而非 JSON 对象，导致校验器正确报「expected object, got string」、
 * repair 3 次后 run 失败。legacy script-workflow 的 parseStructuredResponse 早以宽松 JSON 解析容忍此
 * 情形；此处补上同等容忍，但 schema-aware：
 *   1. 原值直接过 → 用原值，绝不解析（保住合法的 string 结果，如 `string | null` schema，`"42"` 须留 `"42"`）。
 *   2. 原值不过且是 string → 单次 JSON.parse（不递归、不双解析，沿用 legacy 单次抽取先例）后再校验，过则取解析值。
 *   3. 否则 → 回原值 + 原始违规，交模型 repair。
 * 引擎是纯包，JSON.parse 纯确定、无 I/O，放这里安全。
 */
function normalizeSubmit(
  host: SchedulerHost,
  schema: unknown,
  payload: unknown,
): { value: unknown; violations: Violation[] } {
  const direct = host.validate(schema, payload);
  if (direct.length === 0) return { value: payload, violations: [] };
  if (typeof payload === "string") {
    try {
      const parsed = JSON.parse(payload);
      const after = host.validate(schema, parsed);
      if (after.length === 0) return { value: parsed, violations: [] };
      // bug：解析成功但解析值仍不过时，曾上报解析前的
      // `direct` 违规（"$: expected object, got string"），模型面对的其实是已解码对象，无从修起，
      // 只能反复重引号/双重编码/退化成 "{}"，耗尽 repair 预算。修复违规必须描述模型可修改的值，
      // 故此处返回 `after`（解析后对象上的路径级违规），单次解析契约不变。
      return { value: parsed, violations: after };
    } catch {
      // 非 JSON 字符串：JSON.parse 抛出，回落到原值违规，交模型 repair。
    }
  }
  return { value: payload, violations: direct };
}

export function handleTurnEnded(seam: SubmitSeam, instance: InstanceRef, finalText: string): void {
  const node = seam.liveNode(instance);
  if (node === undefined || node.settled) return;
  if (!node.spec.typed) {
    seam.settleOk(node, finalText);
    return;
  }
  if (node.nudgesRemaining > 0) {
    node.nudgesRemaining--;
    seam.host.driver.respondToSubmit(instance, { kind: "nudge" });
    seam.host.record({ type: "node-nudged", instance });
    return;
  }
  seam.host.driver.cancelAsk(instance);
  seam.settleFailed(
    node,
    new WorkflowError(
      "ResultNotSubmitted",
      "The typed ask ended without a submit_result call, so there is no result.",
      { finalText },
    ),
  );
}

/**
 * 结算写入失败时合成的失败原因：把「哪个节点的哪一次写入失败、为什么」一并说清。
 *
 * original 在场时是本次 ask 本身的失败原因（例如 typed ask 未提交判的
 * ResultNotSubmitted），journal 写错因是后来叠加的；两者都要保留——只报后者会让
 * 脚本以为 merely 记账问题而重试同一个注定失败的值，只报前者则掩盖了 run 已无法
 * 持久化节点这一更严重的事实。cause 链同时携带原始 Error，诊断面不丢下层堆栈。
 */
export function journalWriteFailedError(
  cause: unknown,
  node: AskNode,
  failedWrite: "completed" | "failed",
  original?: WorkflowError,
): WorkflowError {
  const where = refToString(node.instance);
  const causeText = cause instanceof Error ? cause.message : String(cause);
  const message =
    original === undefined
      ? `Failed to persist the result of the subagent ask at ${where}: ${causeText}`
      : `Failed to persist the failure of the subagent ask at ${where} (${original.message}): ${causeText}`;
  return new WorkflowError("DriverError", message, {
    cause: original ?? cause,
    ...(failedWrite === "failed" && original !== undefined
      ? { violations: original.violations }
      : {}),
  });
}

/**
 * 把一次结算落进 journal 行与事件流（settleOk / settleFailed 共用）。
 *
 * undefined = 落库成功；否则返回合成的失败原因（cause 链携带原始写入错误）。
 *
 * journal 落库/事件记录失败（磁盘满、锁竞争、IO 错误）不得让 ask 悬空：此前调用方
 * 直接 journal.putNode 且无 try/catch，一旦抛出 deferred 永不兑现、finishLiveNode
 * 不跑、activeAsks 不减——子进程在 await ask(...) 上永久等待 response，run 永不
 * 结算；生产 launch 不设墙钟超时，唯一出口是用户手动取消。这正是「所有智能体
 * 已完成而界面永远卡住」的断链点（判别实验见
 * test/journalWriteFailureSettlement.test.ts）。
 */
export function persistNodeSettlement(
  seam: SubmitSeam,
  node: AskNode,
  outcome: { status: "completed"; result: unknown } | { status: "failed"; error: NodeRecord["error"] },
  original?: WorkflowError,
): WorkflowError | undefined {
  try {
    seam.host.driver.journal.putNode(nodeRecordFor(seam, node, outcome));
    seam.host.record({
      type: "node-settled",
      instance: node.instance,
      ...(outcome.status === "completed"
        ? { outcome: "ok" as const }
        : { outcome: "failed" as const, error: outcome.error }),
    });
    return undefined;
  } catch (cause) {
    node.settled = false;
    return journalWriteFailedError(
      cause,
      node,
      outcome.status === "completed" ? "completed" : "failed",
      original,
    );
  }
}

function nodeRecordFor(
  seam: SubmitSeam,
  node: AskNode,
  outcome: { status: "completed"; result: unknown } | { status: "failed"; error: NodeRecord["error"] },
): NodeRecord {
  const record: NodeRecord = {
    runId: seam.host.runId,
    siteId: node.instance.siteId,
    ordinal: node.instance.ordinal,
    kind: "ask",
    actorSiteId: node.actor.ref.siteId,
    actorOrdinal: node.actor.ref.ordinal,
    actorSeq: node.actorSeq,
    inputHash: node.hash,
    status: outcome.status,
  };
  if (outcome.status === "completed") record.result = outcome.result;
  else record.error = outcome.error;
  if (node.lastStats !== undefined) record.stats = node.lastStats;
  return record;
}