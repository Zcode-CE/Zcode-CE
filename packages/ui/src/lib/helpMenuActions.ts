import type { IPlatformService } from "@zcode/shared";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type { FeedbackEntryContext } from "@/feedback/feedbackEntryContext.js";
import { runExportLogsAction } from "@/lib/exportLogsAction.js";
import { ZCODE_PRODUCT_DOCS_URL } from "@/lib/productDocs.js";

interface HelpMenuActionHandlers {
  openIssueReport: () => Promise<void>;
  openProductDocs: () => void;
  exportLogs: () => void;
}

export function createHelpMenuActionHandlers({
  platform,
  intl,
  runFeedbackEntry,
}: {
  platform: Pick<IPlatformService, "captureWindowScreenshot" | "exportLogs" | "openExternal">;
  intl: IntlInstance;
  /**
   * 反馈入口动作由调用方注入（useFeedbackEntryAction），而不是在这里直接读 store：
   * 渠道裁决需要 platform / 当前语言 / 设置页跳转能力，都属于 React 上下文，
   * 本模块保持纯函数以便单独测试。
   */
  runFeedbackEntry: (context: FeedbackEntryContext) => unknown;
}): HelpMenuActionHandlers {
  return {
    openIssueReport: async () => {
      // 帮助菜单的「问题上报」是通用入口，没有具体错误现场，只带一个空上下文；
      // 预填正文仍会包含版本与平台等脱敏诊断信息。
      runFeedbackEntry({});
    },
    openProductDocs: () => {
      platform.openExternal(ZCODE_PRODUCT_DOCS_URL);
    },
    exportLogs: () => {
      void runExportLogsAction(platform, intl);
    },
  };
}
