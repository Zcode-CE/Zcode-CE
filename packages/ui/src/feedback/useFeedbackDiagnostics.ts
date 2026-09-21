import { useCallback, useEffect, useMemo, useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { toast } from "@/components/ui/toast.js";
import { runExportLogsAction } from "@/lib/exportLogsAction.js";
import { getContainingDirectoryPath } from "@/lib/path.js";
import { logger } from "@/logger.js";
import {
  FEEDBACK_DIAGNOSTIC_FIELD_IDS,
  FEEDBACK_DIAGNOSTIC_FIELD_LABEL_IDS,
  buildFeedbackBody,
  buildFeedbackPrefilledUrl,
  type FeedbackChannelKind,
  type FeedbackDiagnosticEntry,
  type FeedbackDiagnosticFieldId,
  type FeedbackDiagnosticRuntime,
} from "@/feedback/feedbackDiagnostics.js";
import {
  consumeFeedbackEntryContext,
  type FeedbackEntryContext,
} from "@/feedback/feedbackEntryContext.js";
import {
  buildFeedbackEntryDiagnostics,
  resolveFeedbackEntryTitle,
} from "@/feedback/feedbackEntryPlan.js";
import {
  readFeedbackDiagnosticsPreference,
  writeFeedbackDiagnosticsPreference,
} from "@/feedback/feedbackDiagnosticsPreference.js";

/**
 * 「反馈与诊断」分区的状态与副作用。
 *
 * 为什么把逻辑抽成 hook：
 * - 分区本身只负责排版，状态（偏好、诊断摘要、日志归档）集中在这里，便于单独阅读与后续复用；
 * - 逻辑与 JSX 分离后，两条职责各自的改动不会互相牵动。
 *
 * 定位（用户已确认方向）：v1 用 GitHub 预填链接，零凭证、零后台出网。
 * 反馈入口只在用户点击「在浏览器中打开」时发生一次外部跳转，正文由用户自己核对后再提交。
 */

export interface FeedbackDiagnosticsController {
  channel: FeedbackChannelKind;
  customUrlTemplate: string;
  diagnosticFields: readonly FeedbackDiagnosticFieldId[];
  description: string;
  diagnostics: readonly FeedbackDiagnosticEntry[];
  prefilledBody: string;
  prefilledUrl: string | null;
  prefillCopied: boolean;
  archiveDirectory: string | null;
  archiveSize: number | null;
  preparingArchive: boolean;
  /** 日志归档依赖 IFeedbackService；宿主没提供时按钮保持禁用。 */
  canPrepareArchive: boolean;
  setDescription: (next: string) => void;
  selectChannel: (next: FeedbackChannelKind) => void;
  updateCustomUrlTemplate: (next: string) => void;
  toggleDiagnosticField: (fieldId: FeedbackDiagnosticFieldId, checked: boolean) => void;
  openPrefilledIssue: () => void;
  copyPrefilledUrl: () => Promise<void>;
  exportLogs: () => void;
  prepareArchive: () => Promise<void>;
  revealArchive: () => Promise<void>;
}

export function useFeedbackDiagnostics(): FeedbackDiagnosticsController {
  const { intl, locale } = useZCodeIntl();
  const platform = usePlatform();
  const services = useOptionalServices();
  const feedbackService = services?.feedbackService;

  const [channel, setChannel] = useState<FeedbackChannelKind>("github");
  const [customUrlTemplate, setCustomUrlTemplate] = useState("");
  const [diagnosticFields, setDiagnosticFields] = useState<FeedbackDiagnosticFieldId[]>([
    ...FEEDBACK_DIAGNOSTIC_FIELD_IDS,
  ]);
  const [diagnosticRuntime, setDiagnosticRuntime] = useState<FeedbackDiagnosticRuntime>({});
  // 从反馈入口（错误横幅 / 任务菜单 / 远程连接失败页）带过来的现场。
  // 一次性消费：取到就立刻从 store 清空，避免用户下次从别处进设置页时又被旧错误污染。
  const [entryContext, setEntryContext] = useState<FeedbackEntryContext>({});
  const [description, setDescription] = useState("");
  const [prefillCopied, setPrefillCopied] = useState(false);
  const [archiveDirectory, setArchiveDirectory] = useState<string | null>(null);
  const [archiveSize, setArchiveSize] = useState<number | null>(null);
  const [preparingArchive, setPreparingArchive] = useState(false);

  // 偏好是纯 renderer 展示配置，挂载时一次性读取；写回按用户操作即时落盘。
  useEffect(() => {
    const preference = readFeedbackDiagnosticsPreference();
    setChannel(preference.channel);
    setCustomUrlTemplate(preference.customUrlTemplate);
    setDiagnosticFields(preference.diagnosticFields);
  }, []);

  // 入口上下文只在挂载时消费一次。StrictMode 下 effect 会重放，但 consume 是幂等的：
  // 第二次取到的已经是 null，不会把同一份现场重复叠加。
  useEffect(() => {
    const context = consumeFeedbackEntryContext();
    if (!context) {
      return;
    }
    setEntryContext(context);
    // 入口带来的问题描述直接落到「问题描述」输入框，用户可以在此基础上继续编辑，
    // 而不是只读展示——预填内容本来就要允许用户在提交前改。
    if (context.description) {
      setDescription(context.description);
    }
  }, []);

  useEffect(() => {
    if (!feedbackService) {
      return;
    }
    let canceled = false;
    // getDeviceSnapshot 是纯本地构造函数，不发起任何网络请求；它返回的 deviceMid / hostname
    // 属于设备身份，绝不进入预填正文，这里读回来只取版本与平台字段。
    void feedbackService
      .getDeviceSnapshot()
      .then((device) => {
        if (!canceled) {
          setDiagnosticRuntime({ device });
        }
      })
      .catch((error: unknown) => {
        logger.warn("[feedback-diagnostics] 读取设备快照失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      canceled = true;
    };
  }, [feedbackService]);

  // 走 buildFeedbackEntryDiagnostics 而不是直接调 buildFeedbackDiagnosticEntries：
  // 「用户手输的问题描述」与「入口带来的错误摘要」都必须过 redactFeedbackText，
  // 否则设置页预览与最终 URL 会带着未脱敏的凭据（V-3）。
  const diagnostics = useMemo(
    () =>
      buildFeedbackEntryDiagnostics({
        context: { ...entryContext, description },
        runtime: diagnosticRuntime,
      }),
    [description, diagnosticRuntime, entryContext],
  );
  const prefilledBody = useMemo(
    () =>
      buildFeedbackBody(
        diagnostics
          .filter((entry) => diagnosticFields.includes(entry.id))
          .map((entry) => ({
            label: intl.formatMessage({ id: FEEDBACK_DIAGNOSTIC_FIELD_LABEL_IDS[entry.id] }),
            value: entry.value,
          })),
        { locale },
      ),
    [diagnosticFields, diagnostics, intl, locale],
  );
  const prefilledUrl = useMemo(
    () =>
      buildFeedbackPrefilledUrl({
        target: { channel, customUrlTemplate },
        // 入口带来的 title / 错误摘要优先于描述首行，与入口侧 resolveFeedbackEntryTitle 同序。
        title: resolveFeedbackEntryTitle({ ...entryContext, description }),
        body: prefilledBody,
        locale,
      }),
    [channel, customUrlTemplate, description, entryContext, locale, prefilledBody],
  );

  const selectChannel = useCallback((next: FeedbackChannelKind) => {
    setChannel(next);
    writeFeedbackDiagnosticsPreference({ channel: next });
  }, []);

  const updateCustomUrlTemplate = useCallback((next: string) => {
    setCustomUrlTemplate(next);
    writeFeedbackDiagnosticsPreference({ customUrlTemplate: next });
  }, []);

  const toggleDiagnosticField = useCallback(
    (fieldId: FeedbackDiagnosticFieldId, checked: boolean) => {
      setDiagnosticFields((current) => {
        const next = checked
          ? [...new Set([...current, fieldId])]
          : current.filter((entry) => entry !== fieldId);
        // 全部取消勾选等于「诊断段落为空」，容易被误读成「已附带环境信息」；
        // 这里保留至少一项，需要清空时用户可以在浏览器里直接删掉那一段。
        if (next.length === 0) {
          return current;
        }
        writeFeedbackDiagnosticsPreference({ diagnosticFields: next });
        return next;
      });
    },
    [],
  );

  // 这里刻意不套 runUserAction：打开外部浏览器是一次性旁路动作，没有可观测的完成态，
  // 而 featureId 需要登记到 userActionTraceCatalog，本分区不为此新增埋点目录条目。
  const openPrefilledIssue = useCallback(() => {
    if (!prefilledUrl) {
      return;
    }
    platform.openExternal(prefilledUrl);
  }, [platform, prefilledUrl]);

  const copyPrefilledUrl = useCallback(async () => {
    if (!prefilledUrl || typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      toast(intl.formatMessage({ id: "settings.feedback.copyFailed" }));
      return;
    }
    try {
      await navigator.clipboard.writeText(prefilledUrl);
      setPrefillCopied(true);
      toast(intl.formatMessage({ id: "settings.feedback.copied" }));
    } catch (error) {
      logger.warn("[feedback-diagnostics] 复制预填链接失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "settings.feedback.copyFailed" }));
    }
  }, [intl, prefilledUrl]);

  useEffect(() => {
    if (!prefillCopied) {
      return;
    }
    const timer = setTimeout(() => setPrefillCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [prefillCopied]);

  const exportLogs = useCallback(() => {
    void runExportLogsAction(platform, intl);
  }, [intl, platform]);

  const prepareArchive = useCallback(async () => {
    if (!feedbackService || preparingArchive) {
      return;
    }
    setPreparingArchive(true);
    try {
      // 复用反馈链路的紧凑归档：与「提交反馈时自动附带日志」走同一份脱敏与体积上限，
      // 不新增第二条日志打包路径。
      const archive = await feedbackService.prepareCompactLogArchive();
      setArchiveDirectory(getContainingDirectoryPath(archive.path) ?? archive.path);
      setArchiveSize(archive.size);
      toast(intl.formatMessage({ id: "settings.feedback.logs.prepared" }));
    } catch (error) {
      logger.warn("[feedback-diagnostics] 生成本地日志包失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "settings.feedback.logs.failed" }));
    } finally {
      setPreparingArchive(false);
    }
  }, [feedbackService, intl, preparingArchive]);

  const revealArchive = useCallback(async () => {
    if (!archiveDirectory) {
      return;
    }
    const result = await platform.openInFileManager(archiveDirectory);
    if (!result.success) {
      toast(intl.formatMessage({ id: "settings.feedback.logs.revealFailed" }));
    }
  }, [archiveDirectory, intl, platform]);

  return {
    channel,
    customUrlTemplate,
    diagnosticFields,
    description,
    diagnostics,
    prefilledBody,
    prefilledUrl,
    prefillCopied,
    archiveDirectory,
    archiveSize,
    preparingArchive,
    canPrepareArchive: Boolean(feedbackService),
    setDescription,
    selectChannel,
    updateCustomUrlTemplate,
    toggleDiagnosticField,
    openPrefilledIssue,
    copyPrefilledUrl,
    exportLogs,
    prepareArchive,
    revealArchive,
  };
}
