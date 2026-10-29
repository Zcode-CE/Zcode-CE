/**
 * 侧边面板全视图的状态迁移（CE 版）。
 *
 * 抽成 reducer 的原因：退出规则有三条（再次 toggle、面板不可见、owner 变化），
 * 它们此前分散在三个 effect 里，测试只能做源码断言；reducer 能直接钉住每条迁移，
 * 也避免「面板已关但全视图状态残留」这类只能靠人工发现的回归。
 */
export interface SidePaneFullViewState {
  active: boolean;
  /** 当前记住的 owner（taskId / __draft__）；owner 变化即复位。 */
  owner: string | null;
}

export type SidePaneFullViewAction =
  | { type: "toggle" }
  | { type: "panelHidden" }
  | { type: "ownerChanged"; owner: string | null };

export function sidePaneFullViewReducer(
  state: SidePaneFullViewState,
  action: SidePaneFullViewAction,
): SidePaneFullViewState {
  switch (action.type) {
    case "toggle":
      return { ...state, active: !state.active };
    case "panelHidden":
      return state.active ? { ...state, active: false } : state;
    case "ownerChanged":
      if (action.owner === state.owner) return state;
      return { owner: action.owner, active: false };
  }
}
