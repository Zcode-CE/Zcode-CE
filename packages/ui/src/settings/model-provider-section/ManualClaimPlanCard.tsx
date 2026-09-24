/**
 * 「可领取」套餐卡片：claim 平面的设置页入口。
 *
 * ## 产品规则
 *
 * - 只在服务端返回了可领取套餐时渲染（`plans.length > 0`）；无活动时完全不出现，
 *   不占位、不显示空态 —— 「当前没有可领的活动」不是用户需要处理的信息。
 *   这条只覆盖「查完了、服务端没有活动」；它不覆盖「我们自己没查到」。
 * - 读取可领取套餐失败时必须给失败态与重试入口：那是我们自己的错误，
 *   不能和「服务端没有活动」长得一样（两者都不显示就等于静默降级）。
 * - 领取必须由**用户点击**触发，不做任何后台自动领取或轮询。
 * - 活动要求验证码时，点击「领取」先打开验证码对话框，求解成功后再带 `verifyParam` 提交。
 * - 领取失败按 `failureKind` 给可读文案，不透传服务端原文。
 * - 领取成功后换成自画票券（`ManualClaimTicketCard`），信息与官方票券主体等价；
 *   票券数据来自 claim 前的套餐快照，不读刷新后的列表。
 *
 * ## 状态所有者
 *
 * 列表/验证码配置/领取结果/票券快照都在 `useManualClaimPlan`（见其注释）；本组件只负责
 * 渲染、四态分界，以及「是否先开验证码对话框」的局部判断。
 *
 * ## 验收场景
 *
 * 1. 无活动（查完为空且无 error）→ 不渲染任何内容；
 * 2. 读取失败 → 展示失败文案与「重试」，点重试重新拉取；
 * 3. 有活动 → 展示名称、描述、权益条目与「领取」按钮；
 * 4. 活动不需要验证码（`captchaConfig.enabled === false`）→ 点击直接 claim；
 * 5. 活动需要验证码 → 先开对话框，求解成功后再 claim，求解失败则不开 claim；
 * 6. 领取成功 → 展示自画票券（活动此时可能已从列表消失，票券仍必须有数据）；
 *    失败 → 展示对应失败文案。
 */
import { useState } from "react";
import {
  MANUAL_CLAIM_FAILURE_MESSAGE_KEYS,
  pickManualClaimPlan,
  type ManualClaimCaptchaConfig,
  type ManualClaimPlanClaimOutcome,
  type ManualClaimPlanPreview,
} from "@zcode/shared";
import { GiftIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useManualClaimPlan } from "./useManualClaimPlan.js";
import { ManualClaimTicketCard } from "./ManualClaimTicketCard.js";
import { ManualClaimCaptchaDialog } from "@/settings/ManualClaimCaptchaDialog.js";

export function ManualClaimPlanCard({ providerId }: { providerId: string }) {
  const { intl, locale } = useZCodeIntl();
  const {
    plans,
    captchaConfig,
    claimedPlan,
    loaded,
    claiming,
    error,
    outcome,
    claim,
    refresh,
    resetOutcome,
  } = useManualClaimPlan();
  const [captchaTarget, setCaptchaTarget] = useState<ManualClaimPlanPreview | null>(null);
  // 宿主没有 <webview> 时（手机 Web / 普通 Web）无法完成验证码求解。
  // 这里提前拦住，避免把用户送进一个必然失败的对话框。
  const [captchaUnsupported, setCaptchaUnsupported] = useState(false);

  // 未登录/无 provider 时服务层会返回稳定失败码，不需要在这里额外判断账号状态。
  const claimedOutcome = outcome?.ok === true ? outcome : null;
  const view = resolveManualClaimPlanCardView({
    plans,
    loaded,
    error,
    claimed: claimedOutcome !== null,
  });
  // 领取已成功优先于其余三态：此刻哪怕列表刷新失败、活动已下架，票券也得照常显示 ——
  // 把一张成功卡换成「加载失败 + 重试」是错误反馈（已经没有可重试的领取动作了）。
  if (view === "ticket" && claimedOutcome) {
    return (
      <div className="space-y-2" data-testid="manual-claim-plan-card">
        {claimedPlan ? (
          <ManualClaimTicketCard
            plan={claimedPlan}
            endsAt={claimedOutcome.endsAt}
            onDismiss={resetOutcome}
          />
        ) : (
          // 快照取不到（领取前后活动已下架）：只给成功提示与关闭，
          // 不画半张没有数据的票券，也不退回失败态。
          <div className="rounded-xl border border-border bg-surface p-4">
            <ManualClaimOutcomeNotice outcome={outcome} />
            <div className="mt-3 flex justify-end">
              <Button type="button" size="lg" variant="outline" onClick={resetOutcome}>
                {intl.formatMessage({ id: "settings.modelProvider.manualClaim.ticket.dismiss" })}
              </Button>
            </div>
          </div>
        )}
        <span className="hidden" data-manual-claim-provider={providerId} />
      </div>
    );
  }
  if (view === "load-failed") {
    return (
      <div className="space-y-2" data-testid="manual-claim-plan-card">
        <div className="flex min-w-0 items-center justify-between gap-3 rounded-xl border border-border bg-surface p-4 max-sm:flex-col max-sm:items-stretch">
          <p className="text-ui-sm text-destructive">
            {intl.formatMessage({ id: "settings.modelProvider.manualClaim.loadFailed" })}
          </p>
          <div className="shrink-0 max-sm:[&>button]:w-full">
            <Button
              type="button"
              size="lg"
              variant="outline"
              data-testid="manual-claim-plan-retry"
              onClick={() => void refresh()}
            >
              {intl.formatMessage({ id: "common.retry" })}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // 首屏还没查完，或查完确认没有活动：都不占位、不显示空态。
  // 「有没有可领取的额度」由官方展示额度的地址回答，这里只是一个方便领取的入口。
  if (view === "hidden") {
    return null;
  }

  const plan = pickManualClaimPlan(plans);
  if (!plan) {
    return null;
  }

  const needsCaptcha = captchaConfig?.enabled === true;

  return (
    <div className="space-y-2" data-testid="manual-claim-plan-card">
      <div className="rounded-xl border border-border bg-surface p-4">
        <div className="flex min-w-0 items-start justify-between gap-3 max-sm:flex-col max-sm:items-stretch">
          <div className="min-w-0 space-y-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <GiftIcon className="size-3.5 shrink-0 text-foreground-subtle" aria-hidden="true" />
              <h3 className="min-w-0 truncate text-ui-base font-semibold text-foreground">
                {plan.name}
              </h3>
            </div>
            {plan.description ? (
              <p className="text-ui-sm text-foreground-subtle">{plan.description}</p>
            ) : null}
            {plan.entitlements.length > 0 ? (
              <ul className="mt-1 space-y-0.5 text-ui-sm text-foreground-subtle">
                {plan.entitlements.map((entitlement) => (
                  <li key={entitlement.entitlementId} className="truncate">
                    {entitlement.showName}
                    {entitlement.grantUnits > 0 ? ` × ${entitlement.grantUnits}` : ""}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <div className="shrink-0 max-sm:[&>button]:w-full">
            <Button
              type="button"
              size="lg"
              disabled={claiming}
              onClick={() => {
                // 需要验证码时先求解：verifyParam 是一次性的，必须由用户交互当场产生。
                if (needsCaptcha && captchaConfig) {
                  setCaptchaTarget(plan);
                  return;
                }
                void claim({ planId: plan.planId });
              }}
            >
              {claiming ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
              {intl.formatMessage({ id: "settings.modelProvider.manualClaim.claim" })}
            </Button>
          </div>
        </div>
        <ManualClaimOutcomeNotice outcome={outcome} />
        {captchaUnsupported ? (
          <p
            className="mt-2 text-ui-sm text-warning"
            data-testid="manual-claim-captcha-unsupported"
          >
            {intl.formatMessage({
              id: "settings.modelProvider.manualClaim.captcha.unsupported",
            })}
          </p>
        ) : null}
        {error ? (
          // 走到这里只剩「列表已拿到、但领取请求本身异常」这一种：读取失败在函数开头就返回了。
          <p className="mt-2 text-ui-sm text-destructive">
            {intl.formatMessage({ id: "settings.modelProvider.manualClaim.loadFailed" })}
          </p>
        ) : null}
      </div>
      {captchaTarget && captchaConfig ? (
        <ManualClaimCaptchaDialog
          open
          config={captchaConfig}
          locale={locale}
          onOpenChange={(open) => {
            if (!open) {
              setCaptchaTarget(null);
            }
          }}
          onSolved={(solution) => {
            const planId = captchaTarget.planId;
            setCaptchaTarget(null);
            void claim({ planId, captcha: solution });
          }}
          onFailed={(stage) => {
            // "unsupported" 重试没有意义：宿主根本没有 webview 能力。
            // 关掉对话框并在卡片上给出「改用桌面版」的持久提示。
            if (stage === "unsupported") {
              setCaptchaTarget(null);
              setCaptchaUnsupported(true);
            }
          }}
        />
      ) : null}
      {/* providerId 只用于日志归属；领取接口本身与 family 无关。 */}
      <span className="hidden" data-manual-claim-provider={providerId} />
    </div>
  );
}

/** 领取结果提示。失败按 failureKind 映射本地化文案，不透传服务端原文。 */
export function ManualClaimOutcomeNotice({
  outcome,
}: {
  outcome: ManualClaimPlanClaimOutcome | null;
}) {
  const { intl } = useZCodeIntl();
  if (!outcome) {
    return null;
  }
  if (outcome.ok) {
    return (
      <p className="mt-2 text-ui-sm text-success" data-testid="manual-claim-outcome-success">
        {intl.formatMessage({ id: "settings.modelProvider.manualClaim.success" })}
      </p>
    );
  }
  // shared 的 MANUAL_CLAIM_FAILURE_MESSAGE_KEYS 直接给出 i18n key，
  // 这里原样使用：UI 不维护第二份「失败类型 → 文案」映射，避免两侧漂移。
  const key = MANUAL_CLAIM_FAILURE_MESSAGE_KEYS[outcome.failureKind];
  return (
    <p className="mt-2 text-ui-sm text-destructive" data-testid="manual-claim-outcome-failure">
      {intl.formatMessage({ id: key ?? "manual_claim_failure_unknown" })}
    </p>
  );
}

/**
 * 卡片该渲染成哪一态。抽成纯函数是为了让 CI 能直接钉住四态的分界 ——
 * 这四种状态在界面上分别是「占位失败态 + 重试」「完全不出现」「套餐卡片」「成功票券」，
 * 判错的后果是静默或错误反馈（用户什么都看不到，或把成功说成失败），只能靠测试守住。
 *
 * 判据为什么用 loaded 而不是 loading：INITIAL_STATE.loading 的初值是 false，
 * 首帧渲染时 `loading && plans.length === 0` 就不成立 —— 单看 loading 与 plans
 * 分不出「首屏还没查」与「查完确实没有活动」。loaded 由 hook 在成功与失败时置位。
 *
 * 为什么失败态还要求 plans.length === 0：hook 只在读取失败时清空 plans，
 * 而领取请求本身异常时不动 plans —— 后者应保持套餐卡片（行内给失败提示），
 * 不能因为一次领取失败就把已经拿到的套餐与「领取」按钮从界面上撤掉。
 */
export function resolveManualClaimPlanCardView(state: {
  plans: ManualClaimPlanPreview[];
  loaded: boolean;
  error: string | null;
  /**
   * 这一次领取是否已经成功。
   *
   * 为什么它必须排在最前：成功后 hook 会 refresh()，而活动可能已从列表消失 ——
   * 那时 plans 为空、刷新甚至可能失败。领取成功是既成事实，界面不能因为
   * 「列表没了」而退回不占位或失败态（那是把成功说成失败）。
   */
  claimed: boolean;
}): "hidden" | "load-failed" | "plan" | "ticket" {
  if (state.claimed) {
    return "ticket";
  }
  if (state.plans.length === 0) {
    return state.loaded && state.error ? "load-failed" : "hidden";
  }
  return "plan";
}

/** 供测试断言「活动需要验证码」的判据，与组件内保持一致。 */
export function requiresManualClaimCaptcha(
  config: ManualClaimCaptchaConfig | null | undefined,
): boolean {
  return config?.enabled === true;
}
