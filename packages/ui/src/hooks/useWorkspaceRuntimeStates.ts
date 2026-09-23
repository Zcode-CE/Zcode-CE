import { useEffect, useMemo, useRef, useState } from "react";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import {
  acquireSessionsIndex,
  releaseSessionsIndex,
  type SessionsIndexScope,
} from "@/v4/sessionsIndexRegistry.js";
import type { SessionsIndexStore } from "@/v4/sessionsIndexStore.js";

/**
 * 每个 workspace 的 runtime 状态（§3.2 诚实未启动态的数据来源）。
 *
 * 为什么用 sessions-index store 的 status 而不是自己探测：被动订阅在 runtime 不存在时不会
 * 报错崩溃，而是收敛成**稳定状态**（`store.getStatus() === "dormant"`，见
 * `packages/ui/src/v4/sessionsIndexStore.ts` 的 handleRuntimeUnavailable）——这正是
 * 「未启动」这个事实的唯一权威来源。反过来，runtime 在跑而会话列表确实为空时它是 `live`，
 * 两者必须区分开：把「未启动」画成「暂无任务」就是本任务要修掉的用户观感（§3.2 禁止项 ③）。
 *
 * 成本纪律（§3.1）：本 hook 只做**被动订阅**，走的仍是会话索引 transport 里硬编码的
 * `runtimePolicy: "existing-only"`，因此列出 N 个 workspace **不会**拉起任何 runtime
 * （实测见 .reverse/40-remote-control/PUBLISHER-SCALE-MEASUREMENT.md §2.1）。
 */

export type WorkspaceRuntimeState =
  /** 远端/无法判定：不显示本地「未启动」标识（远端另有重连 UI，不得混淆）。 */
  | "unknown"
  /** runtime 未启动（dormant）：点开才启动。 */
  | "not-started"
  /** runtime 启动中（connecting）：显示加载态，不得误报为「暂无任务」。 */
  | "starting"
  /** 已 live：正常渲染会话列表。 */
  | "live"
  /** 订阅/恢复失败（error）：显示明确失败态 + 重试入口。 */
  | "failed";

export interface WorkspaceRuntimeStateInput {
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  /** 远端 tab（SSH/WSL/远控）：不参与本地 runtime 状态判定。 */
  isRemote?: boolean;
}

function mapStatus(status: string): WorkspaceRuntimeState {
  if (status === "live") return "live";
  if (status === "dormant") return "not-started";
  if (status === "connecting" || status === "idle") return "starting";
  if (status === "error") return "failed";
  return "unknown";
}

/**
 * 返回按 workspaceKey 索引的 runtime 状态 Map。仅在 scope 集合变化时重新 acquire/release；
 * 状态变化由 store 的订阅驱动（refCount 共享，侧栏各列表复用同一条订阅）。
 */
export function useWorkspaceRuntimeStates(
  inputs: readonly WorkspaceRuntimeStateInput[],
): ReadonlyMap<string, WorkspaceRuntimeState> {
  const baseServices = useBaseWorkspaceServices();
  const agentService = baseServices.zcodeAgentService;
  const [tick, setTick] = useState(0);
  const bumpTick = useRef(() => setTick((value) => value + 1)).current;
  const bindingsRef = useRef<Array<{ scope: SessionsIndexScope; store: SessionsIndexStore }>>([]);
  const localInputs = useMemo(
    () => inputs.filter((input) => !input.isRemote && Boolean(input.workspacePath)),
    [inputs],
  );
  const signature = useMemo(
    () =>
      localInputs
        .map((input) => input.workspaceKey + "\u0000" + input.workspacePath)
        .sort()
        .join("|"),
    [localInputs],
  );
  const inputsRef = useRef(localInputs);
  inputsRef.current = localInputs;

  useEffect(() => {
    const disposables: Array<() => void> = [];
    const bindings: Array<{ scope: SessionsIndexScope; store: SessionsIndexStore }> = [];
    if (agentService) {
      // 同一 workspaceKey 只订阅一次：侧栏可能同时存在同路径的多个 tab。
      const seen = new Set<string>();
      for (const input of inputsRef.current) {
        if (seen.has(input.workspaceKey)) continue;
        seen.add(input.workspaceKey);
        const scope: SessionsIndexScope = {
          workspaceKey: input.workspaceKey,
          workspacePath: input.workspacePath,
          ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
        };
        const store = acquireSessionsIndex(scope, agentService);
        bindings.push({ scope, store });
        disposables.push(store.subscribe(bumpTick));
      }
    }
    bindingsRef.current = bindings;
    bumpTick();
    return () => {
      for (const dispose of disposables) dispose();
      for (const binding of bindings) {
        releaseSessionsIndex(
          {
            workspaceKey: binding.scope.workspaceKey,
            ...(binding.scope.endpointKey ? { endpointKey: binding.scope.endpointKey } : {}),
          },
          binding.store,
        );
      }
      bindingsRef.current = [];
    };
    // signature 覆盖 scope 集合内容；bumpTick 与 agentService 身份稳定。
    // eslint-disable-next-line react-hooks/exhaustive-deps -- localInputs 按值签名比较。
  }, [agentService, signature]);

  return useMemo(() => {
    const states = new Map<string, WorkspaceRuntimeState>();
    for (const input of localInputs) {
      if (states.has(input.workspaceKey)) continue;
      const binding = bindingsRef.current.find(
        (candidate) => candidate.scope.workspaceKey === input.workspaceKey,
      );
      states.set(input.workspaceKey, binding ? mapStatus(binding.store.getStatus()) : "unknown");
    }
    return states;
  }, [localInputs, tick]);
}
