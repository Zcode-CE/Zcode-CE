import type { UserActionFeatureId } from "@/lib/userActionTraceCatalog.js";

// 上报已移除（P1）：原先这些字面量联合取自 shared 的 `RendererActionTraceAttributes`
// （rendererActionTrace 协议模块已随遥测删除）。此处内联等价字面量，保持本模块对
// 22 个业务调用点的类型契约不变 —— 它们现在只是「动作描述」的取值域，不再参与上报。

/**
 * 用户操作遥测包装器 —— **上报已停用，仅保留调用契约**。
 *
 * 背景：`runUserAction` / `runUserActionAsync` / `startUserAction` 被 **22 个业务文件**
 * 当作控制流包装器使用（设置页、发送、Git 菜单、队列面板……）。这些调用点本身没有错，
 * 错的是它们顺带把用户操作打点上报到官方服务。
 *
 * 处置：**保留全部导出名与签名，把实现降级为纯透传**——
 * - `runUserAction` / `runUserActionAsync` 只执行 `operation()`，成功/失败语义与原来完全一致
 *   （原来也只是「执行 operation，再按结果收尾一个 span」）。
 * - `startUserAction` 返回一个空句柄，所有收尾方法都是 no-op。
 *
 * 收益：**22 个业务文件零改动**，且删除上报后业务行为逐字不变（原来上报就是严格旁路，
 * 失败也不回压操作结果）。
 *
 * 已删除：`RendererUserActionTelemetry` 类（原上报实现）、`setUserActionTelemetry`、
 * `userActionTraceBootstrap.ts` 及其在 renderer main.tsx 的调用。
 */

export type UserActionTrigger =
  | "button"
  | "keyboard"
  | "shortcut"
  | "menu"
  | "switch"
  | "select"
  | "drag";
export type UserActionResultSource =
  | "local_commit"
  | "shared_settings"
  | "setting_service"
  | "platform_result"
  | "authority_ack"
  | "optimistic_projection";
export type UserActionWorkspaceKind = "local" | "remote";
export type UserActionRemoteKind = "ssh" | "wsl" | "docker" | "server";
export type UserActionAutomationKind = "scheduled" | "off_peak";
export type UserActionStateAfter = "enabled" | "disabled";
export type UserActionAdmissionResult =
  | "accepted"
  | "rejected"
  | "stale"
  | "duplicate"
  | "noop"
  | "not_applicable";

interface StartUserActionInput {
  featureId: UserActionFeatureId;
  action: string;
  trigger: UserActionTrigger;
  surface?: string;
  timeoutMs?: number;
  workspaceKind?: UserActionWorkspaceKind;
  remoteKind?: UserActionRemoteKind;
  automationKind?: UserActionAutomationKind;
}

export interface UserActionResult {
  resultSource?: UserActionResultSource;
  failureStage?: string;
  stateAfter?: UserActionStateAfter;
  configured?: boolean;
  requiresRestart?: boolean;
  sectionId?: string;
  valueAfter?: string;
  admissionResult?: UserActionAdmissionResult;
}

interface UserActionFailure extends UserActionResult {
  failureStage: string;
}

interface UserActionHandle {
  complete(result?: UserActionResult): void;
  fail(failure: UserActionFailure): void;
  reject(result?: UserActionResult): void;
  cancel(): void;
  noop(): void;
}

/** 停用上报后所有收尾动作都是 no-op；保留方法名以免 22 个调用点编译失败。 */
const NOOP_ACTION_HANDLE: UserActionHandle = {
  complete() {},
  fail() {},
  reject() {},
  cancel() {},
  noop() {},
};

/**
 * 入参保留（含 featureId/action/trigger），但不再被消费。
 * 之所以不删参数，是因为调用点仍按原样传入，签名必须稳定。
 */
export function startUserAction(_input: StartUserActionInput): UserActionHandle {
  return NOOP_ACTION_HANDLE;
}

export async function runUserActionAsync<T>(options: {
  input: StartUserActionInput;
  operation: () => Promise<T>;
  completed?: UserActionResult | ((value: T) => UserActionResult);
  failureStage: string;
}): Promise<T> {
  return options.operation();
}

export function runUserAction<T>(options: {
  input: StartUserActionInput;
  operation: () => T;
  completed?: UserActionResult | ((value: T) => UserActionResult);
  failureStage: string;
}): T {
  return options.operation();
}
