import {
  ZCODE_BUILD_TIME,
  ZCODE_COMMIT,
  ZCODE_VERSION,
  type FeedbackDeviceInfo,
} from "@zcode/shared";

/**
 * 「反馈与诊断」分区的本地模型：反馈目标偏好 + 脱敏诊断摘要 + 预填链接拼接。
 *
 * 为什么放在 UI 层而不是 services：
 * - v1 的反馈渠道是 GitHub 预填链接，全程零凭证、零网络请求，只在用户点击时打开外部浏览器；
 *   它不构成一条服务端链路，硬塞进 IFeedbackService 只会让「提交工单」的旧契约变形。
 * - 该能力必须在本机 Web、远端 workspace、离线环境里行为一致，因此不接任何 workspace/远端参数。
 */

export type FeedbackChannelKind = "github" | "custom" | "off";

export const DEFAULT_FEEDBACK_REPOSITORY_URL = "https://github.com/Zcode-CE/Zcode-CE";

/** 预填 body 的可勾选字段。默认全选，用户可在预览里逐项取消。 */
export type FeedbackDiagnosticFieldId = "app" | "runtime" | "error" | "notes";

export const FEEDBACK_DIAGNOSTIC_FIELD_IDS: readonly FeedbackDiagnosticFieldId[] = [
  "app",
  "runtime",
  "error",
  "notes",
];

/** i18n key 后缀，与 FEEDBACK_DIAGNOSTIC_FIELD_IDS 一一对应。 */
export const FEEDBACK_DIAGNOSTIC_FIELD_LABEL_IDS: Record<FeedbackDiagnosticFieldId, string> = {
  app: "settings.feedback.diagnostics.field.app",
  runtime: "settings.feedback.diagnostics.field.runtime",
  error: "settings.feedback.diagnostics.field.error",
  notes: "settings.feedback.diagnostics.field.notes",
};

export interface FeedbackDiagnosticInput {
  /** 仅接受已本地化后的可读错误摘要，不接受原始错误对象或堆栈。 */
  errorSummary?: string;
  /** 用户自述的问题描述（可选）。 */
  description?: string;
}

export interface FeedbackDiagnosticRuntime {
  /**
   * 来自 IFeedbackService.getDeviceSnapshot() 的本地设备快照。
   * 这是纯本地构造函数，不发网络请求，因此可以直接调用。
   *
   * 快照本身**包含** deviceMid / hostname，但 buildFeedbackDiagnosticEntries 只按名读取
   * 版本与平台字段，不会把它们写进诊断条目——脱敏由该函数自己保证，
   * 不依赖调用方先做剔除（调用方若漏做就会静默泄漏）。
   */
  device?: FeedbackDeviceInfo;
}

export interface FeedbackDiagnosticEntry {
  id: FeedbackDiagnosticFieldId;
  value: string;
}

const CHANNEL_KIND_VALUES: readonly FeedbackChannelKind[] = ["github", "custom", "off"];

function normalizeFieldId(value: string): FeedbackDiagnosticFieldId | null {
  return (FEEDBACK_DIAGNOSTIC_FIELD_IDS as readonly string[]).includes(value)
    ? (value as FeedbackDiagnosticFieldId)
    : null;
}

/** 解析持久化字段时必须容忍脏数据：非法值回退默认，而不是让整个设置页读崩。 */
export function parseFeedbackDiagnosticFields(raw: unknown): FeedbackDiagnosticFieldId[] {
  if (!Array.isArray(raw)) {
    return [...FEEDBACK_DIAGNOSTIC_FIELD_IDS];
  }
  const parsed = raw
    .map((entry) => (typeof entry === "string" ? normalizeFieldId(entry) : null))
    .filter((entry): entry is FeedbackDiagnosticFieldId => entry !== null);
  // 全不勾选等于预填里没有任何诊断信息，容易被误读成「已附带环境信息」，
  // 因此空集合回退为默认全选；用户要清空可以直接在浏览器里删掉那一段。
  return parsed.length > 0 ? parsed : [...FEEDBACK_DIAGNOSTIC_FIELD_IDS];
}

export function isFeedbackChannelKind(value: unknown): value is FeedbackChannelKind {
  return typeof value === "string" && (CHANNEL_KIND_VALUES as readonly string[]).includes(value);
}

export function parseFeedbackChannelKind(raw: unknown): FeedbackChannelKind {
  return isFeedbackChannelKind(raw) ? raw : "github";
}

/** 平台标识转可读名称；未知平台原样返回，避免为了展示把信息丢掉。 */
export function describePlatform(platform: string | undefined): string {
  switch (platform?.trim().toLowerCase()) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return platform?.trim() || "unknown";
  }
}

/**
 * 构造脱敏诊断字段。这里刻意只收「版本 + 平台 + 用户可见错误摘要」：
 * deviceMid、hostname、账号标识、凭据、完整日志一律不进预填正文——它们要么属于设备身份，
 * 要么需要用户显式在浏览器里附加文件，不能靠一个链接静默带出去。
 */
export function buildFeedbackDiagnosticEntries(
  input: FeedbackDiagnosticInput,
  runtime: FeedbackDiagnosticRuntime = {},
): FeedbackDiagnosticEntry[] {
  const device = runtime.device;
  const appVersion = device?.appVersion?.trim() || ZCODE_VERSION;
  const buildCommit = device?.buildCommitId?.trim() || ZCODE_COMMIT;
  const buildTime = device?.buildTime?.trim() || ZCODE_BUILD_TIME;
  const platform = device?.osPlatform?.trim() || device?.osType?.trim();
  const release = device?.osRelease?.trim() || device?.osVersion?.trim();
  const arch = device?.osArch?.trim() || "unknown";
  const nodeVersion = device?.nodeVersion?.trim();
  const electronVersion = device?.electronVersion?.trim();

  const entries: FeedbackDiagnosticEntry[] = [
    {
      id: "app",
      value: `ZCode ${appVersion} (${buildCommit}, built ${buildTime})`,
    },
    {
      id: "runtime",
      value: [
        `OS ${describePlatform(platform)}${release ? ` ${release}` : ""} / ${arch}`,
        nodeVersion ? `Node ${nodeVersion}` : null,
        electronVersion ? `Electron ${electronVersion}` : null,
      ]
        .filter((part): part is string => part !== null)
        .join(" | "),
    },
  ];

  const errorSummary = input.errorSummary?.trim();
  if (errorSummary) {
    entries.push({ id: "error", value: errorSummary });
  }
  const description = input.description?.trim();
  if (description) {
    entries.push({ id: "notes", value: description });
  }
  return entries;
}

const DIAGNOSTIC_SECTION_HEADINGS: Record<"zh-CN" | "en-US", string> = {
  "zh-CN": "### 诊断信息（自动生成，可删除）",
  "en-US": "### Diagnostics (generated, safe to delete)",
};

/**
 * 把选中的诊断项拼成 markdown 正文。
 * 诊断段落单独成节并写明「可删除」，是因为预填内容会直接出现在 issue 编辑器里，
 * 用户必须先能一眼看出哪一段是机器加的、哪一段是自己写的。
 */
export function buildFeedbackBody(
  entries: ReadonlyArray<{ label: string; value: string }>,
  options: { locale: "zh-CN" | "en-US" },
): string {
  if (entries.length === 0) {
    return "";
  }
  return [
    DIAGNOSTIC_SECTION_HEADINGS[options.locale],
    "",
    ...entries.map((entry) => `- ${entry.label}: ${entry.value}`),
    "",
  ].join("\n");
}

/** 标题只取首行并限长，避免多行描述把 issue 标题撑成正文。 */
export function buildFeedbackIssueTitle(description: string | undefined): string {
  const normalized =
    description
      ?.split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  return normalized.slice(0, 80);
}

export interface FeedbackLinkTarget {
  channel: FeedbackChannelKind;
  customUrlTemplate?: string;
}

/** 未加占位符的自定义模板也能用：URL 上直接追加 title/body 查询参数。 */
function appendQueryParameters(url: URL, title: string, body: string): string {
  if (title && !url.searchParams.has("title")) {
    url.searchParams.set("title", title);
  }
  if (body && !url.searchParams.has("body")) {
    url.searchParams.set("body", body);
  }
  return url.toString();
}

/**
 * 只允许 http/https 作为反馈目标。
 *
 * 安全边界：`new URL("javascript:alert(1)")` 与 `data:` / `file:` 都能正常解析，
 * 若原样交给 `platform.openExternal()`，一个被篡改的自定义模板（或同步过来的配置）
 * 就能在用户点击「在浏览器中打开」时执行脚本 / 读取本地文件。
 * 自定义模板是用户可写输入，必须在这里 fail-closed。
 */
function isAllowedFeedbackProtocol(protocol: string): boolean {
  return protocol === "http:" || protocol === "https:";
}

function resolveCustomUrl(
  template: string | undefined,
  title: string,
  body: string,
): string | null {
  const trimmed = template?.trim();
  if (!trimmed) {
    return null;
  }
  // 自定义模板有两种写法，必须二选一，不能叠加：
  // 1) 带 {title}/{body} 占位符：用户已明确指定参数名（如 GitLab 的 issue[title]），
  //    再补 title/body 会生成一组重复且被目标站点忽略的参数；
  // 2) 不带占位符的基础 URL：按 issue tracker 的通用约定追加 title/body 查询参数，
  //    避免用户必须记住占位符语法。
  const usesPlaceholders = trimmed.includes("{title}") || trimmed.includes("{body}");
  const substituted = trimmed
    .replaceAll("{title}", encodeURIComponent(title))
    .replaceAll("{body}", encodeURIComponent(body));
  try {
    const url = new URL(substituted);
    if (!isAllowedFeedbackProtocol(url.protocol)) {
      return null;
    }
    return usesPlaceholders ? url.toString() : appendQueryParameters(url, title, body);
  } catch {
    return null;
  }
}

/**
 * 生成最终要打开的预填链接。
 * 返回 null 表示「当前配置下没有可打开的反馈入口」（渠道关闭、自定义 URL 非法或为空），
 * 调用方应据此禁用按钮，而不是打开一个半成品地址。
 */
export function buildFeedbackPrefilledUrl(options: {
  target: FeedbackLinkTarget;
  title: string;
  body: string;
  locale: "zh-CN" | "en-US";
}): string | null {
  const { target, title, body, locale } = options;
  if (target.channel === "off") {
    return null;
  }
  if (target.channel === "custom") {
    return resolveCustomUrl(target.customUrlTemplate, title, body);
  }
  const base = new URL(`${DEFAULT_FEEDBACK_REPOSITORY_URL.replace(/\/+$/, "")}/issues/new`);
  const issueTitle = title || (locale === "en-US" ? "Feedback" : "反馈");
  return appendQueryParameters(base, issueTitle, body);
}
