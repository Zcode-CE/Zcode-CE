/**
 * 领取成功票券卡片：claim 成功后自画的一张票券。
 *
 * ## 为什么自画而不是嵌官方渲染物
 *
 * 官方那张票券是服务端下发的 bundle（marketing/touch 的 delivery.banner.success_popup.hero），
 * 由 iframe 沙箱渲染。搬它要同时搬 marketing/touch 与 cloud-content 两条链路（CE 全仓 0 命中），
 * 而票券上的每一个事实都能由 preview 加 claim 客户端算出。规格与字段对照见
 * .reverse/94-account-capability/C-SUCCESS-TICKET.md；算法依据见
 * .reverse/94-account-capability/BANNER-BUNDLE-ANALYSIS.md。
 *
 * ## 状态所有者
 *
 * 本组件不持有领取状态：`plan` 是 useManualClaimPlan 里的 claim 前快照，
 * `endsAt` 来自 claim 响应。组件只持有一个局部状态 —— 重播动画序号。
 *
 * ## 边界
 *
 * - 快照在手即渲染，不看刷新后的 plans（活动领取后可能已从列表消失）；
 * - 快照取不到时调用方不渲染本组件，退回成功文案，不画半张票券；
 * - 无 endsAt 时不渲染有效期行（官方会显示破折号，实测真实载荷 ends_at 恒有）；
 * - 生效时间行只在权益尚未生效时显示（已生效还写「将于 X 生效」是假话）。
 *
 * ## 不做 Share
 *
 * 官方 Share 的 URL 由服务端 buttons[].action 下发（客户端无烧死常量），点击还会触发
 * 营销埋点上报。伪造站外链接不可接受，因此本组件不提供站外分享。
 */
import { useMemo, useState } from "react";
import { GiftIcon, RotateCcwIcon } from "lucide-react";
import type { ManualClaimPlanPreview } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { buildManualClaimTicket } from "./manualClaimTicket.js";

export function ManualClaimTicketCard({
  plan,
  endsAt,
  onDismiss,
}: {
  plan: ManualClaimPlanPreview;
  endsAt?: number;
  onDismiss: () => void;
}) {
  const { intl, locale } = useZCodeIntl();
  // 重播序号只做一件事：改 key 让票券重挂载，入场动画重新播一遍。
  const [replaySeq, setReplaySeq] = useState(0);
  const ticket = useMemo(
    () => buildManualClaimTicket({ plan, endsAt, locale, nowMs: Date.now() }),
    [plan, endsAt, locale],
  );
  const validUntil = intl.formatMessage({
    id: "settings.modelProvider.manualClaim.ticket.validUntil",
  });
  const replayLabel = intl.formatMessage({
    id: "settings.modelProvider.manualClaim.ticket.replay",
  });
  return (
    <div
      className="rounded-xl border border-border bg-surface p-4"
      data-testid="manual-claim-ticket"
    >
      <div key={replaySeq} className="animate-in fade-in slide-in-from-bottom-2 duration-300">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-1.5">
            <GiftIcon className="size-3.5 shrink-0 text-foreground-subtle" aria-hidden="true" />
            <h3
              className="min-w-0 truncate text-ui-base font-semibold text-foreground"
              data-testid="manual-claim-ticket-plan-name"
            >
              {ticket.planName}
            </h3>
          </div>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={replayLabel}
            data-testid="manual-claim-ticket-replay"
            onClick={() => setReplaySeq((current) => current + 1)}
          >
            <RotateCcwIcon />
          </Button>
        </div>
        <p className="mt-2 text-ui-sm text-success" data-testid="manual-claim-ticket-title">
          {intl.formatMessage({ id: "settings.modelProvider.manualClaim.success" })}
        </p>
        <div className="mt-3 flex min-w-0 items-baseline gap-1.5">
          <span
            className="min-w-0 truncate text-ui-xl font-semibold tabular-nums text-foreground"
            data-testid="manual-claim-ticket-amount"
          >
            {ticket.amountValue}
          </span>
          {ticket.amountUnit ? (
            <span
              className="shrink-0 text-ui-sm font-medium text-foreground-subtle"
              data-testid="manual-claim-ticket-unit"
            >
              {ticket.amountUnit}
            </span>
          ) : null}
        </div>
        {ticket.benefits.length > 0 ? (
          <ul className="mt-2 space-y-1" data-testid="manual-claim-ticket-benefits">
            {ticket.benefits.map((benefit) => (
              <li
                key={benefit}
                className="flex min-w-0 items-center gap-1.5 text-ui-sm text-foreground-subtle"
              >
                <GiftIcon className="size-3 shrink-0" aria-hidden="true" />
                <span className="min-w-0 truncate">{benefit}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {ticket.effectiveAtEntries.length > 0 ? (
          <ul className="mt-2 space-y-1" data-testid="manual-claim-ticket-effective">
            {ticket.effectiveAtEntries.map((entry) => (
              <li
                key={entry.entitlementId}
                className="min-w-0 truncate text-ui-sm text-foreground-subtle"
              >
                {intl.formatMessage(
                  { id: "settings.modelProvider.manualClaim.ticket.effectiveAt" },
                  { name: entry.showName, time: entry.label },
                )}
              </li>
            ))}
          </ul>
        ) : null}
        {ticket.endsAtLabel ? (
          <p className="mt-3 flex min-w-0 items-baseline gap-1.5 border-t border-border pt-2 text-ui-sm text-foreground-subtle">
            <span className="shrink-0">{validUntil}</span>
            <time
              className="min-w-0 truncate font-semibold tabular-nums"
              data-testid="manual-claim-ticket-ends-at"
            >
              {ticket.endsAtLabel}
            </time>
          </p>
        ) : null}
      </div>
      <div className="mt-3 flex justify-end">
        <Button
          type="button"
          size="lg"
          variant="outline"
          data-testid="manual-claim-ticket-dismiss"
          onClick={onDismiss}
        >
          {intl.formatMessage({ id: "settings.modelProvider.manualClaim.ticket.dismiss" })}
        </Button>
      </div>
    </div>
  );
}
