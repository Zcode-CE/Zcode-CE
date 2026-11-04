/* eslint-disable max-lines -- 列表 / 排序 / 展示名 / 移除与清理确认集中在同一分区：拆开会让
   "这次删什么、删了会怎样" 的判定散到多个文件，而这正是本页最不能含糊的部分。 */
import { useCallback, useMemo, useState } from "react";
import { Clock, Folder, Loader2, Pencil, Trash2, Undo2 } from "lucide-react";
import { testId } from "@zcode/shared";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { toast } from "@/components/ui/toast.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
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
 * 两种移除方式（spec：.local/reports/planning/workspace-purge/SPEC.md §5）：
 * - 「从列表移除」：只删注册表行，数据保留，重新打开该目录即回来；
 * - 「删除并清理数据」：走后端 purge（不可撤销）。确认框先 measure 出每项计数，
 *   再要求输入展示名确认；运行中 / 远端工作区不提供该入口。
 *
 * 清理清单与不删项由服务返回（含原因 id），UI 只负责展示——两边不各写一份清单。
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
  const { workspaceMaintenanceService } = useBaseWorkspaceServices();
  const [pending, setPending] = useState<{
    kind: "remove" | "purge";
    workspaceKey: string;
    workspacePath: string;
    workspaceIdentity?: string;
    displayName: string;
    measure: Awaited<
      ReturnType<NonNullable<typeof workspaceMaintenanceService>["measureWorkspace"]>
    > | null;
  } | null>(null);
  const [confirmName, setConfirmName] = useState("");
  const [busy, setBusy] = useState(false);

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

  const startRemove = useCallback((row: (typeof rows)[number]) => {
    setConfirmName("");
    setPending({
      kind: "remove",
      workspaceKey: row.entry.workspaceKey,
      workspacePath: row.entry.workspacePath,
      ...(row.entry.workspaceIdentity ? { workspaceIdentity: row.entry.workspaceIdentity } : {}),
      displayName: row.displayName,
      measure: null,
    });
  }, []);

  const startPurge = useCallback(
    (row: (typeof rows)[number]) => {
      if (!workspaceMaintenanceService) return;
      setConfirmName("");
      setPending({
        kind: "purge",
        workspaceKey: row.entry.workspaceKey,
        workspacePath: row.entry.workspacePath,
        ...(row.entry.workspaceIdentity ? { workspaceIdentity: row.entry.workspaceIdentity } : {}),
        displayName: row.displayName,
        measure: null,
      });
      // 计数由后端 measure 给出：确认框不自己估、也不把「可重建」项藏起来。
      void workspaceMaintenanceService
        .measureWorkspace({
          workspacePath: row.entry.workspacePath,
          ...(row.entry.workspaceIdentity
            ? { workspaceIdentity: row.entry.workspaceIdentity }
            : {}),
        })
        .then((measure) => setPending((current) => (current ? { ...current, measure } : current)))
        .catch((error: unknown) => {
          logger.warn("[WorkspaceManagementSection] 统计工作区数据失败", {
            workspaceKey: row.entry.workspaceKey,
            error: error instanceof Error ? error.message : String(error),
          });
          toast(intl.formatMessage({ id: "settings.workspaceManagement.measureFailed" }));
        });
    },
    [intl, workspaceMaintenanceService],
  );

  const submitPending = useCallback(async () => {
    if (!pending || !workspaceMaintenanceService || busy) return;
    const target = {
      workspacePath: pending.workspacePath,
      ...(pending.workspaceIdentity ? { workspaceIdentity: pending.workspaceIdentity } : {}),
    };
    setBusy(true);
    try {
      if (pending.kind === "remove") {
        await workspaceMaintenanceService.removeWorkspaceFromList(target);
        toast(intl.formatMessage({ id: "settings.workspaceManagement.removed" }));
      } else {
        const result = await workspaceMaintenanceService.purgeWorkspace(target);
        // 失败会抛（运行中 / 互斥）；部分完成如实说"可重试"，不假装删净。
        toast(
          intl.formatMessage({
            id: result.completed
              ? "settings.workspaceManagement.purged"
              : "settings.workspaceManagement.purgeIncomplete",
          }),
        );
        logger.info("[WorkspaceManagementSection] 工作区清理完成", {
          workspaceKey: result.workspaceKey,
          deleted: result.deleted,
          remaining: result.remaining,
          completed: result.completed,
        });
      }
      registry.reload();
      setPending(null);
      setConfirmName("");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn("[WorkspaceManagementSection] 工作区清理失败", {
        workspaceKey: pending.workspaceKey,
        kind: pending.kind,
        reason,
      });
      toast(
        intl.formatMessage({
          id:
            reason === "workspace_running"
              ? "settings.workspaceManagement.blockedRunning"
              : reason === "workspace_purge_in_progress"
                ? "settings.workspaceManagement.blockedConcurrent"
                : "settings.workspaceManagement.actionFailed",
        }),
      );
    } finally {
      setBusy(false);
    }
  }, [busy, intl, pending, registry, workspaceMaintenanceService]);

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
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={intl.formatMessage({
                      id: "settings.workspaceManagement.removeFromList",
                    })}
                    data-testid={testId("workspace-management-remove", entry.workspaceKey)}
                    disabled={busy}
                    onClick={() =>
                      startRemove({
                        entry,
                        displayName,
                      })
                    }
                  >
                    <Undo2 className="size-3.5" />
                  </Button>
                  {/* 带 identity 的是远端工作区：本机不删它的数据（远端 Host 自己负责）。 */}
                  {workspaceMaintenanceService && !entry.workspaceIdentity ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-destructive hover:text-destructive"
                      aria-label={intl.formatMessage({
                        id: "settings.workspaceManagement.deleteWithData",
                      })}
                      data-testid={testId("workspace-management-delete", entry.workspaceKey)}
                      disabled={busy}
                      onClick={() => startPurge({ entry, displayName })}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <Dialog
        open={pending !== null}
        onOpenChange={(open) => (open ? undefined : setPending(null))}
      >
        <DialogContent className="sm:max-w-lg" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {intl.formatMessage({
                id:
                  pending?.kind === "purge"
                    ? "settings.workspaceManagement.purgeTitle"
                    : "settings.workspaceManagement.removeTitle",
              })}
            </DialogTitle>
            <DialogDescription className="whitespace-pre-line">
              {pending?.kind === "purge"
                ? intl.formatMessage(
                    { id: "settings.workspaceManagement.purgeDescription" },
                    { name: pending?.displayName ?? "" },
                  )
                : intl.formatMessage(
                    { id: "settings.workspaceManagement.removeDescription" },
                    { name: pending?.displayName ?? "" },
                  )}
            </DialogDescription>
          </DialogHeader>
          {pending?.kind === "purge" ? (
            <div className="space-y-3 text-ui-sm">
              {pending.measure === null ? (
                <p className="flex items-center gap-2 text-foreground-subtle">
                  <Loader2 className="size-4 animate-spin" />
                  {intl.formatMessage({ id: "settings.workspaceManagement.measuring" })}
                </p>
              ) : (
                <>
                  <ul className="space-y-1" data-testid="workspace-management-purge-counts">
                    {pending.measure.categories.map((category) => (
                      <li key={category.id} className="flex items-center justify-between gap-3">
                        <span className="text-foreground-subtle">
                          {intl.formatMessage({
                            id: `settings.workspaceManagement.category.${category.id}`,
                          })}
                        </span>
                        <span className="font-mono">{category.count}</span>
                      </li>
                    ))}
                  </ul>
                  {pending.measure.skipped.length > 0 ? (
                    <div
                      className="rounded-lg bg-surface p-2 text-foreground-subtle"
                      data-testid="workspace-management-purge-skipped"
                    >
                      {pending.measure.skipped.map((item) => (
                        <p key={item.id}>
                          {intl.formatMessage({
                            id: `settings.workspaceManagement.skipped.${item.id}`,
                          })}
                        </p>
                      ))}
                    </div>
                  ) : null}
                  {pending.measure.running ? (
                    <p className="text-warning">
                      {intl.formatMessage({
                        id: "settings.workspaceManagement.blockedRunning",
                      })}
                    </p>
                  ) : null}
                </>
              )}
              <label className="flex flex-col gap-1 text-foreground-subtle">
                {intl.formatMessage(
                  { id: "settings.workspaceManagement.confirmNameLabel" },
                  { name: pending.displayName },
                )}
                <Input
                  autoFocus
                  value={confirmName}
                  disabled={busy}
                  onChange={(event) => setConfirmName(event.target.value)}
                  data-testid="workspace-management-confirm-name"
                />
              </label>
            </div>
          ) : null}
          <DialogFooter className="gap-2 sm:justify-end">
            <Button variant="secondary" size="lg" onClick={() => setPending(null)}>
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
            <Button
              variant={pending?.kind === "purge" ? "destructive" : "default"}
              size="lg"
              data-testid="workspace-management-confirm"
              disabled={
                busy ||
                (pending?.kind === "purge" &&
                  (pending.measure === null ||
                    pending.measure.running ||
                    confirmName.trim() !== pending.displayName))
              }
              onClick={() => void submitPending()}
            >
              {intl.formatMessage({
                id:
                  pending?.kind === "purge"
                    ? "settings.workspaceManagement.purgeConfirm"
                    : "settings.workspaceManagement.removeConfirm",
              })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsGroupCard>
  );
}
