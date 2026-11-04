import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileApplicationInfo, FileApplicationTarget } from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";

/**
 * 系统关联应用（「打开方式」）枚举。
 *
 * 能力检测是这里唯一的判断依据：只有平台真的实现了 `getFileApplications` /
 * `openFileWithApplication` 才认为支持（Web 与旧 host 都没有），调用方据 `supported`
 * 决定是否渲染这个分组 —— 没有能力就不出现，而不是出现一个点了没反应的死入口。
 *
 * 枚举失败（平台不支持、系统调用失败）按「没有可用应用」处理：main 侧已经统一返回空数组，
 * 这里兜住异常后同样落到降级文案。
 */
export interface FileApplicationsState {
  /** 平台是否提供「打开方式」能力；false 时调用方不得渲染任何入口。 */
  supported: boolean;
  loading: boolean;
  apps: readonly FileApplicationInfo[];
  defaultApplication: FileApplicationInfo | undefined;
}

export function useFileApplications(target: FileApplicationTarget | null) {
  const platform = usePlatform();
  const supported = Boolean(
    platform.getFileApplications && platform.openFileWithApplication && target,
  );
  const [apps, setApps] = useState<readonly FileApplicationInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // 卡片列表会复用组件实例：旧目标的异步结果不得覆盖新目标。
  const requestRef = useRef(0);
  const targetKey = target ? `${target.path}\u0000${target.pathKind}` : null;

  useEffect(() => {
    requestRef.current += 1;
    setApps([]);
    setLoaded(false);
    setLoading(false);
  }, [targetKey]);

  const load = useCallback(async () => {
    if (!supported || !target || loaded || loading) return;
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const result = await platform.getFileApplications!(target);
      if (request !== requestRef.current) return;
      setApps(result);
      setLoaded(true);
    } catch (error) {
      if (request !== requestRef.current) return;
      logger.warn("[useFileApplications] 枚举系统关联应用失败，按无可用应用处理", {
        path: target.path,
        error: error instanceof Error ? error.message : String(error),
      });
      setApps([]);
      setLoaded(true);
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [loaded, loading, platform, supported, target]);

  const open = useCallback(
    async (applicationId: string) => {
      if (!supported || !target) return { success: false, error: "unsupported" };
      try {
        return await platform.openFileWithApplication!(applicationId, target);
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    [platform, supported, target],
  );

  const state = useMemo<FileApplicationsState>(
    () => ({
      supported,
      loading,
      apps,
      defaultApplication: apps.find((app) => app.isDefault),
    }),
    [apps, loading, supported],
  );
  return { ...state, load, open };
}
