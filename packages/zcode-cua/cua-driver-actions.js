/**
 * ZCode CUA 动作 method → cua-driver 工具调用的**入参翻译表**。
 *
 * 每个 method 的模型可见签名（computer-use.md 的「Tool arguments」）与驱动工具的入参
 * 形状不同：`scroll_direction`/`scroll_amount` 要变成 `direction`/`by`/`amount`，
 * `key` 的 `"ctrl+shift+a"` 要拆成 `key` + `modifiers`，`drag` 的 `to` 目标要
 * 展平成 `to_x`/`to_y`。写错字段名的后果是静默的：驱动只回一句
 * `unrecognized_keys` 或干脆按默认值执行，真机上才暴露。
 *
 * 拆成独立模块的理由：这是一张纯数据表，和运行时的生命周期/串行化无关；
 * 参数校验错误统一抛 invalid_request，由运行时翻成 MCP 错误信封。
 */

import { CuaBrokerError } from "./cua-driver-errors.js";

/** 必填文本字段的守卫：空串在驱动侧会变成一次无操作输入，必须在本地拒绝。 */
export function requireText(value, what) {
  if (typeof value !== "string" || !value) {
    throw new CuaBrokerError(`${what} requires non-empty text`, { code: "invalid_request" });
  }
  return value;
}

/**
 * method 名 → { tool, target?, args }。
 *
 * `target` 返回 undefined 表示该方法**不接收目标**（`type`/`key` 的输入落到当前焦点）；
 * 运行时据此跳过目标解析，而不是把 undefined 当成非法目标。
 */
export const CUA_ACTIONS = Object.freeze({
  left_click: (a) => ({
    tool: "click",
    target: () => a.target,
    args: () => ({
      ...(typeof a.click_count === "number" ? { count: a.click_count } : {}),
      ...(typeof a.mouse_button === "string" ? { button: a.mouse_button } : {}),
    }),
  }),

  left_click_drag: (a) => ({
    tool: "drag",
    target: () => a.from_target,
    args: () => {
      const to = a.to;
      if (!to || to.type !== "coordinate" || !Number.isInteger(to.x) || !Number.isInteger(to.y)) {
        throw new CuaBrokerError("drag requires a {type:'coordinate',x,y} destination", {
          code: "invalid_request",
        });
      }
      return { to_x: to.x, to_y: to.y };
    },
  }),

  type: (a) => ({
    tool: "type_text",
    target: () => a.target,
    args: () => ({ text: requireText(a.text, "type") }),
  }),

  scroll: (a) => ({
    tool: "scroll",
    target: () => a.target,
    args: () => {
      const direction = String(a.scroll_direction ?? "").toLowerCase();
      if (!["up", "down", "left", "right"].includes(direction)) {
        throw new CuaBrokerError("scroll_direction must be up, down, left or right", {
          code: "invalid_request",
        });
      }
      const pages = typeof a.scroll_amount === "number" ? a.scroll_amount : 1;
      // 驱动把 amount 限制在 1..50；越界会被它拒绝，这里先夹紧而不是报错。
      return { direction, by: "page", amount: Math.min(50, Math.max(1, Math.round(pages))) };
    },
  }),

  set_value: (a) => ({
    tool: "set_value",
    target: () => a.target,
    args: () => {
      if (typeof a.value !== "string") {
        throw new CuaBrokerError("set_value requires a string value", { code: "invalid_request" });
      }
      return { value: a.value };
    },
  }),

  key: (a) => ({
    tool: "press_key",
    args: () => {
      const chord = requireText(a.text, "key").trim();
      // 客户端已把和弦规范化成 "+" 连接的形态（normalizeKeyChord）。
      // 拆成 key + modifiers 才是驱动的入参形状。
      const parts = chord
        .split("+")
        .map((part) => part.trim())
        .filter(Boolean);
      const key = parts.pop();
      return { key, ...(parts.length ? { modifiers: parts } : {}) };
    },
  }),
});
