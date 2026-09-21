/**
 * 「可领取」套餐卡片：claim 平面的设置页入口。
 *
 * ## 产品规则
 *
 * - 只在**服务端返回了可领取套餐**时渲染（`plans.length > 0`）；无活动时完全不出现，
 *   不占位、不显示空态 —— 「当前没有可领的活动」不是用户需要处理的信息。
 * - 领取必须由**用户点击**触发，不做任何后台自动领取或轮询。
 * - 活动要求验证码时，点击「领取」先打开验证码对话框，求解成功后再带 `verifyParam` 提交。
 * - 领取失败按 `failureKind` 给可读文案，不透传服务端原文。
 *
 * ## 状态所有者
 *
 * 列表/验证码配置/领取结果都在 `useManualClaimPlan`（见其注释）；本组件只负责渲染与
 * 「是否先开验证码对话框」的局部判断。
 *
 * ## 验收场景
 *
 * 1. 无活动 → 不渲染任何内容；
 * 2. 有活动 → 展示名称、描述、权益条目与「领取」按钮；
 * 3. 活动不需要验证码（`captchaConfig.enabled === false`）→ 点击直接 claim；
 * 4. 活动需要验证码 → 先开对话框，求解成功后再 claim，求解失败则不开 claim；
 * 5. 领取成功 → 展示生效窗口；失败 → 展示对应失败文案。
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
import { ManualClaimCaptchaDialog } from "@/settings/ManualClaimCaptchaDialog.js";

export function ManualClaimPlanCard({ providerId }: { providerId: string }) {
  const { intl, locale } = useZCodeIntl();
  const { plans, captchaConfig, loading, claiming, error, outcome, claim } = useManualClaimPlan();
  const [captchaTarget, setCaptchaTarget] = useState<ManualClaimPlanPreview | null>(null);
  // 宿主没有 <webview> 时（手机 Web / 普通 Web）无法完成验证码求解。
  // 这里提前拦住，避免把用户送进一个必然失败的对话框。
  const [captchaUnsupported, setCaptchaUnsupported] = useState(false);

  // 未登录/无 provider 时服务层会返回稳定失败码，不需要在这里额外判断账号状态。
  if (loading && plans.length === 0) {
    return null;
  }
  if (plans.length === 0) {
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

/** 供测试断言「活动需要验证码」的判据，与组件内保持一致。 */
export function requiresManualClaimCaptcha(
  config: ManualClaimCaptchaConfig | null | undefined,
): boolean {
  return config?.enabled === true;
}
