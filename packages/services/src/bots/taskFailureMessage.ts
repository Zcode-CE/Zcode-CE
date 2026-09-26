import type { Locale } from "@zcode/shared";
import {
  ZCODE_PROVIDER_RUNTIME_HEADERS_CAPABILITY_MISSING_CODE,
  ZCODE_PROVIDER_RUNTIME_HEADERS_UNAVAILABLE_CODE,
} from "../zcode-agent/zcodeAgent.js";
import { formatBotMessage, type BotMessageId } from "./messages.js";

/**
 * 任务失败文案的归一化（fix.2）。
 *
 * 缺陷背景：fix.1 给 host 加了「start-plan 无渲染层 / 无求解能力时快速失败」，
 * 错误以稳定码前缀内嵌在协议唯一的 errorMessage 承载位里
 * （packages/services/src/zcode-agent/zcodeAgentService.ts:2533-2538，形如
 * "ZCODE_PROVIDER_RUNTIME_HEADERS_CAPABILITY_MISSING: this client cannot solve ..."）。
 * 而 Bot 把该字符串直接塞进 taskFailed 模板透传给用户 —— 用户看到的是机器码 + 英文内部原因，
 * 既读不懂也不知道下一步该做什么。
 *
 * 为什么按稳定码分流而不是按文案匹配：稳定码是协议侧的分支依据
 * （zcodeAgent.ts:186 的注释原文「文案只负责给人看」），文案会变、码不会。
 * 这里只做「码 → 文案」的映射，不改协议、不改 agent 侧判定。
 *
 * 为什么两种码给两条不同文案：它们的成因不同，用户能做的事也不同。
 *   · UNAVAILABLE：本端根本没有会话订阅者（无 pane 后台会话、纯 CLI）⇒ 换个有界面的地方就能做；
 *   · CAPABILITY_MISSING：有订阅者但它无法渲染验证码（Bot 链路正是这一种）
 *     ⇒ 该渠道需要人工在界面里完成校验，换渠道也是一条出路。
 * 把两者合成一句会丢掉这个区别，正是 zcodeAgent.ts:190-193 刻意分成两个码的理由。
 */
const TASK_FAILURE_HINT_BY_CODE: Record<string, BotMessageId> = {
  [ZCODE_PROVIDER_RUNTIME_HEADERS_UNAVAILABLE_CODE]: "taskFailedProviderRuntimeHeadersUnavailable",
  [ZCODE_PROVIDER_RUNTIME_HEADERS_CAPABILITY_MISSING_CODE]:
    "taskFailedProviderRuntimeHeadersCapabilityMissing",
};

/**
 * 判定一条失败文本里是否内嵌了这两个稳定码，返回对应的可操作文案 id；没有则返回 null。
 *
 * 用「包含」而不是「前缀相等」：协议 schema 只有 errorMessage 一个承载位
 * （zcodeAgentService.ts:2531-2532 已说明），码现在是前缀，但一旦将来被别的层
 * 包装（例如 RuntimeHeadersRefreshError 把 cause.message 原样上抛），前缀位置就会漂移。
 * 按整串搜索对两种形态都成立，且这两个码是全大写下划线长串，不会误伤普通错误文本。
 */
export function resolveBotTaskFailureHintId(errorText: unknown): BotMessageId | null {
  const text = typeof errorText === "string" ? errorText : String(errorText ?? "");
  for (const [code, messageId] of Object.entries(TASK_FAILURE_HINT_BY_CODE)) {
    if (text.includes(code)) {
      return messageId;
    }
  }
  return null;
}

/**
 * 把 task 失败原因转成用户可读的一条消息。唯一出口（三个 task_error 发送点都走这里）。
 *
 * 两个稳定码 ⇒ 专用可操作文案（原始机器码不外泄）；其余错误 ⇒ 原样透传，
 * 与修复前逐字一致（不误伤其它错误）。
 */
export function formatBotTaskFailureMessage(
  locale: Locale | undefined,
  errorText: unknown,
): string {
  const hintId = resolveBotTaskFailureHintId(errorText);
  if (hintId) {
    return formatBotMessage(locale, "taskFailed", {
      message: formatBotMessage(locale, hintId),
    });
  }
  const text = typeof errorText === "string" ? errorText : String(errorText ?? "");
  return formatBotMessage(locale, "taskFailed", { message: text });
}
