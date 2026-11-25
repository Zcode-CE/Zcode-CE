import assert from "node:assert/strict";
import test from "node:test";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import type { IntlInstance } from "../src/i18n/IntlProvider.js";
import { resolveChatErrorBannerDisplayMessage } from "../src/ChatErrorBanner.js";

/**
 * 会话删除中（SESSION_DELETING）在错误横幅上的最终文案。
 *
 * 为什么要钉住消费点：适配器只负责把 SQLite 触发器原文换成稳定 code，真正让用户看到中文的是
 * `LOCALIZED_ERROR_CODES` + `zcode.error.<code>` 这条链。少登记一处，用户就会看到英文 message
 * 甚至触发器原文 —— 这类回归没有任何类型或运行时错误，只能靠用例暴露。
 */

/** 与 UI 的 IntlInstance 同形：按 id 查字典，缺键回退 id。 */
function intlFor(messages: Record<string, string>): IntlInstance {
  return {
    formatMessage: ({ id }) => messages[id] ?? id,
  };
}

const deletingError = {
  code: "SESSION_DELETING",
  message:
    "This session is being deleted by a newer ZCode version, so this build will not write to it.",
};

test("SESSION_DELETING 按 code 显示本地化文案，而不是英文 message", () => {
  assert.equal(
    resolveChatErrorBannerDisplayMessage(deletingError, intlFor(zhCN)),
    zhCN["zcode.error.SESSION_DELETING"],
  );
  assert.equal(
    resolveChatErrorBannerDisplayMessage(deletingError, intlFor(enUS)),
    enUS["zcode.error.SESSION_DELETING"],
  );
  // 文案必须说明「该会话正在删除中」，而不是把触发器原文原样抛出。
  assert.match(zhCN["zcode.error.SESSION_DELETING"] ?? "", /正在删除中/);
});

test("未登记本地化的 code 仍然回退到原始 message（不过度本地化）", () => {
  const raw = { code: "SOME_UNLISTED_CODE", message: "raw sqlite wording" };
  assert.equal(resolveChatErrorBannerDisplayMessage(raw, intlFor(zhCN)), "raw sqlite wording");
});
