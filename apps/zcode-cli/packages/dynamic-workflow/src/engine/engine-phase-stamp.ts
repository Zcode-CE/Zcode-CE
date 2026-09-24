/**
 * 实例出生阶段的读取与标记。
 * 两类读取共用 `instancePhases`（实例 `siteId@ordinal` → 出生时的阶段名）：
 * 为事件补充阶段，以及为 `ProviderStop` 明细补充阶段。
 * 表由引擎拥有并在实例创建时写入；本模块只读取。
 *
 * Modified by ZCode: 上游版本还给 ask 的 `node-dispatched` 补 `phaseName` / `actorPhaseName`
 * （那条事件在上游会**重复自己的出生事实**，见 types.ts 的 `node-dispatched`）。本仓库的
 * `node-dispatched` 目前仍只带 `instance`，调度器也只发这一个形状，所以这里去掉那个分支
 * ——留一段读不到字段的死代码只会让「本端支持什么」变得不可信。等 C3（大 workflow 实时状态）
 * 把出生事实搬进 `node-dispatched` 时，把那个分支一并恢复即可。
 */

import type { RunEvent } from "./types.js";
import { refToString, WorkflowError } from "./types.js";

/** 实例键（`siteId@ordinal`）→ 它出生时的阶段名。引擎的 `instancePhases` 的只读视图。 */
export type InstancePhases = ReadonlyMap<string, string>;

/**
 * 给**出生事件**补上出生阶段：actor 的 `actor-created` 按 actor 查表，节点的 `node-queued`
 * 按 instance 查表，命中缓存的 `node-settled { cached: true }` 同样按 instance——命中的节点
 * 没有 queued，那条 settle 就是它的出生事件。其余事件**原样返回**：调度器的其余发射点零改动，
 * reducer 沿用 `actorSiteId` 的先例向前携带。
 *
 * 它不是「发出这条事件时的当前阶段」：node-queued 可能被 hold 规则推迟到下一个标记之后才发出，
 * 而出生时刻在上一个阶段；派发更是可能卡在并发上界后面，等到脚本已走过好几个标记。
 */
export function stampBirthPhase(event: RunEvent, instancePhases: InstancePhases): RunEvent {
  if (event.type === "actor-created") {
    const phaseName = instancePhases.get(refToString(event.actor));
    return phaseName === undefined ? event : { ...event, phaseName };
  }
  if (event.type === "node-queued") {
    const phaseName = instancePhases.get(refToString(event.instance));
    return phaseName === undefined ? event : { ...event, phaseName };
  }
  if (event.type === "node-settled" && event.cached === true) {
    const phaseName = instancePhases.get(refToString(event.instance));
    return phaseName === undefined ? event : { ...event, phaseName };
  }
  return event;
}

/**
 * 给 `ProviderStop` 补上触发停止的子代理的**出生阶段**：driver 只知道 actor ref，阶段只有引擎知道（与事件流上 `phaseName`
 * 的同一张表）。没有 providerStop、没有 subagent、已带阶段、或该 ref 出生在任何 `phase()`
 * 标记之前 → 原样返回。
 */
export function enrichProviderStopPhase(
  error: WorkflowError,
  instancePhases: InstancePhases,
): WorkflowError {
  const details = error.providerStop;
  if (details === undefined || details.subagent === undefined || details.phase !== undefined) {
    return error;
  }
  const phase = instancePhases.get(details.subagent);
  if (phase === undefined) return error;
  return new WorkflowError(error.code, error.message, {
    providerStop: { ...details, phase },
    cause: (error as { cause?: unknown }).cause,
  });
}
