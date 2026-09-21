/** 允许定位到窗口的最小像素边长。 */
export declare const MIN_WINDOW_EDGE_PX: number;

export interface CuaAppRef {
  name?: string;
  bundle_id?: string;
  pid?: number;
  window_id?: number;
}

/** app_ref → 稳定的会话内键。 */
export declare function appKeyOf(appRef: CuaAppRef): string;

/** app 行是否匹配 app_ref（bundle_id > pid > name）。 */
export declare function matchesRef(app: unknown, appRef: CuaAppRef): boolean;

/** 过滤掉 0x0 的合成窗口。 */
export declare function usableWindows(windows: unknown): unknown[];

/** 挑目标窗口：给了 window_id 就精确匹配，否则取面积最大的。 */
export declare function pickWindow(windows: unknown[], windowId?: number): unknown;

/** 驱动元素行 → 模型可见的 AXElement。 */
export declare function toElement(raw: Record<string, unknown>): Record<string, unknown>;

/** target → 驱动动作参数（element_token 或坐标）。 */
export declare function resolveTarget(
  target: unknown,
  observation: { elements?: { element_token?: string }[] } | undefined,
): Record<string, unknown>;
