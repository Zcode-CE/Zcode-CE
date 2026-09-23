import type { IZCodeSessionService } from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";

export function useZCodeSessionService(
  workspacePath?: string,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
): IZCodeSessionService {
  // 修复（加载期渲染崩溃的根因）：hook 调用**必须无条件**，不能用三元在两组 hook 之间切换。
  //
  // 原来写成 `workspacePath ? useWorkspaceServices(...) : useServices()`：三元两侧是**不同的 hook**
  // （一个只有 useServices()=useContext；另一个是 useServices + useTabStore + 两个 zustand store，
  // 共 8+ 个槽位）。同一个组件实例只要在两次渲染之间从「没有 workspacePath」变成「有」，hook 序列
  // 就会错位：后续槽位按 useCallback 取 prevDeps 时拿到的是 `useRef`/`useState` 的 memoizedState，
  // 于是 React 的 areHookInputsEqual 读 `undefined.length` 抛 TypeError。
  //
  // 实测（390×844 真实 web 客户端，dev 构建）：`OnboardingDialog` 加载即崩溃并被
  // ScopedErrorBoundary 整棵子树重建，组件栈 `at OnboardingDialog`，React 的 hook 表在第 8 项
  // 分叉（useRef → useContext，即 useSettingsSync 的 `runningImportRef` 换成了
  // useResolvedRemoteWorkspaceSessionId 里的 useTabStore）。触发条件是 OnboardingDialog 先以
  // 「workspacePath 未解析」渲染一次，随后 active workspace 恢复完成再渲染一次。
  //
  // 修法：两侧都调用，再按原来的口径选择 —— 返回的服务与修复前逐字一致，只是 hook 序列恒定。
  const workspaceServices = useWorkspaceServices(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
  );
  const contextServices = useServices();
  return (workspacePath ? workspaceServices : contextServices).zcodeSessionService;
}
