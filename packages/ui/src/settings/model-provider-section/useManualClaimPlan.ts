/**
 * 手动领取（周末 / 体验套餐）的数据入口。
 *
 * ## 状态所有者
 *
 * | 状态 | 所有者 |
 * | --- | --- |
 * | 可领取列表 | host 侧 `getManualClaimPlanPreviews()`（本 hook 只做一次性拉取 + 本地缓存） |
 * | 验证码配置 | host 侧 `getManualClaimCaptchaConfig()`（服务层 60s 快照） |
 * | 领取中 / 领取结果 | 本 hook（`claiming` / `outcome`），刷新后即丢弃 |
 * | 领取成功票券的数据快照 | 本 hook（`claimedPlan`）。在 claim 发出的那一刻按 planId 从当时的
 *   `plans` 里取，成功后保留到 `resetOutcome()` 或下一次 claim。 |
 * | 读取是否已出过结果 | 本 hook（`loaded`）。`loading` 只表示「本次请求在飞」，
 *   而 `INITIAL_STATE.loading` 的初值是 false ⇒ 单看 loading 分不出首屏与查完为空，
 *   失败态因此需要 `loaded && error` 这一对判据（见组件里的三态分界）。 |
 *
 * ## 为什么在 hook 里拉取而不是 store
 *
 * 领取是**用户主动的一次性动作**，不是需要跨组件共享的长期状态：
 * 列表只在设置页卡片可见时需要，领完即失效。放 store 会引入一份需要失效管理的副本。
 * 参考 `useStartPlanPreview` 的既有形态。
 *
 * ## 验收场景
 *
 * 1. 打开设置页 → 拉 preview；服务端无活动时返回空列表 → 卡片不渲染；
 * 2. 拉取抛错 → `loaded: true` 且 `error` 非空 → 卡片展示失败态与「重试」；
 * 3. 有可领套餐 → 卡片展示名称/描述/权益，并显示「领取」按钮；
 * 4. 未登录时点击领取 → 服务层返回 `login_required` → 卡片展示对应提示；
 * 5. 活动需要验证码 → 点击领取后打开验证码对话框 → 求解成功 → 带 verifyParam 再 claim；
 * 6. 领取成功 → 卡片展示生效窗口并刷新列表。
 *
 * ## 为什么票券快照由本 hook 持有，而且必须在 refresh() 之前取
 *
 * 成功分支是「先落 outcome，再 refresh()」，而**活动可能在领取成功后从列表里消失**
 * （服务端事实）。若票券从刷新后的 `plans` 取数据，领取成功时它就没有任何数据可画。
 * 快照与 outcome 描述的是同一件事（这一次领取），因此放同一个所有者、同一处清空，
 * 不放到组件局部状态里造出第二份「领取结果」。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  pickManualClaimPlan,
  type ManualClaimCaptchaConfig,
  type ManualClaimPlanClaimOutcome,
  type ManualClaimPlanPreview,
} from "@zcode/shared";
import { useOptionalServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

interface ManualClaimPlanState {
  plans: ManualClaimPlanPreview[];
  captchaConfig: ManualClaimCaptchaConfig | null;
  /**
   * 领取成功票券的数据来源：claim 发出那一刻的套餐快照。
   *
   * 为什么不从 `plans` 现取：成功后紧接着 refresh()，而活动可能已从列表移除，
   * 那时 `plans` 为空、票券就没数据了（见文件头注释）。
   */
  claimedPlan: ManualClaimPlanPreview | null;
  /**
   * 是否已经拿到过一次结果（成功或失败）。
   *
   * 为什么必须有这一位：INITIAL_STATE.loading 的初值是 false，首帧渲染时
   * 「loading && plans.length === 0」并不成立 —— 只看 loading 与 plans
   * 无法区分「首屏还没查」与「查完确实没有活动」，而这两种状态的界面要求不同
   * （前者不占位，后者也不占位，但失败必须给反馈）。它标记的是「已经查过一次」，
   * 不是「本次请求是否在飞」（那是 loading）。
   */
  loaded: boolean;
  loading: boolean;
  claiming: boolean;
  error: string | null;
  outcome: ManualClaimPlanClaimOutcome | null;
}

const INITIAL_STATE: ManualClaimPlanState = {
  plans: [],
  captchaConfig: null,
  claimedPlan: null,
  loaded: false,
  loading: false,
  claiming: false,
  error: null,
  outcome: null,
};

export function useManualClaimPlan(options?: { enabled?: boolean }) {
  const services = useOptionalServices();
  const service = services?.codingPlanSubscriptionService;
  const enabled = options?.enabled !== false;
  const [state, setState] = useState<ManualClaimPlanState>(INITIAL_STATE);
  // claim 里要在发出请求前取票券快照，取的就是本次渲染的这份列表。
  const plans = state.plans;
  // 卸载后不再 setState：claim 是长动作，用户可能在等待期间离开设置页。
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!enabled || !service) {
      return;
    }
    // 请求开始时只置 loading：不清 error，也不动 loaded。
    // 清 error 会让「点重试」先把失败提示抹掉、失败时再出现 —— 那正是本次要修的静默形态；
    // loaded 标记的是「已经拿到过一次结果」，与本次请求是否在飞无关。
    setState((current) => ({ ...current, loading: true }));
    try {
      // 两个请求并行：验证码配置只用于决定点击「领取」后是否需要开对话框，
      // 它的失败不应阻断列表展示（列表本身就是「有什么可领」的答案）。
      const [plans, captchaConfig] = await Promise.all([
        service.getManualClaimPlanPreviews(),
        service.getManualClaimCaptchaConfig().catch(() => null),
      ]);
      if (!mountedRef.current) {
        return;
      }
      setState((current) => ({
        ...current,
        plans,
        captchaConfig,
        loaded: true,
        loading: false,
        error: null,
      }));
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("[useManualClaimPlan] 读取可领取套餐失败", { error: message });
      // 失败也要置 loaded：已经查过一次（结果是失败），界面据此给失败态而不是不占位。
      setState((current) => ({
        ...current,
        plans: [],
        loaded: true,
        loading: false,
        error: message,
      }));
    }
  }, [enabled, service]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const claim = useCallback(
    async (request: { planId: string; captcha?: { verifyParam: string; region?: string } }) => {
      if (!service) {
        return;
      }
      // 快照必须在 claim 发出前取：成功后紧接着的 refresh() 可能让活动从列表里消失。
      // 这里读的是本次渲染的 plans（它在下面 useCallback 的依赖里）—— 就是用户点下
      // 「领取」时看到的那份。按 planId 取而不是取「当前优先级最高的那个」：验证码路径下
      // 用户可能先开对话框，期间列表若被刷新，按 planId 仍能命中原目标；
      // 取不到时票券不画（退回成功文案）。
      const claimedPlan = pickManualClaimPlan(plans, request.planId);
      setState((current) => ({
        ...current,
        claiming: true,
        outcome: null,
        claimedPlan: null,
      }));
      try {
        const outcome = await service.claimManualPlan(request);
        if (!mountedRef.current) {
          return;
        }
        setState((current) => ({
          ...current,
          claiming: false,
          outcome,
          claimedPlan: outcome.ok ? claimedPlan : null,
        }));
        if (outcome.ok) {
          // 领取成功后活动可能已从列表移除，重拉一次让卡片反映服务端事实。
          // 票券不读刷新后的 plans，它读上面那份快照。
          await refresh();
        }
      } catch (error) {
        if (!mountedRef.current) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("[useManualClaimPlan] 领取请求异常", {
          planId: request.planId,
          error: message,
        });
        setState((current) => ({ ...current, claiming: false, error: message }));
      }
    },
    [plans, refresh, service],
  );

  /** 清掉这一次领取的全部痕迹：结果与票券快照。两者同源，必须同处清空。 */
  const resetOutcome = useCallback(() => {
    setState((current) => ({ ...current, outcome: null, claimedPlan: null }));
  }, []);

  return { ...state, refresh, claim, resetOutcome };
}
