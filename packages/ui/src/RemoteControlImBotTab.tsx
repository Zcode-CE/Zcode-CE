import { useCallback, useMemo, useState } from "react";
import { Bot as BotIcon, TriangleAlertIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  REMOTE_CONTROL_IM_BOT_BADGE_TEST_ID,
  REMOTE_CONTROL_IM_BOT_CONFIRM_TEST_ID,
  REMOTE_CONTROL_IM_BOT_ENABLE_TEST_ID,
  REMOTE_CONTROL_IM_BOT_NOTICE_TEST_ID,
  REMOTE_CONTROL_IM_BOT_REMINDER_MESSAGE_IDS,
  REMOTE_CONTROL_IM_BOT_RESTART_NOTICE_MESSAGE_ID,
  REMOTE_CONTROL_IM_BOT_RESTART_NOTICE_TEST_ID,
  REMOTE_CONTROL_IM_BOT_TEST_ID,
  resolveRemoteControlImBotView,
  type RemoteControlImBotChannel,
  type RemoteControlImBotState,
} from "@/remoteControlPanelModel.js";

/**
 * 「IM 机器人」标签页（task-93）。
 *
 * 这是与「Web 控制」**并列的另一条远控路径**，不是它的替代品：
 * 那条是"在这台机器上起服务、浏览器连进来"，这条是"把聊天软件当工作区前端"。
 * 两者的问题不同、可执行的层面也不同（用户原话），所以命名必须让人一眼看出是两件事。
 *
 * 四条纪律：
 * - **纯 props 驱动**：通道由调用方注入（`imBot`），本组件不读服务、不订阅 IPC ——
 *   与 Web 面同一纪律，因此能在真浏览器里用注入态渲染并做 DOM 断言。
 * - **默认关闭由状态承载，不是靠"没有按钮"**（Lead 拍板）：通道未注入时**照样渲染「启用」**，
 *   否则"同步上游入口"等于只多了一页说明（用户原则：不能少东西）。这与切片 1 同一先例 ——
 *   入口先渲染、动作待接线，**如实标注**而不是藏起来。
 * - **不许静默**：点击 → 确认弹窗（三条事实）→ 确认后立刻进入 `enabling`，
 *   结算后落到 `requested`（"已请求启用，等待服务端就绪"）。任何一步都有可见结果。
 * - **提醒常显**：三条事实在任何状态下都在页面上，不藏在 tooltip 或"了解更多"里。
 * - 生效时机单独一条（spec §10 P4）：新增/启用渠道要重启服务才生效，删除渠道立即生效。
 *   它与上面三条并列常显，但不属于那个列表 —— 三条讲的是把消息交给第三方平台的代价，
 *   这一条讲的是"配置什么时候起作用"（可操作信息），混在一起会让人读不出该做什么。
 */
export interface RemoteControlImBotTabProps {
  /**
   * 调用方注入的通道。**未注入 ≠ 不渲染按钮** —— 未注入表示"服务端能力尚未接入"，
   * 此时仍然渲染「启用」，但页面上如实说明现在启用只会记下请求（见 model 的 pendingServer 档）。
   */
  channel?: RemoteControlImBotChannel | null;
  className?: string;
}

const BADGE_VARIANT: Record<RemoteControlImBotState, "secondary" | "outline"> = {
  disabled: "outline",
  enabling: "secondary",
  requested: "secondary",
  enabled: "secondary",
};

export function RemoteControlImBotTab({ channel, className }: RemoteControlImBotTabProps) {
  const { intl } = useZCodeIntl();
  const t = useCallback((id: string) => intl.formatMessage({ id }), [intl]);

  // 两个**渲染进程本地**标记，与 Web 面 `inFlight` 同一机制：面板不伪造宿主状态。
  // `requested` 存在的理由：宿主今天还没有服务端可回传 `status`，若不记住"已经请求过"，
  // 用户点完确认会看到按钮重新出现 —— 那是静默无反应，正是要避免的形态。
  const [inFlight, setInFlight] = useState(false);
  const [requested, setRequested] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const view = useMemo(
    () => resolveRemoteControlImBotView({ channel, inFlight, requested }),
    [channel, inFlight, requested],
  );

  const confirmEnable = useCallback(async () => {
    setConfirmOpen(false);
    setRequested(true);
    setInFlight(true);
    try {
      // 通道缺席时也**不静默**：仍然进入 enabling → requested 的可见状态链，
      // 页面上另有 pendingServer 说明"现在启用只会记下请求"。
      await channel?.onEnable();
    } finally {
      // 无论宿主是否回传状态，都在途标记必须落地 —— 停在"启用中"会让用户以为卡住了。
      setInFlight(false);
    }
  }, [channel]);

  return (
    <div
      data-testid={REMOTE_CONTROL_IM_BOT_TEST_ID}
      // 机器可读的状态：DOM 断言按它判定（与 Web 面 `data-remote-control-branch` 同一办法）。
      data-remote-control-im-bot-state={view.state}
      className={cn("flex min-h-0 flex-col gap-4", className)}
    >
      <section className="flex flex-wrap items-center gap-2">
        <Badge
          data-testid={REMOTE_CONTROL_IM_BOT_BADGE_TEST_ID}
          data-remote-control-im-bot-badge={view.state}
          variant={BADGE_VARIANT[view.state]}
        >
          {t(view.badgeMessageId)}
        </Badge>
        <p className="min-w-0 flex-1 text-ui-base text-foreground-subtle">
          {t("remotePanel.imBot.description")}
        </p>
        {view.showEnableAction ? (
          <Button
            type="button"
            size="lg"
            data-testid={REMOTE_CONTROL_IM_BOT_ENABLE_TEST_ID}
            // 粗指针（手机/平板）命中区 ≥44：与 Web 面主操作同一机制（只按 pointer:coarse）。
            className="[@media(pointer:coarse)]:min-h-11"
            onClick={() => setConfirmOpen(true)}
          >
            <BotIcon className="size-3.5" />
            {t("remotePanel.imBot.action.enable")}
          </Button>
        ) : null}
      </section>

      {/* 状态说明：只在需要解释时出现（默认关闭时提醒块已经说清楚了，不重复一遍）。 */}
      {view.stateMessageId ? (
        <p
          data-remote-control-im-bot-state-note={view.state}
          className="text-ui-base text-foreground-subtle"
        >
          {t(view.stateMessageId)}
        </p>
      ) : null}

      {/* 提醒块：**常显**，与状态无关 —— 它回答的是"启用前要知道什么"，不是"当前怎么了"。 */}
      <section
        data-testid={REMOTE_CONTROL_IM_BOT_NOTICE_TEST_ID}
        className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface px-3 py-2"
      >
        <span className="flex items-center gap-1.5 text-ui-base font-medium text-foreground">
          <TriangleAlertIcon className="size-4 shrink-0 text-[var(--color-warning)]" />
          {t("remotePanel.imBot.reminder.title")}
        </span>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-ui-base text-foreground-subtle">
          {REMOTE_CONTROL_IM_BOT_REMINDER_MESSAGE_IDS.map((id) => (
            <li key={id}>{t(id)}</li>
          ))}
        </ul>
        {/* 生效时机：与提醒块同一容器（同属"启用前须知"），但独立一行 —— 见文件头的分组理由。 */}
        <p
          data-testid={REMOTE_CONTROL_IM_BOT_RESTART_NOTICE_TEST_ID}
          className="mt-1 border-t border-border pt-1.5 text-ui-base text-foreground-subtle"
        >
          {t(REMOTE_CONTROL_IM_BOT_RESTART_NOTICE_MESSAGE_ID)}
        </p>
      </section>

      <ImBotEnableConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onConfirm={() => void confirmEnable()}
      />
    </div>
  );
}

/**
 * 启用前确认弹窗。
 *
 * 为什么必须是**弹窗**而不是"页面上已经写了提醒就够了"：提醒块是常驻信息，
 * 而这是一个**不可逆的对外动作**（凭据签发在第三方、消息开始外发）。
 * 与 Web 面「首次对局域网开放」的确认同一形态（`remotePanel.confirm.startLan.*`）：
 * 把代价放在动作**之前**，而不是事后。
 *
 * 与 Web 面同一处刻意选择：**不走 `confirmDialogStore`** —— 那是全局单例、
 * 同时只允许一个待决请求，而本组件需要持有"确认后要做什么"的局部状态。
 */
function ImBotEnableConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid={REMOTE_CONTROL_IM_BOT_CONFIRM_TEST_ID}
        showCloseButton={false}
        className="sm:max-w-md"
      >
        <DialogHeader className="gap-2">
          <DialogTitle className="text-ui-lg font-semibold text-foreground">
            {t("remotePanel.imBot.confirm.title")}
          </DialogTitle>
          <DialogDescription className="pt-0.5 text-ui-base leading-6 text-foreground-subtle">
            {t("remotePanel.imBot.confirm.body")}
          </DialogDescription>
        </DialogHeader>
        {/* 三条事实在弹窗里**再列一次**：确认的那一刻用户眼里只有这个弹窗。 */}
        <ul className="flex list-disc flex-col gap-1 pl-5 text-ui-base text-foreground-subtle">
          {REMOTE_CONTROL_IM_BOT_REMINDER_MESSAGE_IDS.map((id) => (
            <li key={id}>{t(id)}</li>
          ))}
        </ul>
        <DialogFooter className="gap-2 sm:justify-end">
          <Button type="button" variant="secondary" size="lg" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="button" size="lg" onClick={onConfirm}>
            {t("remotePanel.imBot.confirm.continue")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
