import { useCallback } from "react";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { readFeedbackDiagnosticsPreference } from "@/feedback/feedbackDiagnosticsPreference.js";
import {
  setFeedbackEntryContext,
  type FeedbackEntryContext,
} from "@/feedback/feedbackEntryContext.js";
import { buildFeedbackEntryUrl } from "@/feedback/feedbackEntryPlan.js";

/**
 * 反馈入口的统一动作。
 *
 * 改造前每个入口都直接 `useFeedbackStore().openSubmit(...)`，也就是无条件打开官方工单弹窗
 * ——对 fork / 社区版用户来说那条链路本来就通不到（连的是官方域名），点了等于没反应。
 * 现在所有入口改走「反馈与诊断」分区的渠道配置，本 hook 是**唯一**的动作实现，
 * 入口组件只负责准备脱敏上下文。
 *
 * 三态行为（与 `buildFeedbackPrefilledUrl` 的 fail-closed 语义对齐）：
 * - `github` / 合法 `custom`：生成预填链接，交给 `platform.openExternal` 在系统浏览器打开；
 * - `off`：不打开任何外部地址；
 * - `custom` 但模板为空 / 非法（含 javascript: / data: / file: 等危险 scheme）：同样不打开。
 *
 * 后两种「不可用」情形**不是静默失败**：反馈入口是用户遇到问题时的唯一出口，
 * 点了没反应会被读成「功能坏了」。因此改为把用户送到设置页对应分区，并提示原因，
 * 让他能当场看到/修正渠道配置。
 */
export type FeedbackEntryOutcome = "opened" | "opened-settings";

export interface FeedbackEntryAction {
  runFeedbackEntry: (context: FeedbackEntryContext) => FeedbackEntryOutcome;
}

export function useFeedbackEntryAction(): FeedbackEntryAction {
  // 用 optional 变体而不是会抛异常的 usePlatform / useTabStore：
  // 错误横幅挂在 ConversationComposer 里，而 composer 会在没有 PlatformProvider 的宿主
  // （公开分享页、组件级测试）中渲染。缺 provider 时抛异常会把整个 composer 拖崩，
  // 而反馈按钮本来就不是这些宿主的核心能力，静默降级即可（仓库已有同款处理：V4ComposerCuaEntry）。
  const platform = useOptionalPlatform();
  const { intl, locale } = useZCodeIntl();
  const openSettingsTab = useOptionalTabStore((state) => state.openSettingsTab);

  const openFeedbackSettings = useCallback(() => {
    setPendingSettingsSectionIntent("feedback");
    openSettingsTab();
  }, [openSettingsTab]);

  const runFeedbackEntry = useCallback(
    (context: FeedbackEntryContext): FeedbackEntryOutcome => {
      // 偏好每次点击时读取而不是挂载时快照：用户可能在设置页改完渠道后立刻回到聊天里点反馈，
      // 挂载时快照会让他仍走旧渠道。localStorage 读取是同步的，代价可忽略。
      const preference = readFeedbackDiagnosticsPreference();
      const url = buildFeedbackEntryUrl({
        preference,
        context,
        locale,
        formatMessage: (id) => intl.formatMessage({ id }),
      });

      // platform 为 null 表示宿主没提供平台服务（无 provider 的嵌入场景）：
      // 此时既开不了浏览器也开不了设置页，只能返回引导态，让调用方不要弹「已打开反馈」。
      if (!url || !platform) {
        // 上下文先落盘再跳转：设置分区挂载时消费它，用户到那边就能看到完整现场。
        setFeedbackEntryContext(context);
        openFeedbackSettings();
        toast(
          intl.formatMessage({
            id:
              preference.channel === "off"
                ? "feedback.entry.channelOff"
                : "feedback.entry.channelUnavailable",
          }),
        );
        return "opened-settings";
      }

      platform.openExternal(url);
      return "opened";
    },
    [intl, locale, openFeedbackSettings, platform],
  );

  return { runFeedbackEntry };
}
