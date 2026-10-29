import assert from "node:assert/strict";
import test from "node:test";
import zhCN from "../src/i18n/locales/zh-CN.js";
import enUS from "../src/i18n/locales/en-US.js";
import {
  isRequestVerificationTerminalError,
  requestVerificationActionMessages,
  requestVerificationClaimFailureMessageId,
  requestVerificationRecoveryAction,
  resolveRequestVerificationBusinessCode,
} from "../src/request-security-edition/errors.js";

/**
 * 3007 验证码三件套的结构化半边（另一半是文案与横幅按钮）。
 *
 * 这个模块原先全为空桩：3007 被当成普通业务错误，既没有「验证码」语义也没有重试动作。
 * 本测试钉住三件事：
 * 1. 只按业务码分流（不按错误文案——不制造第二条判据）；
 * 2. 恢复动作是 retry-captcha，且它的文案 key 在中英字典里都存在；
 * 3. claim 失败用专用的 captcha 文案，不退回 generic。
 */

test("判据 1：3007 归入验证码语义，其它业务码不分流", () => {
  assert.equal(resolveRequestVerificationBusinessCode("3007", "任意文案"), "3007");
  assert.equal(resolveRequestVerificationBusinessCode("1006", "请完成安全验证"), undefined);
  assert.equal(resolveRequestVerificationBusinessCode(undefined, "security verification"), undefined);
  assert.equal(isRequestVerificationTerminalError({ code: "3007" }), true);
  assert.equal(isRequestVerificationTerminalError({ code: "1005", message: "x" }), false);
});

test("判据 2：重试动作与文案 key 双语在位", () => {
  assert.equal(requestVerificationRecoveryAction, "retry-captcha");
  const messageId = requestVerificationActionMessages[requestVerificationRecoveryAction];
  assert.equal(messageId, "chat.error.action.retryCaptcha");
  assert.ok(messageId in zhCN && messageId in enUS);
  assert.equal(zhCN["zcode.error.providerBusiness.3007"], "验证码校验失败，请重试。");
});

test("判据 3：claim 失败使用 captcha 专用文案", () => {
  assert.equal(requestVerificationClaimFailureMessageId, "manual_claim_failure_captcha");
  assert.ok(requestVerificationClaimFailureMessageId in zhCN);
  assert.ok(requestVerificationClaimFailureMessageId in enUS);
});
