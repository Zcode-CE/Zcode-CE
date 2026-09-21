/**
 * ZCode CUA 协议 → cua-driver 的**目标解析**。
 *
 * 两侧定位模型不同构，这里是翻译层：
 * - ZCode 用 `app_ref`（name / bundle_id / pid，可带 window_id）定位应用；
 *   驱动只认 `pid`，窗口另给 `window_id`。
 * - ZCode 的观察结果要回传 `state_id` + 元素表；驱动的元素动作只认
 *   `element_token`（或 snapshot_id + element_index）。
 *
 * 拆成独立模块的理由：这些函数全部是「输入 → 驱动参数」的纯翻译，不持有运行时状态，
 * 只有观察表按会话键传入。混在运行时里会让那个文件既管生命周期又管协议细节。
 */

import { CuaBrokerError } from "./cua-driver-errors.js";

/**
 * 允许定位到窗口的最小像素边长。
 *
 * 驱动的窗口表里混着 0x0 的合成窗口（实测同一 pid 同时给出主窗口与若干 0x0 行），
 * 不过滤会把「主窗口」选成一个不可见的幽灵。
 */
export const MIN_WINDOW_EDGE_PX = 1;

/** app_ref → 稳定的会话内键。用于把观察记录按 (会话, 应用) 归档。 */
export function appKeyOf(appRef) {
  if (appRef?.bundle_id) return `bundle:${appRef.bundle_id}`;
  if (appRef?.pid) return `pid:${appRef.pid}`;
  return `name:${String(appRef?.name ?? "").toLowerCase()}`;
}

/** app 行是否匹配 app_ref。字段优先级：bundle_id > pid > name。 */
export function matchesRef(app, appRef) {
  if (typeof appRef?.bundle_id === "string" && appRef.bundle_id) {
    return app.bundle_id === appRef.bundle_id;
  }
  if (typeof appRef?.pid === "number" && appRef.pid > 0) return app.pid === appRef.pid;
  const name = typeof appRef?.name === "string" ? appRef.name.trim() : "";
  if (!name) return false;
  if (app.name === name) return true;
  return typeof app.name === "string" && app.name.toLowerCase() === name.toLowerCase();
}

/** 驱动窗口行 → 只保留真正可定位的窗口。 */
export function usableWindows(windows) {
  return (Array.isArray(windows) ? windows : []).filter(
    (w) => Number(w.width) >= MIN_WINDOW_EDGE_PX && Number(w.height) >= MIN_WINDOW_EDGE_PX,
  );
}

/**
 * 在窗口表里挑目标窗口。
 *
 * 不带 window_id 时取面积最大的窗口，而不是第一行：驱动的行序不保证主窗口在前，
 * 按面积取更稳定（实测 Dolphin 的主窗口与合成窗口混排）。
 */
export function pickWindow(windows, windowId) {
  if (windowId !== undefined) return windows.find((w) => w.window_id === windowId);
  return windows.slice().sort((a, b) => b.width * b.height - a.width * a.height)[0];
}

/** 驱动元素行 → 模型可见的 AXElement，并保留 element_token 供动作解析。 */
export function toElement(raw) {
  return {
    index: raw.element_index,
    kind: raw.role,
    title: raw.label ?? null,
    value: typeof raw.value === "string" ? raw.value : null,
    actions: Array.isArray(raw.actions) ? raw.actions : [],
    enabled: raw.enabled !== false,
    ...(typeof raw.element_token === "string" ? { element_token: raw.element_token } : {}),
  };
}

/**
 * `target` → 驱动动作参数。
 *
 * 元素索引按「该 app 最近一次观察」解析（与 Codex 同档）：查不到观察记录就报
 * element_unavailable 让模型先观察，**绝不猜一个索引** —— 猜错会静默点到别的控件。
 */
export function resolveTarget(target, observation) {
  if (target && typeof target === "object" && !Array.isArray(target)) {
    if (target.type === "element") {
      const index = target.index;
      if (!Number.isInteger(index) || index < 0) {
        throw new CuaBrokerError("target element index must be a non-negative integer", {
          code: "invalid_request",
        });
      }
      const element = observation?.elements?.[index];
      if (!element?.element_token) {
        throw new CuaBrokerError(
          "this element index has no live observation; call getAXState() on the bound app first",
          { code: "element_unavailable", details: { need: "getAXState" } },
        );
      }
      return { element_token: element.element_token };
    }
    if (target.type === "coordinate") {
      const { x, y } = target;
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) {
        throw new CuaBrokerError("target coordinate must be two non-negative integer pixels", {
          code: "invalid_request",
        });
      }
      return { x, y };
    }
  }
  throw new CuaBrokerError("target must be {type:'element',index} or {type:'coordinate',x,y}", {
    code: "invalid_request",
  });
}
