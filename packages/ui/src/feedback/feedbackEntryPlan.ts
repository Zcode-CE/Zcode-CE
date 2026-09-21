import { redactFeedbackText } from "@zcode/shared";
import {
  FEEDBACK_DIAGNOSTIC_FIELD_LABEL_IDS,
  buildFeedbackBody,
  buildFeedbackDiagnosticEntries,
  buildFeedbackIssueTitle,
  buildFeedbackPrefilledUrl,
  type FeedbackDiagnosticEntry,
  type FeedbackDiagnosticFieldId,
  type FeedbackDiagnosticRuntime,
} from "@/feedback/feedbackDiagnostics.js";
import type { FeedbackEntryContext } from "@/feedback/feedbackEntryContext.js";
import type { FeedbackDiagnosticsPreference } from "@/feedback/feedbackDiagnosticsPreference.js";

/**
 * 反馈预填内容的**共用编排层**：把「渠道偏好 + 入口现场 + 本机设备快照」变成最终要打开的地址。
 *
 * 为什么要有这一层（而不是让入口和设置页各写一遍）：
 * - 反馈入口分散在 8 个组件里，设置页还有一份自己的预览；真正需要被反复验证的只有这一处裁决；
 *   抽成纯函数后可以用 node:test 直接跑，不需要渲染任何 React 组件。
 * - 预填正文与 URL 拼接只走这一条路径，**脱敏**与 http(s) 白名单
 *   （buildFeedbackPrefilledUrl 的 fail-closed）因此天然被两边继承，
 *   不会出现「入口安全、设置页不安全」这种分叉。
 *
 * 返回 null 表示「当前配置下没有可安全打开的外部地址」，调用方必须改为引导用户去设置页，
 * 而不是打开一个半成品或危险 scheme 的地址。
 */

/**
 * 预填内容的**唯一脱敏收口点**。
 *
 * 为什么必须在这里做，而不是指望每个入口自己先脱敏：
 * 有**四条**路会把文本送进对外可见的 URL——
 * 1. `description`（由 errorFeedbackDraft / taskFeedbackDraft 构造，内部已脱敏）；
 * 2. `errorSummary`（入口直接传错误原文，**未脱敏**）；
 * 3. issue **标题**（由 errorSummary / description 首行推导，同样未脱敏，且连诊断段落都没进，最隐蔽）；
 * 4. 设置页「问题描述」输入框（用户手输，未脱敏）。
 *
 * 实测前 3 条路上，4 组载荷（Bearer JWT / `?api_key=` / `password=` / `{"token":"..."}`）
 * 全部原样进入了最终 URL。这里统一收口后，8 个入口、标题路径与设置页预览自动继承，
 * 不会再出现「第五条路」。
 *
 * 该函数是幂等的（已实测 f(f(x)) === f(x)），因此对已经脱敏过的 `description`
 * 再跑一次不会破坏内容，也不会出现双重转义。
 */
export function redactFeedbackEntryText(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  return trimmed ? redactFeedbackText(trimmed) : undefined;
}

/** 把入口现场整体脱敏；title / errorSummary / description 三条路一起覆盖。 */
function redactEntryContext(context: FeedbackEntryContext): FeedbackEntryContext {
  const errorSummary = redactFeedbackEntryText(context.errorSummary);
  const description = redactFeedbackEntryText(context.description);
  const title = redactFeedbackEntryText(context.title);
  return {
    ...(errorSummary ? { errorSummary } : {}),
    ...(description ? { description } : {}),
    ...(title ? { title } : {}),
  };
}

/**
 * 构造脱敏后的诊断项。
 * 设置页的勾选列表与预览用这个，而不是直接调 buildFeedbackDiagnosticEntries，
 * 否则「用户手输的描述」这条路径会绕过脱敏。
 */
export function buildFeedbackEntryDiagnostics(options: {
  context: FeedbackEntryContext;
  runtime?: FeedbackDiagnosticRuntime;
}): FeedbackDiagnosticEntry[] {
  const context = redactEntryContext(options.context);
  return buildFeedbackDiagnosticEntries(
    {
      // 到这里 errorSummary / description 一定已经过 redactFeedbackText，
      // 不再依赖调用方自觉——调用方漏做就是静默泄漏到对外可见的 URL 上。
      ...(context.errorSummary ? { errorSummary: context.errorSummary } : {}),
      ...(context.description ? { description: context.description } : {}),
    },
    options.runtime ?? {},
  );
}

/** 把诊断项拼成 markdown 正文；入口与设置页预览共用同一组字段标签与分节规则。 */
export function buildFeedbackEntryBody(options: {
  context: FeedbackEntryContext;
  diagnosticFields: readonly FeedbackDiagnosticFieldId[];
  locale: "zh-CN" | "en-US";
  formatMessage: (id: string) => string;
  /** 设置页可带上本机设备快照；入口侧不传，缺省字段由 buildFeedbackDiagnosticEntries 兜底。 */
  runtime?: FeedbackDiagnosticRuntime;
}): string {
  const entries = buildFeedbackEntryDiagnostics({
    context: options.context,
    ...(options.runtime ? { runtime: options.runtime } : {}),
  });
  return buildFeedbackBody(
    entries
      .filter((entry) => options.diagnosticFields.includes(entry.id))
      .map((entry) => ({
        label: options.formatMessage(FEEDBACK_DIAGNOSTIC_FIELD_LABEL_IDS[entry.id]),
        value: entry.value,
      })),
    { locale: options.locale },
  );
}

/**
 * issue 标题优先级：入口显式给的 title → 错误摘要首行 → 描述首行。
 *
 * 错误摘要优先于描述，是因为描述往往是多段的模板正文（含「期望结果」等空段落），
 * 拿它的首行当标题会得到「报错摘要：xxx」这种带前缀的标题，不如直接用错误摘要本身。
 *
 * 注意：标题**同样是对外可见内容**，因此这里也走 redactEntryContext——
 * 标题不进诊断段落，是最容易被漏掉的一条泄漏路径。
 */
export function resolveFeedbackEntryTitle(context: FeedbackEntryContext): string {
  const redacted = redactEntryContext(context);
  return (
    redacted.title?.trim() ||
    buildFeedbackIssueTitle(redacted.errorSummary) ||
    buildFeedbackIssueTitle(redacted.description)
  );
}

/** 计算入口点击要打开的外部地址；null 表示渠道关闭或地址非法（fail-closed）。 */
export function buildFeedbackEntryUrl(options: {
  preference: FeedbackDiagnosticsPreference;
  context: FeedbackEntryContext;
  locale: "zh-CN" | "en-US";
  formatMessage: (id: string) => string;
  runtime?: FeedbackDiagnosticRuntime;
}): string | null {
  const { preference, context, locale, formatMessage, runtime } = options;
  return buildFeedbackPrefilledUrl({
    target: { channel: preference.channel, customUrlTemplate: preference.customUrlTemplate },
    title: resolveFeedbackEntryTitle(context),
    body: buildFeedbackEntryBody({
      context,
      diagnosticFields: preference.diagnosticFields,
      locale,
      formatMessage,
      ...(runtime ? { runtime } : {}),
    }),
    locale,
  });
}
