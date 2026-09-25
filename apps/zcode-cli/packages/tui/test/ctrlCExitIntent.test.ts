import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CTRL_C_EXIT_CONFIRMATION_WINDOW_MS,
  createCtrlCExitGuard,
  resolveCtrlCExitIntent,
  resetCtrlCExitGuard,
} from "../src/app-keyboard-helpers.js";

/**
 * 「两次 Ctrl-C 才退出」的判定。
 *
 * 为什么单独测这个纯函数（而不是在 pty 上模拟按键）：`scripts/zcode-distribution-smoke.mjs`
 * 曾经往 pty 里写 \u0003 来验证"键盘退出链路"，但那个手段本质上不可靠 ——
 * 0x03 的落点取决于当时是否已进入 raw mode（竞态）：
 *   · 未设 raw ⇒ ISIG 把它转成真 SIGINT ⇒ OpenTUI 的 exitSignals 直接 destroy ⇒ 退出码 130；
 *   · 已设 raw ⇒ 它变成普通字节，而按键处理收不到 ⇒ 进程根本不退出（实测 5/5 超时）。
 * 实测退出码分布随等待时长单调恶化（0ms→[0,0,0,0,130] … 5000ms→[130,130,0,130,130]）。
 * ⇒ 该链路的判定逻辑在这里确定性验证；smoke 那边只验证"进程能被干净终止"。
 */

test("首次 Ctrl-C：只提示，不退出", () => {
  const guard = createCtrlCExitGuard();
  assert.equal(resolveCtrlCExitIntent(guard, 1_000), "show_prompt");
  // 提示过一次后，guard 记住了时刻（下一次才可能确认退出）。
  assert.equal(guard.lastPressAtMs, 1_000);
});

test("窗口内第二次 Ctrl-C：确认退出，并清掉记录", () => {
  const guard = createCtrlCExitGuard();
  assert.equal(resolveCtrlCExitIntent(guard, 1_000), "show_prompt");
  assert.equal(resolveCtrlCExitIntent(guard, 1_000 + 200), "confirm_exit");
  // 确认退出后必须清空：否则第三次按会被当成"窗口内第二次"，行为不可预期。
  assert.equal(guard.lastPressAtMs, undefined);
});

test("边界：恰好等于窗口宽度仍算确认退出", () => {
  const guard = createCtrlCExitGuard();
  resolveCtrlCExitIntent(guard, 1_000);
  assert.equal(
    resolveCtrlCExitIntent(guard, 1_000 + CTRL_C_EXIT_CONFIRMATION_WINDOW_MS),
    "confirm_exit",
  );
});

test("超出窗口：退回到提示（不退出）", () => {
  const guard = createCtrlCExitGuard();
  resolveCtrlCExitIntent(guard, 1_000);
  assert.equal(
    resolveCtrlCExitIntent(guard, 1_000 + CTRL_C_EXIT_CONFIRMATION_WINDOW_MS + 1),
    "show_prompt",
  );
  // 这一按变成了新的"首次"，所以记录的是新时刻。
  assert.equal(guard.lastPressAtMs, 1_000 + CTRL_C_EXIT_CONFIRMATION_WINDOW_MS + 1);
});

test("resetCtrlCExitGuard：清掉记录后，下一次按又是首次", () => {
  const guard = createCtrlCExitGuard();
  resolveCtrlCExitIntent(guard, 1_000);
  resetCtrlCExitGuard(guard);
  assert.equal(guard.lastPressAtMs, undefined);
  assert.equal(resolveCtrlCExitIntent(guard, 1_100), "show_prompt");
});

test("时间倒流（elapsed < 0）不误判为确认退出", () => {
  const guard = createCtrlCExitGuard();
  resolveCtrlCExitIntent(guard, 1_000);
  // 真实场景：系统时钟回拨或用了不同的时间源。负数间隔不该被当作"窗口内"。
  assert.equal(resolveCtrlCExitIntent(guard, 900), "show_prompt");
});
