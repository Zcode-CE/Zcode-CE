/** 必填文本字段守卫：空串在驱动侧会变成无操作输入。 */
export declare function requireText(value: unknown, what: string): string;

export interface CuaActionPlan {
  tool: string;
  /** 返回 undefined 表示该方法不接收目标（输入落到当前焦点）。 */
  target?: () => unknown;
  args: () => Record<string, unknown>;
}

/** method 名 → 驱动工具调用的入参翻译表。 */
export declare const CUA_ACTIONS: Readonly<Record<string, (args: any) => CuaActionPlan>>;
