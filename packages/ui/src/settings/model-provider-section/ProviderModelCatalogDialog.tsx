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
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 「从 Provider 拉取模型」对话框。
 *
 * 拉取是纯读操作：失败时只展示错误并允许重试，不修改任何配置。
 * 勾选后由父层逐个调用既有的 addPersonalModel 写入边界，本对话框不直接写盘。
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
      setError(null);
      setLoading(false);
      setAdding(false);
      return;
    }
    void load();
  }, [open, load]);

  const addable = useMemo(
    () => (entries ?? []).filter((entry) => !existing.has(entry.id)),
    [entries, existing],
  );
  const selectedAddable = useMemo(
    () => addable.filter((entry) => selected.has(entry.id)).map((entry) => entry.id),
    [addable, selected],
  );

  const toggle = (modelId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((current) =>
      current.size === addable.length ? new Set() : new Set(addable.map((entry) => entry.id)),
    );
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

  const allSelected = addable.length > 0 && selected.size === addable.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] w-[min(560px,92vw)] overflow-hidden">
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({ id: "settings.modelProvider.modelCatalog.title" })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "settings.modelProvider.modelCatalog.description" })}
          </DialogDescription>
        </DialogHeader>

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
          ) : (
            <div className="space-y-1">
              <button
                type="button"
                className="mb-2 text-ui-sm text-foreground-subtle underline-offset-2 hover:underline"
                onClick={toggleAll}
              >
                {intl.formatMessage({
                  id: allSelected
                    ? "settings.modelProvider.modelCatalog.clearAll"
                    : "settings.modelProvider.modelCatalog.selectAll",
                })}
              </button>
              <ul className="space-y-1">
                {entries.map((entry) => {
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

        <DialogFooter>
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
