// 引导式授权（ENH-2）的投递状态所有者。
//
// 职责边界（唯一所有者）：
//   - 谁"可以接收投递"：由 side pane terminal 的 TerminalSession 在 **onData 接线完成后** 注册；
//   - 待投递文本：按 workspaceKey 单槽暂存，供"刚打开终端、PTY 还没就绪"这一跳使用；
//   - 变更通知：终端就绪/注销时通知订阅者，由壳层决定何时真正粘贴并提示用户。
//
// 为什么需要"就绪"这个概念，而不是直接查 sidePaneTerminalSessionRegistry：
//   registry 的 entry 在 effect 里**同步** register，但 term.onData 是在
//   terminalService.create() 的 .then() 里才接线的（见 TerminalSession.tsx 的 persistentKey 路径）。
//   在 register 与 onData 之间调用 term.paste()，字节会写进一个没有订阅者的 xterm —— 静默丢失。
//   所以"可用"的判据必须是 onData 已接线，而不是 entry 已存在。
//
// 本模块不碰 React、不碰服务、不自己起定时器：TTL 判定用调用方传入的 now，
// 因此整条状态机可以在 node:test 下穷尽覆盖（见 packages/ui/test/guidedTerminalDelivery.test.ts）。

/** 待投递文本的存活上限。超时后不再投递，避免用户早已忘记的那条命令在几分钟后被粘进终端。 */
export const GUIDED_TERMINAL_DELIVERY_TTL_MS = 15_000;

export type GuidedTerminalDeliveryOutcome =
  /** 已写入终端输入缓冲，等用户按回车。 */
  | "delivered"
  /** 目标终端未注册或已注销。 */
  | "target-unavailable"
  /** 多行文本但终端未启用括号粘贴，投递会被 shell 逐行立即执行 ⇒ 拒绝。 */
  | "bracketed-paste-required";

interface GuidedTerminalTarget {
  workspaceKey: string;
  /** 把文本交给 xterm paste。返回 false 表示该会话已不可用。 */
  paste: (text: string) => boolean;
  /** 会话当前的括号粘贴（DECSET 2004）状态；多行投递的放行条件。 */
  isBracketedPasteMode: () => boolean;
}

export interface PendingGuidedTerminalDelivery {
  workspaceKey: string;
  text: string;
  enqueuedAt: number;
}

/** key = side pane terminal tab id（= TerminalSession 的 persistentKey）。 */
const targets = new Map<string, GuidedTerminalTarget>();
/** key = workspaceKey；同一 workspace 只保留最后一次待投递文本。 */
const pendingDeliveries = new Map<string, PendingGuidedTerminalDelivery>();
const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

/**
 * 订阅"可投递目标集合发生变化"。壳层用它把待投递文本落到刚就绪的终端上。
 * 返回退订函数；退订是幂等的。
 */
export function subscribeGuidedTerminalTargets(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 注册一个可投递终端。**必须在 term.onData 接线之后调用**（否则投递静默丢失）。
 * 返回注销函数；同一个 key 重复注册会覆盖前一个（重挂场景）。
 */
export function registerGuidedTerminalTarget(params: {
  key: string;
  workspaceKey: string;
  paste: (text: string) => boolean;
  isBracketedPasteMode: () => boolean;
}): () => void {
  targets.set(params.key, {
    workspaceKey: params.workspaceKey,
    paste: params.paste,
    isBracketedPasteMode: params.isBracketedPasteMode,
  });
  emitChange();

  return () => {
    // 只有当前登记仍是本次注册的实例时才注销：重挂会先注册新实例再跑旧 cleanup，
    // 无脑 delete 会把刚登记的新实例删掉，该 workspace 之后再也投递不进去。
    if (targets.get(params.key)?.paste !== params.paste) {
      return;
    }
    targets.delete(params.key);
    emitChange();
  };
}

/** 找一个属于该 workspace、当前可投递的终端 key；没有则返回 null。 */
export function findGuidedTerminalTargetKey(workspaceKey: string): string | null {
  for (const [key, target] of targets) {
    if (target.workspaceKey === workspaceKey) {
      return key;
    }
  }
  return null;
}

/**
 * 把文本投递给指定终端。这是投递的唯一出口 —— 所有放行条件都在这里收口，
 * 调用方不需要（也不应该）各自判断一次。
 */
export function deliverGuidedTerminalCommand(params: {
  key: string;
  text: string;
  multiline: boolean;
}): GuidedTerminalDeliveryOutcome {
  const target = targets.get(params.key);
  if (!target) {
    return "target-unavailable";
  }
  if (params.multiline && !target.isBracketedPasteMode()) {
    return "bracketed-paste-required";
  }
  return target.paste(params.text) ? "delivered" : "target-unavailable";
}

/** 暂存待投递文本（单槽，后写覆盖先写）。 */
export function enqueueGuidedTerminalDelivery(params: {
  workspaceKey: string;
  text: string;
  now: number;
}): void {
  pendingDeliveries.set(params.workspaceKey, {
    workspaceKey: params.workspaceKey,
    text: params.text,
    enqueuedAt: params.now,
  });
}

/** 是否仍有一条未过期、未取走的待投递文本。壳层用它做超时兜底提示。 */
export function hasPendingGuidedTerminalDelivery(workspaceKey: string, now: number): boolean {
  const pending = pendingDeliveries.get(workspaceKey);
  if (!pending) return false;
  if (now - pending.enqueuedAt > GUIDED_TERMINAL_DELIVERY_TTL_MS) {
    pendingDeliveries.delete(workspaceKey);
    return false;
  }
  return true;
}

/**
 * 取走待投递文本（取走即删除，保证只投递一次）。
 * 过期的条目会被丢弃并返回 null —— 这是"用户早已忘记的命令不得迟到"的执行点。
 */
export function takePendingGuidedTerminalDelivery(params: {
  workspaceKey: string;
  now: number;
}): PendingGuidedTerminalDelivery | null {
  if (!hasPendingGuidedTerminalDelivery(params.workspaceKey, params.now)) {
    return null;
  }
  const pending = pendingDeliveries.get(params.workspaceKey) ?? null;
  pendingDeliveries.delete(params.workspaceKey);
  return pending;
}

/** 测试专用：清空全部状态。 */
export function clearGuidedTerminalDeliveryForTest(): void {
  targets.clear();
  pendingDeliveries.clear();
  listeners.clear();
}
