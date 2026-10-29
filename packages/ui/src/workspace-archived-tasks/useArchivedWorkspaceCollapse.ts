import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "zcode:archived-collapsed-workspaces:v1";

/** 折叠状态是本机 UI 偏好：重挂载后保留，但不写服务端设置（分组是展示层事实，不是配置）。 */
function readCollapsedWorkspaceKeys(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return new Set(
      Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === "string") : [],
    );
  } catch {
    return new Set();
  }
}

export function useArchivedWorkspaceCollapse() {
  const [collapsedWorkspaceKeys, setCollapsedWorkspaceKeys] = useState<Set<string>>(
    readCollapsedWorkspaceKeys,
  );

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...collapsedWorkspaceKeys]));
    } catch {
      // 存储不可用（隐私模式/配额）只影响记忆折叠状态，不影响列表本身。
    }
  }, [collapsedWorkspaceKeys]);

  const toggleWorkspaceCollapsed = useCallback((workspaceKey: string) => {
    setCollapsedWorkspaceKeys((current) => {
      const next = new Set(current);
      if (next.has(workspaceKey)) next.delete(workspaceKey);
      else next.add(workspaceKey);
      return next;
    });
  }, []);

  return { collapsedWorkspaceKeys, toggleWorkspaceCollapsed };
}
