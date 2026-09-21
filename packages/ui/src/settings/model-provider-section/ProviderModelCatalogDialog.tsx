import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Loader2, RefreshCw } from "lucide-react";
import type { ModelCatalogEntry } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 「从 Provider 拉取模型」对话框。
 *
 * 拉取是纯读操作：失败时只展示错误并允许重试，不修改任何配置。
 * 勾选后由父层逐个调用既有的 addPersonalModel 写入边界，本对话框不直接写盘。
 *
 * 布局约束：DialogContent 原语是 grid 容器，内部的 min-h-0 flex-1 不会生效，
 * 模型一多列表就会撑破 max-h 并被 overflow-hidden 裁掉，底部按钮被顶出可视区。
 * 因此这里显式改成 flex 列（cn 走 tailwind-merge，后写的 flex 会替换掉原语的 grid），
 * 由「固定头 + 固定搜索 + 可滚动列表 + 固定脚」四段构成：
 * header / 搜索框 / 列表 / footer 各自 shrink-0，只有列表 min-h-0 flex-1 并自行滚动。
 */
export function ProviderModelCatalogDialog({
  open,
  onOpenChange,
  providerId,
  existingModelIds,
  onFetch,
  onAddModels,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providerId: string;
  /** 当前已在列表里的模型 ID（含内置），用于标注「已存在」并默认不勾选。 */
  existingModelIds: readonly string[];
  onFetch: (providerId: string) => Promise<{ entries: readonly ModelCatalogEntry[] }>;
  onAddModels: (modelIds: readonly string[]) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const [entries, setEntries] = useState<readonly ModelCatalogEntry[] | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const requestTokenRef = useRef(0);

  const existing = useMemo(() => new Set(existingModelIds), [existingModelIds]);

  const load = useCallback(async () => {
    const token = requestTokenRef.current + 1;
    requestTokenRef.current = token;
    setLoading(true);
    setError(null);
    try {
      const result = await onFetch(providerId);
      if (requestTokenRef.current !== token) return;
      setEntries(result.entries);
      // 已存在的模型默认不勾选，避免用户"添加"一批必然失败或重复的条目。
      setSelected(new Set());
    } catch (cause) {
      if (requestTokenRef.current !== token) return;
      setEntries(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (requestTokenRef.current === token) setLoading(false);
    }
  }, [onFetch, providerId]);

  useEffect(() => {
    if (!open) {
      // 关闭时清空，避免下次打开短暂显示上一次 Provider 的结果。
      requestTokenRef.current += 1;
      setEntries(null);
      setSelected(new Set());
      setQuery("");
      setError(null);
      setLoading(false);
      setAdding(false);
      return;
    }
    void load();
  }, [open, load]);

  const normalizedQuery = query.trim().toLowerCase();
  // 搜索只影响"看得见什么"，不影响"选中了什么"：勾选跨筛选保留，
  // 用户可以先筛一批勾一批，最后一次性提交。
  const visibleEntries = useMemo(() => {
    const list = entries ?? [];
    if (!normalizedQuery) return list;
    return list.filter(
      (entry) =>
        entry.id.toLowerCase().includes(normalizedQuery) ||
        (entry.displayName ?? "").toLowerCase().includes(normalizedQuery),
    );
  }, [entries, normalizedQuery]);

  // 提交口径用全量可添加集合（与筛选无关）。
  const addable = useMemo(
    () => (entries ?? []).filter((entry) => !existing.has(entry.id)),
    [entries, existing],
  );
  const selectedAddable = useMemo(
    () => addable.filter((entry) => selected.has(entry.id)).map((entry) => entry.id),
    [addable, selected],
  );
  // 全选只作用于"当前筛选下可见的可添加项"，避免一键选中被筛掉的模型。
  const visibleAddable = useMemo(
    () => visibleEntries.filter((entry) => !existing.has(entry.id)),
    [visibleEntries, existing],
  );
  const allVisibleSelected =
    visibleAddable.length > 0 && visibleAddable.every((entry) => selected.has(entry.id));

  const toggle = (modelId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((current) => {
      const next = new Set(current);
      for (const entry of visibleAddable) {
        if (allVisibleSelected) next.delete(entry.id);
        else next.add(entry.id);
      }
      return next;
    });
  };

  const commit = async () => {
    if (selectedAddable.length === 0 || adding) return;
    setAdding(true);
    try {
      await onAddModels(selectedAddable);
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAdding(false);
    }
  };

  const hasEntries = entries !== null && entries.length > 0;
  const showSearch = hasEntries && !error;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] w-[min(560px,92vw)] flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>
            {intl.formatMessage({ id: "settings.modelProvider.modelCatalog.title" })}
          </DialogTitle>
          <DialogDescription className="pr-8">
            {intl.formatMessage({ id: "settings.modelProvider.modelCatalog.description" })}
          </DialogDescription>
        </DialogHeader>

        {showSearch ? (
          <SettingsSearchInput
            containerClassName="shrink-0"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onClear={() => setQuery("")}
            disabled={loading || adding}
            placeholder={intl.formatMessage({
              id: "settings.modelProvider.modelCatalog.searchPlaceholder",
            })}
            aria-label={intl.formatMessage({
              id: "settings.modelProvider.modelCatalog.searchPlaceholder",
            })}
            clearLabel={intl.formatMessage({
              id: "settings.modelProvider.modelCatalog.clearSearch",
            })}
          />
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center gap-2 py-6 text-ui-base text-foreground-subtle">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.modelProvider.modelCatalog.loading" })}
            </div>
          ) : error ? (
            <div className="space-y-3 py-4">
              <p className="text-ui-base text-destructive" role="alert">
                {error}
              </p>
              <Button
                type="button"
                variant="secondary"
                size="default"
                className="rounded-lg"
                onClick={() => void load()}
              >
                <RefreshCw data-icon="inline-start" aria-hidden="true" />
                {intl.formatMessage({ id: "settings.modelProvider.modelCatalog.retry" })}
              </Button>
            </div>
          ) : entries === null || entries.length === 0 ? (
            <p className="py-6 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.modelProvider.modelCatalog.empty" })}
            </p>
          ) : addable.length === 0 ? (
            <p className="py-6 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.modelProvider.modelCatalog.allExisting" })}
            </p>
          ) : visibleEntries.length === 0 ? (
            <p className="py-6 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.modelProvider.modelCatalog.noMatch" })}
            </p>
          ) : (
            <div className="space-y-1">
              <button
                type="button"
                className="mb-2 text-ui-sm text-foreground-subtle underline-offset-2 hover:underline"
                onClick={toggleAll}
              >
                {intl.formatMessage({
                  id: allVisibleSelected
                    ? "settings.modelProvider.modelCatalog.clearAll"
                    : "settings.modelProvider.modelCatalog.selectAll",
                })}
              </button>
              <ul className="space-y-1">
                {visibleEntries.map((entry) => {
                  const isExisting = existing.has(entry.id);
                  return (
                    <li
                      key={entry.id}
                      className="flex items-center gap-3 rounded-lg border border-input-border bg-input px-3 py-2"
                    >
                      <Checkbox
                        checked={selected.has(entry.id)}
                        disabled={isExisting}
                        onCheckedChange={() => toggle(entry.id)}
                        aria-label={entry.id}
                      />
                      <span className="min-w-0 flex-1 truncate text-ui-base">
                        {entry.displayName ?? entry.id}
                      </span>
                      {entry.displayName ? (
                        <span className="min-w-0 max-w-[45%] truncate text-ui-sm text-foreground-subtle">
                          {entry.id}
                        </span>
                      ) : null}
                      {isExisting ? (
                        <span className="shrink-0 text-ui-sm text-foreground-subtle">
                          {intl.formatMessage({
                            id: "settings.modelProvider.modelCatalog.alreadyExists",
                          })}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>

        <DialogFooter className="shrink-0">
          <Button
            type="button"
            variant="ghost"
            size="default"
            className="rounded-lg"
            onClick={() => onOpenChange(false)}
          >
            {intl.formatMessage({ id: "settings.modelProvider.cancel" })}
          </Button>
          <Button
            type="button"
            variant="default"
            size="default"
            className="rounded-lg"
            disabled={selectedAddable.length === 0 || adding}
            onClick={() => void commit()}
          >
            {adding ? (
              <Loader2 data-icon="inline-start" className="animate-spin" aria-hidden="true" />
            ) : (
              <Download data-icon="inline-start" aria-hidden="true" />
            )}
            {intl.formatMessage(
              { id: "settings.modelProvider.modelCatalog.addSelected" },
              { count: selectedAddable.length },
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
