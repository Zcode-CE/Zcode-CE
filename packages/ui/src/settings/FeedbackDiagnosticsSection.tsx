import { Check, Copy, Download, ExternalLink, FolderOpen, LifeBuoy, Ticket } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { Textarea } from "@/components/ui/textarea.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { StatusDot } from "@/settings/StatusDot.js";
import { formatBytes } from "@/resource-manager/resourceUsageView.js";
import {
  DEFAULT_FEEDBACK_REPOSITORY_URL,
  FEEDBACK_DIAGNOSTIC_FIELD_LABEL_IDS,
  type FeedbackChannelKind,
} from "@/feedback/feedbackDiagnostics.js";
import { useFeedbackDiagnostics } from "@/feedback/useFeedbackDiagnostics.js";

/**
 * 「反馈与诊断」设置分区（展示层）。
 *
 * 定位（用户已确认方向）：v1 用 GitHub 预填链接，零凭证、零后台出网。
 * - 反馈入口只在用户点击「在浏览器中打开」时发生一次外部跳转，正文由用户自己核对后再提交；
 * - 诊断信息只含版本 / 构建 / 平台 / 用户可见错误摘要，deviceMid、hostname、凭据、完整日志都不进预填正文；
 * - 遥测状态是只读展示，本分区不提供任何开启入口。
 */

const FEEDBACK_CHANNEL_KINDS: readonly FeedbackChannelKind[] = ["github", "custom", "off"];

const FEEDBACK_CHANNEL_LABEL_IDS: Record<FeedbackChannelKind, string> = {
  github: "settings.feedback.channel.github",
  custom: "settings.feedback.channel.custom",
  off: "settings.feedback.channel.off",
};

export function FeedbackDiagnosticsSection({
  isDesktop = false,
  workspacePath,
  workspaceIdentity,
}: {
  isDesktop?: boolean;
  /** 仅用于提示诊断信息的作用范围，不进入预填正文。 */
  workspacePath?: string | null;
  workspaceIdentity?: string;
}) {
  const { intl } = useZCodeIntl();
  const diagnostics = useFeedbackDiagnostics();
  const openOfficialSubmit = useFeedbackStore((state) => state.openSubmit);
  const hasWorkspaceContext = Boolean(workspacePath?.trim() || workspaceIdentity?.trim());

  return (
    <div className="space-y-4">
      <SettingsGroupCard>
        <SettingsRow
          controlLayout="wide"
          label={intl.formatMessage({ id: "settings.feedback.channel.label" })}
          description={intl.formatMessage({ id: "settings.feedback.channel.description" })}
          control={
            <div
              role="radiogroup"
              aria-label={intl.formatMessage({ id: "settings.feedback.channel.label" })}
              className="flex w-full flex-col gap-1"
            >
              {FEEDBACK_CHANNEL_KINDS.map((kind) => (
                <label
                  key={kind}
                  className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-ui-base hover:bg-hover"
                >
                  <input
                    type="radio"
                    name="settings-feedback-channel"
                    className="mt-0.5 size-3.5 shrink-0 accent-primary"
                    checked={diagnostics.channel === kind}
                    onChange={() => diagnostics.selectChannel(kind)}
                  />
                  <span className="min-w-0">
                    <span className="block font-medium text-foreground">
                      {intl.formatMessage({ id: FEEDBACK_CHANNEL_LABEL_IDS[kind] })}
                    </span>
                    <span className="block text-ui-sm text-foreground-subtle">
                      {intl.formatMessage({
                        id: `${FEEDBACK_CHANNEL_LABEL_IDS[kind]}.description`,
                      })}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          }
        />
        {diagnostics.channel === "github" ? (
          <SettingsRow
            label={intl.formatMessage({ id: "settings.feedback.repository.label" })}
            description={intl.formatMessage({ id: "settings.feedback.repository.description" })}
            control={
              <span className="max-w-full truncate font-mono text-ui-sm text-foreground-subtle">
                {DEFAULT_FEEDBACK_REPOSITORY_URL}
              </span>
            }
          />
        ) : null}
        {diagnostics.channel === "custom" ? (
          <SettingsRow
            controlLayout="wide"
            label={intl.formatMessage({ id: "settings.feedback.customUrl.label" })}
            description={intl.formatMessage({ id: "settings.feedback.customUrl.description" })}
            control={null}
            detail={
              <Input
                size="lg"
                className="font-mono"
                value={diagnostics.customUrlTemplate}
                spellCheck={false}
                placeholder={intl.formatMessage({
                  id: "settings.feedback.customUrl.placeholder",
                })}
                onChange={(event) => diagnostics.updateCustomUrlTemplate(event.currentTarget.value)}
              />
            }
          />
        ) : null}
        {/*
          官方工单服务在「自定义地址」模式下保留为显式入口。
          官方反馈属「官方服务 + 用户主动触发」象限：按决策原则是「重构为可配置」而不是删除，
          因此 feedbackService 与 X-Device-Mid 链路原样保留，但不参与默认路径——
          它连的是官方域名，对 fork / 社区版构建本来就不通，只在用户明确选择时可用。
        */}
        {diagnostics.channel === "custom" ? (
          <SettingsRow
            label={intl.formatMessage({ id: "settings.feedback.official.label" })}
            description={intl.formatMessage({ id: "settings.feedback.official.description" })}
            control={
              <Button
                type="button"
                variant="outline"
                size="lg"
                onClick={() => openOfficialSubmit({ includeLogs: false, screenshots: [] })}
              >
                <Ticket className="size-4" />
                <span>{intl.formatMessage({ id: "settings.feedback.official.open" })}</span>
              </Button>
            }
          />
        ) : null}
      </SettingsGroupCard>

      <SettingsGroupCard>
        <SettingsRow
          controlLayout="wide"
          label={intl.formatMessage({ id: "settings.feedback.diagnostics.label" })}
          description={intl.formatMessage({ id: "settings.feedback.diagnostics.description" })}
          control={null}
          detail={
            <div className="space-y-3">
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {diagnostics.diagnostics.map((entry) => (
                  <label
                    key={entry.id}
                    className="flex items-center gap-2 text-ui-base text-foreground"
                  >
                    <Checkbox
                      checked={diagnostics.diagnosticFields.includes(entry.id)}
                      onCheckedChange={(checked) =>
                        diagnostics.toggleDiagnosticField(entry.id, checked === true)
                      }
                      aria-label={intl.formatMessage({
                        id: FEEDBACK_DIAGNOSTIC_FIELD_LABEL_IDS[entry.id],
                      })}
                    />
                    <span>
                      {intl.formatMessage({ id: FEEDBACK_DIAGNOSTIC_FIELD_LABEL_IDS[entry.id] })}
                    </span>
                  </label>
                ))}
              </div>
              <Label
                htmlFor="settings-feedback-description"
                className="block text-ui-base text-foreground-subtle"
              >
                {intl.formatMessage({ id: "settings.feedback.description.label" })}
              </Label>
              <Textarea
                id="settings-feedback-description"
                value={diagnostics.description}
                rows={3}
                onChange={(event) => diagnostics.setDescription(event.currentTarget.value)}
                placeholder={intl.formatMessage({
                  id: "settings.feedback.description.placeholder",
                })}
              />
              <pre className="max-h-64 overflow-auto rounded-lg border border-border bg-surface px-3 py-2 font-mono text-ui-sm whitespace-pre-wrap text-foreground-subtle">
                {diagnostics.prefilledBody ||
                  intl.formatMessage({ id: "settings.feedback.preview.empty" })}
              </pre>
            </div>
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.feedback.preview.label" })}
          description={intl.formatMessage({ id: "settings.feedback.preview.description" })}
          control={
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="lg"
                disabled={!diagnostics.prefilledUrl}
                onClick={() => void diagnostics.copyPrefilledUrl()}
              >
                {diagnostics.prefillCopied ? (
                  <Check className="size-4" />
                ) : (
                  <Copy className="size-4" />
                )}
                <span>
                  {intl.formatMessage({
                    id: diagnostics.prefillCopied
                      ? "settings.feedback.copied"
                      : "settings.feedback.copy",
                  })}
                </span>
              </Button>
              <Button
                type="button"
                size="lg"
                disabled={!diagnostics.prefilledUrl}
                onClick={diagnostics.openPrefilledIssue}
              >
                <ExternalLink className="size-4" />
                <span>{intl.formatMessage({ id: "settings.feedback.openInBrowser" })}</span>
              </Button>
            </div>
          }
        />
        {!diagnostics.prefilledUrl && diagnostics.channel === "custom" ? (
          <SettingsRow
            label={intl.formatMessage({ id: "settings.feedback.customUrl.invalid" })}
            control={null}
          />
        ) : null}
      </SettingsGroupCard>

      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.feedback.logs.label" })}
          description={intl.formatMessage({ id: "settings.feedback.logs.description" })}
          control={
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="lg"
                disabled={!diagnostics.canPrepareArchive || diagnostics.preparingArchive}
                onClick={() => void diagnostics.prepareArchive()}
              >
                <Download className="size-4" />
                <span>
                  {intl.formatMessage({
                    id: diagnostics.preparingArchive
                      ? "settings.feedback.logs.preparing"
                      : "settings.feedback.logs.prepare",
                  })}
                </span>
              </Button>
              {isDesktop ? (
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  onClick={() => void diagnostics.exportLogs()}
                >
                  <Download className="size-4" />
                  <span>{intl.formatMessage({ id: "sidebar.exportLogs" })}</span>
                </Button>
              ) : null}
            </div>
          }
          detail={
            diagnostics.archiveDirectory ? (
              <div className="flex flex-wrap items-center gap-2 text-ui-sm text-foreground-subtle">
                <FolderOpen className="size-4 shrink-0" />
                <span className="min-w-0 break-all font-mono">{diagnostics.archiveDirectory}</span>
                {diagnostics.archiveSize !== null ? (
                  <span className="tabular-nums">({formatBytes(diagnostics.archiveSize)})</span>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void diagnostics.revealArchive()}
                >
                  {intl.formatMessage({ id: "settings.feedback.logs.reveal" })}
                </Button>
              </div>
            ) : null
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.feedback.attachment.label" })}
          description={intl.formatMessage({ id: "settings.feedback.attachment.description" })}
          control={null}
        />
      </SettingsGroupCard>

      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.feedback.telemetry.label" })}
          description={intl.formatMessage({ id: "settings.feedback.telemetry.description" })}
          control={
            <span className="inline-flex items-center gap-2 text-ui-base text-foreground-subtle">
              <StatusDot tone="muted" />
              {intl.formatMessage({ id: "settings.feedback.telemetry.disabled" })}
            </span>
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.feedback.scope.label" })}
          description={intl.formatMessage({
            id: hasWorkspaceContext
              ? "settings.feedback.scope.workspace"
              : "settings.feedback.scope.app",
          })}
          control={
            <span className="inline-flex items-center gap-2 text-ui-base text-foreground-subtle">
              <LifeBuoy className="size-4" />
              {intl.formatMessage({ id: "settings.feedback.scope.local" })}
            </span>
          }
        />
      </SettingsGroupCard>
    </div>
  );
}
