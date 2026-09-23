import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { IWorkspaceRegistryService } from "@zcode/services";
import type { WorkspaceRegistryEntry, WorkspaceRegistryListResult } from "@zcode/shared";
import { logger } from "@/logger.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";

/**
 * 工作区注册表消费面（M1.4）——侧栏枚举的唯一来源。
 *
 * 为什么是模块级缓存 + useSyncExternalStore，而不是组件内 useState：
 * ① 侧栏会因为祖先重挂载 / HMR / 断线重连重挂载，组件内状态会让列表在重连瞬间闪成空 ——
 *    而验收判据明确要求「断线重连后列表仍在」（docs/development/workspace-registry.md §7.3）；
 * ② 列表来源必须对所有客户端逐条一致（判据 ④），因此这里只透传服务端的 `entries` /
 *    `defaultView`，**客户端不得自行改动默认视图口径**。
 *
 * 与设置的关系（Lead 拍定）：设置只提供「显示偏好」（本客户端显式列出的 tab 由调用方传入），
 * **绝不把枚举写回设置** —— 否则等于自己造出第二份真相源，正是 M1 要消灭的东西。
 */

export type WorkspaceRegistryStatus = "idle" | "loading" | "ready" | "unavailable";

export interface WorkspaceRegistryView {
  status: WorkspaceRegistryStatus;
  /** 注册表全集（「显示全部」用）。 */
  entries: readonly WorkspaceRegistryEntry[];
  /** 默认视图 = 最近活跃窗口 ∪ 置顶（服务端计算）。 */
  defaultView: readonly WorkspaceRegistryEntry[];
  /** 服务端本次使用的活跃窗口天数；未就绪时为 0。 */
  windowDays: number;
  generatedAt: number;
  /** 失败原因（仅 "unavailable" 时非空），供「列出失败」的诚实提示使用。 */
  errorMessage: string | null;
  /** 重新拉取（重连、失败重试、刚打开新工作区时调用）。 */
  reload: () => void;
}

const IDLE_VIEW: Omit<WorkspaceRegistryView, "reload"> = {
  status: "idle",
  entries: [],
  defaultView: [],
  windowDays: 0,
  generatedAt: 0,
  errorMessage: null,
};

let snapshot: Omit<WorkspaceRegistryView, "reload"> = IDLE_VIEW;
const listeners = new Set<() => void>();

function publish(next: Omit<WorkspaceRegistryView, "reload">): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): Omit<WorkspaceRegistryView, "reload"> {
  return snapshot;
}

/** 单飞：同一时刻只允许一条注册表 RPC 在途，避免重连抖动打出多份请求。 */
let inFlight: { signature: string; promise: Promise<void> } | null = null;

/** 测试与登出清理用：把模块级缓存恢复到初始态。 */
export function resetWorkspaceRegistryCache(): void {
  inFlight = null;
  publish(IDLE_VIEW);
}

function pinnedSignature(pinnedKeys: readonly string[]): string {
  return [...pinnedKeys].sort().join("\u0000");
}

/**
 * 拉取注册表（单飞 + 幂等）。`service` 缺席（旧 host / 测试 double）时落
 * "unavailable"，调用方必须回落到「本客户端显式列出」而不是把空列表当事实。
 */
export function loadWorkspaceRegistry(params: {
  service: IWorkspaceRegistryService | undefined;
  pinnedKeys: readonly string[];
}): Promise<void> {
  const signature = pinnedSignature(params.pinnedKeys);
  if (inFlight?.signature === signature) {
    return inFlight.promise;
  }
  const { service } = params;
  if (!service) {
    publish({
      ...IDLE_VIEW,
      status: "unavailable",
      errorMessage: "workspace-registry service unavailable",
    });
    return Promise.resolve();
  }
  publish(
    snapshot.status === "ready"
      ? { ...snapshot, status: "loading" }
      : { ...IDLE_VIEW, status: "loading" },
  );
  const promise = service
    .listWorkspaceRegistry(
      params.pinnedKeys.length > 0 ? { pinnedKeys: [...params.pinnedKeys] } : undefined,
    )
    .then((result: WorkspaceRegistryListResult) => {
      publish({
        status: "ready",
        entries: result.entries,
        defaultView: result.defaultView,
        windowDays: result.windowDays,
        generatedAt: result.generatedAt,
        errorMessage: null,
      });
    })
    .catch((error: unknown) => {
      // 失败不得把已拿到的列表清空：那是「会话看起来丢了」的同一种观感。
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("[useWorkspaceRegistry] 读取工作区注册表失败", message);
      publish({ ...snapshot, status: "unavailable", errorMessage: message });
    })
    .finally(() => {
      if (inFlight?.promise === promise) inFlight = null;
    });
  inFlight = { signature, promise };
  return promise;
}

export function useWorkspaceRegistry(params?: {
  /** 显示偏好里的置顶项（不参与枚举，只影响默认视图取并集）。 */
  pinnedKeys?: readonly string[];
}): WorkspaceRegistryView {
  const baseServices = useBaseWorkspaceServices();
  const service = baseServices.workspaceRegistryService;
  const pinnedKeys = params?.pinnedKeys ?? EMPTY_PINNED_KEYS;
  const signature = pinnedSignature(pinnedKeys);
  const view = useSyncExternalStore(subscribe, getSnapshot);

  useEffect(() => {
    // service 换代（web 断线重连会换一份 RPC proxy）必须重新拉取，否则重连后列表会停在旧快照。
    void loadWorkspaceRegistry({ service, pinnedKeys });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pinnedKeys 按值签名比较，数组身份每帧都在换。
  }, [service, signature]);

  const reload = useCallback(() => {
    // 强制重拉：清掉在途单飞记录后立即发起。
    inFlight = null;
    void loadWorkspaceRegistry({ service, pinnedKeys });
  }, [service, pinnedKeys]);

  return useMemo(() => ({ ...view, reload }), [reload, view]);
}

const EMPTY_PINNED_KEYS: readonly string[] = [];
