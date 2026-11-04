import { useCallback, useMemo, useState } from "react";
import { Clock, Folder, Loader2, Pencil } from "lucide-react";
import {
  buildWorkspaceDisplayNamePatch,
  normalizeWorkspaceDisplayName,
  resolveWorkspaceProjectView,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { toast } from "@/components/ui/toast.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useWorkspaceRegistry } from "@/hooks/useWorkspaceRegistry.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  persistWorkspaceManagementSortBy,
  readWorkspaceManagementSortBy,
  sortWorkspaceRegistryEntries,
  type WorkspaceManagementSortBy,
} from "@/lib/workspaceManagementPreferences.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";

/**
 * 设置页「工作区」分区（F7 前半）。
 *
 * 数据所有权：列表只来自服务端工作区注册表（只读索引，客户端不得改动枚举口径），
 * 展示名来自 AppSettings.workspaceDisplayNames（本机展示覆盖，不改身份/路径）。
 *
 * 本轮刻意不做删除：删工作区要么只从注册表移除、要么连同会话数据清理，
 * 后者需要先出清理边界 spec（哪些数据、能否撤销、远端如何处理）。在没有该契约前
 * 提供一个「删除」按钮只会让用户以为数据被清干净了。
 */
export function WorkspaceManagementSection() {
  const { intl } = useZCodeIntl();
  const registry = useWorkspaceRegistry();
  const { settings, update } = useSettings();
  const [sortBy, setSortBy] = useState<WorkspaceManagementSortBy>(() =>
    readWorkspaceManagementSortBy(),
  );
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const displayNames = settings?.workspaceDisplayNames;
  const rows = useMemo(() => {
    const projected = registry.entries.map((entry) => {
      const view = resolveWorkspaceProjectView({
        workspaceKey: entry.workspaceKey,
        workspacePath: entry.workspacePath,
        additionalRoots: [],
        displayNames,
      });
      return { entry, displayName: view.displayName };
    });
    return sortWorkspaceRegistryEntries(projected, sortBy, (row) => ({
      key: row.entry.workspaceKey,
      label: row.displayName,
      lastActivityAt: row.entry.lastActivityAt,
      sessionCount: row.entry.activeSessionCount ?? row.entry.sessionCount,
    }));
  }, [displayNames, registry.entries, sortBy]);

  const handleSortChange = useCallback((value: string) => {
    if (value !== "lastActivity" && value !== "name" && value !== "sessions") return;
    setSortBy(value);
    persistWorkspaceManagementSortBy(value);
  }, []);

  const startEdit = useCallback((workspaceKey: string, current: string) => {
    setEditingKey(workspaceKey);
    setDraftName(current);
  }, []);

  const commitEdit = useCallback(async () => {
    if (!editingKey) return;
    const workspaceKey = editingKey;
    const nextName = normalizeWorkspaceDisplayName(draftName) ?? "";
    setSavingKey(workspaceKey);
    try {
      // 只提交被改的键：服务端按键合并，两个客户端同时改不同工作区不会互相覆盖。
      await update({
        workspaceDisplayNames: buildWorkspaceDisplayNamePatch(workspaceKey, nextName),
      });
      setEditingKey(null);
      toast(intl.formatMessage({ id: "settings.workspaceManagement.nameSaved" }));
    } catch (error) {
      logger.warn("[WorkspaceManagementSection] 保存展示名失败", {
        workspaceKey,
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "settings.workspaceManagement.nameSaveFailed" }));
    } finally {
      setSavingKey(null);
    }
  }, [draftName, editingKey, intl, update]);

  return (
    <SettingsGroupCard>
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <p className="min-w-0 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.workspaceManagement.description" })}
        </p>
        <Select value={sortBy} onValueChange={handleSortChange}>
          <SelectTrigger className="h-8 w-36 shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="lastActivity">
              {intl.formatMessage({ id: "settings.workspaceManagement.sort.lastActivity" })}
            </SelectItem>
            <SelectItem value="name">
              {intl.formatMessage({ id: "settings.workspaceManagement.sort.name" })}
            </SelectItem>
            <SelectItem value="sessions">
              {intl.formatMessage({ id: "settings.workspaceManagement.sort.sessions" })}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      {registry.status === "loading" ? (
        <div className="flex items-center gap-2 px-4 py-6 text-ui-base text-foreground-subtle">
          <Loader2 className="size-4 animate-spin" />
          {intl.formatMessage({ id: "settings.workspaceManagement.loading" })}
        </div>
      ) : registry.status === "unavailable" ? (
        <div className="px-4 py-6 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.workspaceManagement.loadFailed" })}
        </div>
      ) : rows.length === 0 ? (
        <div className="px-4 py-6 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.workspaceManagement.empty" })}
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map(({ entry, displayName }) => {
            const editing = editingKey === entry.workspaceKey;
            const saving = savingKey === entry.workspaceKey;
            return (
              <li
                key={entry.workspaceKey}
                className="flex items-center gap-3 px-4 py-3"
                data-workspace-key={entry.workspaceKey}
              >
                <Folder className="size-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  {editing ? (
                    <Input
                      autoFocus
                      value={draftName}
                      disabled={saving}
                      aria-label={intl.formatMessage({
                        id: "settings.workspaceManagement.nameLabel",
                      })}
                      className="h-8 w-full max-w-64"
                      onChange={(event) => setDraftName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                          event.preventDefault();
                          void commitEdit();
                        }
                        if (event.key === "Escape") {
                          event.preventDefault();
                          setEditingKey(null);
                        }
                      }}
                    />
                  ) : (
                    <div className="truncate text-ui-base font-medium text-foreground">
                      {displayName}
                    </div>
                  )}
                  <div className="truncate text-ui-sm text-foreground-subtle">
                    {entry.workspacePath}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2 text-ui-sm text-foreground-subtle">
                  <span className="inline-flex items-center gap-1">
                    <Clock className="size-3.5" aria-hidden="true" />
                    {new Date(entry.lastActivityAt).toLocaleDateString()}
                  </span>
                  <span>
                    {intl.formatMessage(
                      { id: "settings.workspaceManagement.sessionCount" },
                      { count: String(entry.activeSessionCount ?? entry.sessionCount) },
                    )}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={intl.formatMessage({
                      id: "settings.workspaceManagement.editName",
                    })}
                    disabled={editing || saving || settings === null}
                    onClick={() => startEdit(entry.workspaceKey, displayName)}
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </SettingsGroupCard>
  );
}
