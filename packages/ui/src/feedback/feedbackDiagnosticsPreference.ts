import { logger } from "@/logger.js";
import {
  FEEDBACK_DIAGNOSTIC_FIELD_IDS,
  parseFeedbackChannelKind,
  parseFeedbackDiagnosticFields,
  type FeedbackChannelKind,
  type FeedbackDiagnosticFieldId,
} from "@/feedback/feedbackDiagnostics.js";

/**
 * 「反馈与诊断」分区的本地偏好持久化。
 *
 * 为什么先用 localStorage 而不是 AppSettings：
 * - 加字段要同时改 packages/shared 的 AppSettings 协议与校验 schema，属于协议面改动；
 *   本分区是纯 renderer 的展示偏好，先在 UI 层落地不引入协议升级。
 * - 仓库已有同类先例（feedbackContactPreference / sidebarUsageCodingPlanProviderPreference），
 *   读取失败一律降级为默认值，不阻断设置页打开。
 * - 后续若需要跨设备同步，再把这三个键迁到 AppSettings 并做一次读取迁移即可。
 */

const FEEDBACK_CHANNEL_STORAGE_KEY = "zcode.feedback.channel";
const FEEDBACK_CUSTOM_URL_STORAGE_KEY = "zcode.feedback.custom-url";
const FEEDBACK_DIAGNOSTIC_FIELDS_STORAGE_KEY = "zcode.feedback.diagnostic-fields";

export interface FeedbackDiagnosticsPreference {
  channel: FeedbackChannelKind;
  customUrlTemplate: string;
  diagnosticFields: FeedbackDiagnosticFieldId[];
}

export const DEFAULT_FEEDBACK_DIAGNOSTICS_PREFERENCE: FeedbackDiagnosticsPreference = {
  channel: "github",
  customUrlTemplate: "",
  diagnosticFields: [...FEEDBACK_DIAGNOSTIC_FIELD_IDS],
};

function getStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch (error) {
    // WebView 隐私模式或移动端远控容器可能禁用 localStorage。
    logger.warn("[feedbackDiagnosticsPreference] localStorage 不可用", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** 勾选项以 JSON 数组落盘；解析失败交给 parseFeedbackDiagnosticFields 回退默认。 */
function parseStoredFields(raw: string | null): unknown {
  if (raw === null) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function readFeedbackDiagnosticsPreference(
  storage: Storage | null = getStorage(),
): FeedbackDiagnosticsPreference {
  if (!storage) {
    return DEFAULT_FEEDBACK_DIAGNOSTICS_PREFERENCE;
  }
  try {
    return {
      channel: parseFeedbackChannelKind(storage.getItem(FEEDBACK_CHANNEL_STORAGE_KEY)),
      customUrlTemplate: storage.getItem(FEEDBACK_CUSTOM_URL_STORAGE_KEY)?.trim() ?? "",
      diagnosticFields: parseFeedbackDiagnosticFields(
        parseStoredFields(storage.getItem(FEEDBACK_DIAGNOSTIC_FIELDS_STORAGE_KEY)),
      ),
    };
  } catch (error) {
    logger.warn("[feedbackDiagnosticsPreference] 读取反馈偏好失败", {
      error: error instanceof Error ? error.message : String(error),
    });
    return DEFAULT_FEEDBACK_DIAGNOSTICS_PREFERENCE;
  }
}

export function writeFeedbackDiagnosticsPreference(
  patch: Partial<FeedbackDiagnosticsPreference>,
  storage: Storage | null = getStorage(),
): void {
  if (!storage) {
    return;
  }
  try {
    if (patch.channel !== undefined) {
      storage.setItem(FEEDBACK_CHANNEL_STORAGE_KEY, patch.channel);
    }
    if (patch.customUrlTemplate !== undefined) {
      const normalized = patch.customUrlTemplate.trim();
      if (normalized) {
        storage.setItem(FEEDBACK_CUSTOM_URL_STORAGE_KEY, normalized);
      } else {
        storage.removeItem(FEEDBACK_CUSTOM_URL_STORAGE_KEY);
      }
    }
    if (patch.diagnosticFields !== undefined) {
      storage.setItem(
        FEEDBACK_DIAGNOSTIC_FIELDS_STORAGE_KEY,
        JSON.stringify(patch.diagnosticFields),
      );
    }
  } catch (error) {
    logger.warn("[feedbackDiagnosticsPreference] 写入反馈偏好失败", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
