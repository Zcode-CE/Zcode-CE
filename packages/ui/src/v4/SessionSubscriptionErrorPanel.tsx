import { useCallback } from "react";
import { TID_V4_RETRY_SUBSCRIBE } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useFeedbackEntryAction } from "@/feedback/useFeedbackEntryAction.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { buildErrorFeedbackDescription } from "@/lib/errorFeedbackDraft.js";

interface SessionSubscriptionErrorPanelProps {
  error: string;
  sessionId: string;
  workspacePath: string;
  onReconnect: () => void;
}

export function SessionSubscriptionErrorPanel({
  error,
  sessionId,
  workspacePath,
  onReconnect,
}: SessionSubscriptionErrorPanelProps) {
  const { intl } = useZCodeIntl();
  const { runFeedbackEntry } = useFeedbackEntryAction();
  const handleOpenFeedback = useCallback(async () => {
    // 订阅失败时错误原文就是用户唯一的现场。改走「反馈与诊断」的渠道配置后，
    // errorSummary 承载原文，description 承载任务上下文模板；渠道不可用时 hook 会引导到设置页。
    const outcome = runFeedbackEntry({
      title: error.slice(0, 80),
      errorSummary: error,
      description: buildErrorFeedbackDescription({
        message: error,
        contextLines: [
          intl.formatMessage({ id: "feedback.submit.template.section.taskInfo" }),
          intl.formatMessage({ id: "feedback.submit.template.section.taskId" }, { id: sessionId }),
          intl.formatMessage(
            { id: "feedback.submit.template.section.taskWorkspace" },
            { path: workspacePath },
          ),
        ],
        formatMessage: (id: string, values?: Record<string, string>) =>
          intl.formatMessage({ id }, values),
      }),
    });
    if (outcome === "opened") {
      toast(intl.formatMessage({ id: "chat.error.feedbackOpened" }));
    }
  }, [error, intl, runFeedbackEntry, sessionId, workspacePath]);

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-ui-base">
      <p className="max-w-full break-words text-center font-mono text-destructive">{error}</p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button type="button" variant="outline" onClick={handleOpenFeedback}>
          {intl.formatMessage({ id: "chat.error.feedback" })}
        </Button>
        <Button type="button" data-testid={TID_V4_RETRY_SUBSCRIBE} onClick={onReconnect}>
          {intl.formatMessage({ id: "workspaceSidebar.reconnect" })}
        </Button>
      </div>
    </div>
  );
}
