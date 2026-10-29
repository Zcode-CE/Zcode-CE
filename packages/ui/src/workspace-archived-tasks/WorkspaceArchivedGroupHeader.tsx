import { ChevronDown, ChevronRight } from "lucide-react";

/**
 * 归档列表的工作区分组头（W4 批次 1）。
 *
 * 归档列表是跨工作区视图：任务多起来后，平铺列表里每行重复工作区名且无法整体收起。
 * 组头只负责展示与折叠，不承担选择/删除语义；计数是该组在当前已加载列表里的条数。
 */
export function WorkspaceArchivedGroupHeader({
  label,
  count,
  collapsed,
  onToggle,
}: {
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={!collapsed}
      className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-ui-sm text-foreground-subtle transition-colors hover:bg-surface-hover"
      onClick={onToggle}
    >
      {collapsed ? (
        <ChevronRight className="size-3.5 shrink-0" />
      ) : (
        <ChevronDown className="size-3.5 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate" title={label}>
        {label}
      </span>
      <span className="shrink-0 text-foreground-subtlest">{count}</span>
    </button>
  );
}
