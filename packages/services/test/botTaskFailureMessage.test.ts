import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ZCODE_PROVIDER_RUNTIME_HEADERS_CAPABILITY_MISSING_CODE,
  ZCODE_PROVIDER_RUNTIME_HEADERS_UNAVAILABLE_CODE,
} from "../src/zcode-agent/zcodeAgent.js";
import { formatBotMessage } from "../src/bots/messages.js";
import {
  formatBotTaskFailureMessage,
  resolveBotTaskFailureHintId,
} from "../src/bots/taskFailureMessage.js";

/**
 * fix.2 回归：Bot 不得把 start-plan 快速失败的稳定码透传给用户。
 *
 * 缺陷背景：fix.1 给 host 加了「start-plan 无渲染层 / 无求解能力时快速失败」，
 * 错误以稳定码前缀内嵌在协议唯一的 errorMessage 承载位里
 * （zcodeAgentService.ts:2533-2538），而 Bot 把整串塞进 taskFailed 模板直接发给用户，
 * 用户看到的是 "ZCODE_PROVIDER_RUNTIME_HEADERS_CAPABILITY_MISSING: this client cannot solve ..."。
 *
 * 三条断言口径（对应任务书的三条测试要求）：
 *   ① 两个稳定码各自落到对应文案，且不是机器码原文；
 *   ② 非这两个码的错误仍走原样透传（不误伤其它错误）；
 *   ③ 三个发送点都走同一个出口（源码级），不留一处继续透传的旁路。
 *
 * 运行：cd packages/services && node --import tsx --test test/botTaskFailureMessage.test.ts
 */

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

/**
 * 与 zcodeAgentService.ts:2533-2538 逐字同形：稳定码 + ": " + 可读英文原因。
 * 抄一份而不是 import 生成函数，是因为那个拼接在 host 的私有分支里、不可导出；
 * 这里把线上实际形状固定下来，一旦 host 改了格式，本用例会先变红。
 */
function runtimeHeadersErrorMessage(code: string): string {
  return (
    `${code}: ` +
    "this client cannot solve the start-plan captcha challenge " +
    (code === ZCODE_PROVIDER_RUNTIME_HEADERS_UNAVAILABLE_CODE
      ? "(no session event subscriber available to render it)"
      : "(no subscriber declared captcha rendering capability)")
  );
}

test("① 两个稳定码各自落到对应文案，且用户看不到机器码原文", () => {
  const cases = [
    {
      code: ZCODE_PROVIDER_RUNTIME_HEADERS_UNAVAILABLE_CODE,
      messageId: "taskFailedProviderRuntimeHeadersUnavailable",
    },
    {
      code: ZCODE_PROVIDER_RUNTIME_HEADERS_CAPABILITY_MISSING_CODE,
      messageId: "taskFailedProviderRuntimeHeadersCapabilityMissing",
    },
  ] as const;

  for (const locale of ["zh-CN", "en-US"] as const) {
    const rendered: string[] = [];
    for (const item of cases) {
      const errorText = runtimeHeadersErrorMessage(item.code);
      const actual = formatBotTaskFailureMessage(locale, errorText);
      // 落到对应文案：taskFailed 模板 + 该码专属的那一句（逐字比对，不是"包含关键词"）。
      const expected = formatBotMessage(locale, "taskFailed", {
        message: formatBotMessage(locale, item.messageId),
      });
      assert.equal(actual, expected, `${locale} 的 ${item.code} 未落到专属文案`);
      // 机器码原文不得出现在给用户的消息里（这是本缺陷的全部内容）。
      assert.equal(
        actual.includes(item.code),
        false,
        `${locale} 的 ${item.code} 被透传给了用户：${actual}`,
      );
      assert.equal(
        /captcha challenge|no session event subscriber/.test(actual),
        false,
        `${locale} 泄漏了 host 侧英文内部原因：${actual}`,
      );
      // 可操作性：文案必须给出下一步（换界面/换渠道），否则只是把机器码换成另一句废话。
      assert.match(
        actual,
        locale === "zh-CN" ? /桌面端|浏览器/ : /desktop app|browser/i,
        `${locale} 的文案没有可操作出口：${actual}`,
      );
      rendered.push(actual);
    }
    // 两个码含义不同 ⇒ 文案必须不同（合成一句就丢掉了 zcodeAgent.ts:190-193 刻意分开的理由）。
    assert.notEqual(rendered[0], rendered[1], `${locale}：两个不同的码给了同一条文案`);
  }
});

test("① 附带：文案差异点说清了两种成因（本端无界面 vs 该渠道需人工校验）", () => {
  const zhUnavailable = formatBotTaskFailureMessage(
    "zh-CN",
    runtimeHeadersErrorMessage(ZCODE_PROVIDER_RUNTIME_HEADERS_UNAVAILABLE_CODE),
  );
  const zhCapability = formatBotTaskFailureMessage(
    "zh-CN",
    runtimeHeadersErrorMessage(ZCODE_PROVIDER_RUNTIME_HEADERS_CAPABILITY_MISSING_CODE),
  );
  // UNAVAILABLE = 本机没有能完成校验的界面；CAPABILITY_MISSING = 有界面但这个渠道要人工做。
  assert.match(zhUnavailable, /界面/, "UNAVAILABLE 应说明本机缺界面");
  assert.match(zhCapability, /机器人无法完成/, "CAPABILITY_MISSING 应说明该渠道机器人做不到");
  assert.match(zhCapability, /渠道/, "CAPABILITY_MISSING 应给出换渠道这条出路");
});

test("② 非这两个码的错误仍原样透传（不误伤其它错误）", () => {
  const passthrough = [
    "ZCode session failed",
    "Provider request auth is missing",
    // 前缀相近但不同的码不得命中（防止写成 startsWith("ZCODE_PROVIDER_RUNTIME_HEADERS") 这类过粗判据）。
    "ZCODE_PROVIDER_RUNTIME_HEADERS_SOMETHING_ELSE: x",
    // 另一个同族稳定码（runtime unavailable）不在本次范围内，必须继续原样透传。
    "ZCODE_AGENT_RUNTIME_UNAVAILABLE: ZCode Agent runtime is not running.",
    "",
  ];
  for (const locale of ["zh-CN", "en-US"] as const) {
    for (const errorText of passthrough) {
      assert.equal(
        formatBotTaskFailureMessage(locale, errorText),
        formatBotMessage(locale, "taskFailed", { message: errorText }),
        `${locale}：${errorText} 被误改了`,
      );
    }
  }
  // 判定函数本身：命中才返回 id，否则 null。
  assert.equal(resolveBotTaskFailureHintId("boom"), null);
  assert.equal(resolveBotTaskFailureHintId(undefined), null);
  assert.equal(
    resolveBotTaskFailureHintId(
      runtimeHeadersErrorMessage(ZCODE_PROVIDER_RUNTIME_HEADERS_UNAVAILABLE_CODE),
    ),
    "taskFailedProviderRuntimeHeadersUnavailable",
  );
});

test("② 附带：码被别的层包装后仍能识别（不是靠「前缀相等」）", () => {
  // RuntimeHeadersRefreshError 会把 cause.message 原样上抛（runner-runtime-headers.ts:5-10），
  // 因此线上可能看到码不在字符串开头的形态。按整串搜索对两种形态都成立。
  const wrapped =
    "RuntimeHeadersRefreshError: " +
    runtimeHeadersErrorMessage(ZCODE_PROVIDER_RUNTIME_HEADERS_CAPABILITY_MISSING_CODE);
  assert.equal(
    resolveBotTaskFailureHintId(wrapped),
    "taskFailedProviderRuntimeHeadersCapabilityMissing",
  );
});

test("③ 三个 task_error 发送点都走同一出口（源码级：不留继续透传的旁路）", () => {
  const source = readFileSync(join(packageRoot, "src/bots/botsService.ts"), "utf8");
  // 修复前这里有三处 `msg(locale, "taskFailed", { message: event.error })`。
  // 现在 event.error 只能经 formatBotTaskFailureMessage 出去。
  assert.equal(
    /"taskFailed",\s*\{\s*message:\s*event\.error/.test(source),
    false,
    "仍有 task_error 分支直接透传 event.error",
  );
  const routed = source.match(/formatBotTaskFailureMessage\(/g) ?? [];
  assert.equal(routed.length, 3, `task_error 的出口数应为 3，实际 ${routed.length}`);
  // 该出口必须是声明处之外的调用（导入一行 + 三处调用）。
  assert.match(
    source,
    /import \{ formatBotTaskFailureMessage \} from "\.\/taskFailureMessage\.js"/,
  );
});
