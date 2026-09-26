// 切模型复位队列授权位：判据共用件（spec 130 §4.6；缺陷定案见 docs/development/127 §5.2 方案 A）。
//
// 缺陷：turn.failed 后若会话队列非空，v4 投影把 queue.autoDrain 置 false + pauseReason="error"
// （product-projection.ts:2279-2286），而任何切模型路径都不复位它，恢复只能靠用户点 UI 的
// 「恢复队列」按钮（SessionPane.tsx:3017 → queue.ts:137）。新会话初值为 true 故绕过，
// 用户观感因此是「切其他渠道的模型依旧报错，只能单开一个新会话」。
//
// 语义（spec 130 §4.6）：用户主动换渠道 = 表达「继续用这个会话」，因此清掉上一次失败造成的 held。
// 复位复用既有 setQueueAutoDrain 命令/API，不新建机制。
//
// 为什么是三条路径而不是一条：桌面 v4 Composer 切模型只改 renderer 草稿
// （useDraftConfigControl.ts:410 handleDraftSelectModel），真正生效在**下一次 sendText 携带
// modelSelection**（core turn-model.ts:40-71 applySubmissionExecutionState）；另外两条是
// legacy session/setModel（server-operations.ts:2675）与 v4 switchModelConfig
// （commands/handlers/model-config.ts:76）。三条路径共用本件，不复制实现。
import type { ModelSelection, TraceContext } from "@zcode/contracts";
import { sameModelSelection } from "@zcode/core";
import type { ZCodeApp } from "../app/types.js";

/**
 * 投影里 queue 授权位的只读视图。
 *
 * pauseReason 只存在于投影层（packages/shared/src/zcode-protocol-v4/snapshot.ts:222）；
 * core 侧只有 agent-runtime.ts:216 的 `queueAutoDrain` 布尔，不区分原因（127 §6.1 第 4 点）。
 * 因此「只复位 error/manual、不复位 stopped」这个区分必须在能读到投影的一侧做裁决，
 * 本件把裁决收在一处，由各调用点注入自己的投影读取函数。
 */
export interface QueueAutoDrainState {
  autoDrain: boolean;
  pauseReason?: "stopped" | "manual" | "error";
}

export interface HeldQueueResetLogger {
  info?(message: string, fields?: Record<string, unknown>): void;
}

/**
 * 仅这些原因造成的 held 由「切模型」清掉。
 *
 * - `error`：turn 失败（product-projection.ts:2284）——本缺陷的成因，必须复位。
 * - `manual`：用户经 setAutoDrain(false) 或 compact/auto-drain 失败造成的 held
 *   （product-projection.ts:3741）——spec §4.6 明确列入可复位集合。
 * - `stopped`：用户主动停止（product-projection.ts:2193）——必须保留，尊重用户停止意图。
 * - 缺省（旧快照/旧客户端未带该字段）：不复位（fail-closed）。宁可漏一次自动复位
 *   （用户仍可点「恢复队列」），也不能把用户主动停止的暂停队列误清掉。
 */
const RESETTABLE_PAUSE_REASONS: ReadonlySet<QueueAutoDrainState["pauseReason"]> = new Set([
  "error",
  "manual",
]);

/**
 * 判等包装：`sameModelSelection` 的 right 不可为空，这里补上「会话尚无选型」的分支。
 * left 为空 = 本次是会话的首次选型，按「变更」处理（用户确实表达了用这个模型的意图）。
 */
function sameSelectionForReset(
  left: ModelSelection | undefined,
  right: ModelSelection,
): boolean {
  return sameModelSelection(left, right);
}

/**
 * 「会话的模型选型发生变更 ⇒ 若队列 held 则复位」的唯一判据实现。
 *
 * 返回是否真的复位（供调用点/测试断言幂等）。四道门全过才写：
 * 1. 选型确实变更——同一选型的重复提交不复位，否则每次发消息都会翻转授权位、
 *    抖动 conversation revision 并触发无谓的 CAS 重试；
 * 2. 投影可读——读不到（无 publisher/冷恢复未水合）不复位，不猜；
 * 3. 队列确实 held（`autoDrain === false`）——本来就是 true 时是 no-op，不产生多余事件/revision；
 * 4. held 原因属于可复位集合（见 RESETTABLE_PAUSE_REASONS）。
 *
 * 调用时机由各路径保证：变更成功之后才调用（失败路径抛异常，根本到不了这里），
 * 避免掩盖失败原因。
 */
export async function resetHeldQueueAfterModelSelectionChange(params: {
  app: Pick<ZCodeApp, "setQueueAutoDrain">;
  sessionId: string;
  previousSelection: ModelSelection | undefined;
  /**
   * 本次已确定生效的目标选型。调用方必须先确认确实带着目标选型（sendText 无
   * `intent.modelSelection` 表示沿用会话现值，不构成变更），再调本函数——把「有没有目标选型」
   * 的判断留在调用方，是因为那取决于各路径的载荷形状，本件不该猜。
   */
  nextSelection: ModelSelection;
  readQueueState: () => QueueAutoDrainState | null;
  traceContext?: TraceContext;
  logger?: HeldQueueResetLogger;
}): Promise<boolean> {
  const { app, sessionId, previousSelection, nextSelection, readQueueState } = params;
  // 门 1：同选型重复提交不复位（幂等，防 revision 抖动）。
  if (sameSelectionForReset(previousSelection, nextSelection)) return false;
  // 门 2：投影不可得 ⇒ 不复位（宁可漏，不误清用户主动停止的暂停队列）。
  const queueState = readQueueState();
  if (!queueState) return false;
  // 门 3：队列本来就未 held ⇒ no-op。
  if (queueState.autoDrain) return false;
  // 门 4：只清 error/manual，保留 stopped 与未知原因。
  if (!RESETTABLE_PAUSE_REASONS.has(queueState.pauseReason)) return false;

  await app.setQueueAutoDrain(
    true,
    params.traceContext ? { traceContext: params.traceContext } : undefined,
  );
  params.logger?.info?.("v4 model switch resumed held queue", {
    nextModelId: nextSelection.modelId,
    nextProviderId: nextSelection.providerId,
    pauseReason: queueState.pauseReason,
    previousModelId: previousSelection?.modelId ?? null,
    previousProviderId: previousSelection?.providerId ?? null,
    sessionId,
  });
  return true;
}
