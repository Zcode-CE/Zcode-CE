import { useState } from "react";
import { EyeOff, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 「已隐藏的模型」恢复入口。
 *
 * 删除内置模型只能记为隐藏（内置名单由模板提供，真删会被重新注入）。
 * 没有这个入口，隐藏就不可逆 —— 用户只能手改配置文件才能把模型找回来。
 * 默认折叠：只有真的隐藏过模型的用户才需要看到它。
 */
export function ProviderHiddenModelsSection({
  providerId,
  hiddenModelIds,
  onRestore,
}: {
  providerId: string;
  hiddenModelIds: readonly string[];
  onRestore: (providerId: string, modelId: string) => Promise<unknown>;
}) {
  const { intl } = useZCodeIntl();
  const [expanded, setExpanded] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (hiddenModelIds.length === 0) return null;

  const restore = async (modelId: string) => {
    setRestoring(modelId);
    setError(null);
    try {
      await onRestore(providerId, modelId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRestoring(null);
    }
  };

  return (
    <div className="rounded-lg border border-dashed border-border">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-ui-base text-foreground-subtle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <EyeOff className="size-3.5 shrink-0" aria-hidden="true" />
        {intl.formatMessage(
          { id: "settings.modelProvider.hiddenModels.title" },
          { count: hiddenModelIds.length },
        )}
      </button>
      {expanded ? (
        <div className="space-y-1 px-3 pb-3">
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "settings.modelProvider.hiddenModels.description" })}
          </p>
          {error ? (
            <p className="text-ui-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <ul className="space-y-1">
            {hiddenModelIds.map((modelId) => (
              <li
                key={modelId}
                className="flex items-center gap-2 rounded-md border border-input-border bg-input px-2 py-1"
              >
                <span className="min-w-0 flex-1 truncate text-ui-base">{modelId}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="shrink-0 rounded-md"
                  disabled={restoring === modelId}
                  onClick={() => void restore(modelId)}
                >
                  <RotateCcw data-icon="inline-start" aria-hidden="true" />
                  {intl.formatMessage({ id: "settings.modelProvider.hiddenModels.restore" })}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
