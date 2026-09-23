// 引导式授权（ENH-2）的壳层投递实现：「发送到终端」这个动作的唯一执行点。
//
// 事件顺序（每个异步跳都必须有确定的所有者，否则就是"点了没反应"）：
//
//   用户点按钮
//     → enqueue(workspaceKey, text)            ← 待投递文本入单槽，覆盖旧的
//     → 已有就绪终端？ ── 是 ─→ take() → deliver() → toast 结果
//                      └─ 否 ─→ openTerminalTab()
//                                → （TerminalSession 在 onData 接线后注册目标）
//                                → subscribe 回调触发 → take() → deliver() → toast 结果
//     → 兜底：OPEN_TERMINAL_GRACE_MS 内没有目标注册 ⇒ 明确提示，不留静默失败
//
// 为什么需要"待投递"这一跳而不是直接 paste：侧栏终端首次打开时，registry entry 是同步
// register 的，但 term.onData 要等 terminalService.create() 的 .then() 才接线。
// 在两者之间 paste，字节会写进没有订阅者的 xterm 而静默丢失（见 guidedTerminalDelivery.ts 头注释）。

import { useCallback, useEffect, useRef } from "react";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  deliverGuidedTerminalCommand,
  enqueueGuidedTerminalDelivery,
  findGuidedTerminalTargetKey,
  hasPendingGuidedTerminalDelivery,
  subscribeGuidedTerminalTargets,
  takePendingGuidedTerminalDelivery,
  type GuidedTerminalDeliveryOutcome,
} from "@/lib/guidedTerminalDelivery.js";
import type { GuidedTerminalSendHandler } from "@/lib/guidedTerminalSendContext.js";

/**
 * 打开终端后等待其就绪的上限。超时即判定"打不开"，明确提示用户 ——
 * 这是「按钮点了但没终端可投递」这一边界情况的执行点，不允许静默失败。
 */
const OPEN_TERMINAL_GRACE_MS = 4_000;

/** 归一化文本是否多行。与 resolveGuidedTerminalCommand 的 plan.multiline 同源同判据。 */
function isMultilineGuidedTerminalText(text: string): boolean {
  return text.includes("\n");
}

export function useGuidedTerminalSend(params: {
  workspaceKey: string;
  /** 打开一个新的侧栏终端 tab（useAppPanels.handleOpenTerminalTab）。 */
  openTerminalTab: () => void;
}): GuidedTerminalSendHandler {
  const { workspaceKey, openTerminalTab } = params;
  const { intl } = useZCodeIntl();
  const graceTimerRef = useRef<number | null>(null);

  const clearGraceTimer = useCallback(() => {
    if (graceTimerRef.current !== null) {
      window.clearTimeout(graceTimerRef.current);
      graceTimerRef.current = null;
    }
  }, []);

  const reportOutcome = useCallback(
    (outcome: GuidedTerminalDeliveryOutcome) => {
      if (outcome === "delivered") {
        // 成功路径用 info 日志 + 轻提示：用户需要在终端里自己按回车，提示要留住这个语义。
        logger.info("[GuidedTerminal] 命令已发送到集成终端", { workspaceKey });
        toast(intl.formatMessage({ id: "codeBlock.sendToTerminalDelivered" }), {
          position: "bottom-left",
        });
        return;
      }
      if (outcome === "bracketed-paste-required") {
        logger.info("[GuidedTerminal] 终端未启用括号粘贴，拒绝多行投递", { workspaceKey });
        toast(intl.formatMessage({ id: "codeBlock.sendToTerminalNeedsBracketedPaste" }), {
          variant: "warning",
          position: "bottom-left",
        });
        return;
      }
      logger.info("[GuidedTerminal] 无可投递终端", { workspaceKey });
      toast(intl.formatMessage({ id: "codeBlock.sendToTerminalUnavailable" }), {
        variant: "warning",
        position: "bottom-left",
      });
    },
    [intl, workspaceKey],
  );

  /** 有待投递文本且目标已就绪时落投递。取走即删，保证只投一次。 */
  const flushPendingDelivery = useCallback(() => {
    const now = Date.now();
    if (!hasPendingGuidedTerminalDelivery(workspaceKey, now)) {
      return;
    }
    const key = findGuidedTerminalTargetKey(workspaceKey);
    if (!key) {
      return;
    }
    const pending = takePendingGuidedTerminalDelivery({ workspaceKey, now });
    if (!pending) {
      return;
    }
    clearGraceTimer();
    reportOutcome(
      deliverGuidedTerminalCommand({
        key,
        text: pending.text,
        multiline: isMultilineGuidedTerminalText(pending.text),
      }),
    );
  }, [clearGraceTimer, reportOutcome, workspaceKey]);

  useEffect(() => {
    // 挂载 / 切换 workspace 时先补一次：投递可能发生在组件重挂之前。
    flushPendingDelivery();
    return subscribeGuidedTerminalTargets(flushPendingDelivery);
  }, [flushPendingDelivery]);

  useEffect(() => clearGraceTimer, [clearGraceTimer]);

  return useCallback(
    (request) => {
      enqueueGuidedTerminalDelivery({
        workspaceKey,
        text: request.plan.text,
        now: Date.now(),
      });

      if (findGuidedTerminalTargetKey(workspaceKey)) {
        flushPendingDelivery();
        return;
      }

      // 没有就绪终端：开一个，然后等 subscribe 回调把投递落下去。
      // 终端 tab 是异步创建 PTY 的，所以这里不能同步 paste —— 那会静默丢失。
      openTerminalTab();
      clearGraceTimer();
      graceTimerRef.current = window.setTimeout(() => {
        graceTimerRef.current = null;
        // 超时仍未就绪：pending 还在，说明终端始终没起来。
        // 明确提示并清掉 pending，避免用户早已忘记的命令在几分钟后突然粘进终端。
        if (!hasPendingGuidedTerminalDelivery(workspaceKey, Date.now())) {
          return;
        }
        takePendingGuidedTerminalDelivery({ workspaceKey, now: Date.now() });
        logger.warn("[GuidedTerminal] 打开终端后未在限期内就绪", { workspaceKey });
        toast(intl.formatMessage({ id: "codeBlock.sendToTerminalOpenFailed" }), {
          variant: "warning",
          position: "bottom-left",
        });
      }, OPEN_TERMINAL_GRACE_MS);
    },
    [clearGraceTimer, flushPendingDelivery, intl, openTerminalTab, workspaceKey],
  );
}
