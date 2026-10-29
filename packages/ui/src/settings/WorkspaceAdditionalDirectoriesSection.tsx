import { FolderPlus, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import {
  MAX_WORKSPACE_ADDITIONAL_DIRECTORIES,
  resolveWorkspaceAdditionalDirectories,
  resolveWorkspaceRegistryKey,
  buildWorkspaceAdditionalDirectoriesPatch,
  type WorkspaceRegistryEntry,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useWorkspaceRegistry } from "@/hooks/useWorkspaceRegistry.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

/**
 * 「工作区附加目录」设置分区（上游 X16）。
 *
 * 数据所有权：值是 AppSettings 的 `workspaceAdditionalDirectories`（键 = workspaceKey，
 * 见 `@zcode/shared/workspaceAdditionalDirectories`），不写工作区注册表 —— 注册表是只读索引，
 * 把可变配置塞进去会让枚举语义与配置语义互相污染（docs/development/project-model.md §3A、
 * docs/development/workspace-registry.md §2.1）。
 *
 * 消费点只有一处：新建会话时随 v4 `createSession` 的 `additionalDirectories` 下发给 CLI
 * （`packages/ui/src/v4/SessionPane.tsx` 与草稿预热 `useDraftSessionPrewarm`）。因此只对之后
 * 新建的会话生效，已运行的会话不重新读取 —— 页面文案必须如实说明，不能让用户以为点完即变。
 *
 * 三个刻意的决定：
 * 1. 增删即保存（没有单独「保存」按钮）：设置项本身就是列表操作，多一个保存态就多一个
 *    「列表显示 A、磁盘是 B」的分叉。
 * 2. 保存写单键补丁：服务端按 key 合并（`mergeWorkspaceAdditionalDirectories`），
 *    两个客户端同时编辑不同工作区不会互相覆盖；空列表是显式的「删除这个键」信号，
 *    归一后整表为空时落成「字段缺席」。
 * 3. 远程工作区不允许添加：目录选择器（`platform.selectDirectory`）只认本机路径，给远端工作区
 *    选出来的本机路径在远端毫无意义。远端条目只允许移除，并如实说明原因。
 */

interface WorkspaceOption {
  key: string;
  label: string;
  remote: boolean;
}

function buildWorkspaceOptions(params: {
  entries: readonly WorkspaceRegistryEntry[];
  activeKey: string | null;
  activePath: string | null;
}): WorkspaceOption[] {
  const options: WorkspaceOption[] = [];
  const seen = new Set<string>();
  for (const entry of params.entries) {
    if (seen.has(entry.workspaceKey)) continue;
    seen.add(entry.workspaceKey);
    options.push({
      key: entry.workspaceKey,
      label: entry.workspacePath,
      remote: Boolean(entry.workspaceIdentity),
    });
  }
  // 注册表拉不到（旧 Host / 测试 double）时至少让当前工作区可配置：那是用户此刻正在看的项目。
  if (params.activeKey && params.activePath && !seen.has(params.activeKey)) {
    options.unshift({
      key: params.activeKey,
      label: params.activePath,
      remote: params.activeKey !== params.activePath,
    });
  }
  return options;
}

export function WorkspaceAdditionalDirectoriesSection({
  workspacePath,
  workspaceIdentity,
}: {
  workspacePath?: string | null;
  workspaceIdentity?: string;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const { settings, update } = useSettings();
  const registry = useWorkspaceRegistry();
  const [explicitKey, setExplicitKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const activeKey = workspacePath
    ? resolveWorkspaceRegistryKey({ workspacePath, workspaceIdentity })
    : null;
  const options = useMemo(
    () =>
      buildWorkspaceOptions({
        entries: registry.entries,
        activeKey,
        activePath: workspacePath ?? null,
      }),
    [activeKey, registry.entries, workspacePath],
  );
  const targetKey = explicitKey ?? activeKey ?? options[0]?.key ?? null;
  const targetOption = options.find((option) => option.key === targetKey) ?? null;
  const directories = resolveWorkspaceAdditionalDirectories(
    settings?.workspaceAdditionalDirectories,
    targetKey ?? "",
  );
  const settingsReady = settings !== null;
  const atLimit = directories.length >= MAX_WORKSPACE_ADDITIONAL_DIRECTORIES;
  const canEdit = settingsReady && !saving && targetKey !== null;
  const canAdd = canEdit && !targetOption?.remote && !atLimit;

  const save = useCallback(
    async (nextDirectories: readonly string[]) => {
      if (!targetKey) return;
      setSaving(true);
      try {
        // 只提交被改的键：服务端按键合并，两个客户端同时编辑不同工作区不会互相覆盖。
        await update({
          workspaceAdditionalDirectories: buildWorkspaceAdditionalDirectoriesPatch(
            targetKey,
            nextDirectories,
          ),
        });
        toast(intl.formatMessage({ id: "settings.workspaceAdditionalDirectories.saved" }));
      } catch (error) {
        logger.warn("[WorkspaceAdditionalDirectoriesSection] 保存附加目录失败", {
          workspaceKey: targetKey,
          error: error instanceof Error ? error.message : String(error),
        });
        toast(intl.formatMessage({ id: "settings.workspaceAdditionalDirectories.saveFailed" }));
      } finally {
        setSaving(false);
      }
    },
    [intl, settings?.workspaceAdditionalDirectories, targetKey, update],
  );

  const handleAdd = useCallback(async () => {
    // F1 地基：平台支持多选时一次加入多个目录；不支持时退回单选。
    const picked = platform.selectDirectories
      ? await platform.selectDirectories()
      : [await platform.selectDirectory()];
    const next = [...directories];
    for (const candidate of picked) {
      const trimmed = candidate?.trim();
      if (trimmed && !next.includes(trimmed)) next.push(trimmed);
    }
    if (next.length === directories.length) return;
    await save(next);
  }, [directories, platform, save]);

  const handleRemove = useCallback(
    async (directory: string) => {
      await save(directories.filter((candidate) => candidate !== directory));
    },
    [directories, save],
  );

  if (!targetKey) {
    return (
      <p className="text-ui-base leading-6 text-foreground-subtle">
        {intl.formatMessage({ id: "settings.workspaceAdditionalDirectories.noWorkspace" })}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="text-ui-base font-medium text-foreground-subtle">
        {intl.formatMessage({ id: "settings.workspaceAdditionalDirectories.description" })}
      </div>
      <SettingsGroupCard>
        <SettingsRow
          controlLayout="stacked"
          label={intl.formatMessage({
            id: "settings.workspaceAdditionalDirectories.workspaceLabel",
          })}
          description={intl.formatMessage({
            id: "settings.workspaceAdditionalDirectories.effectHint",
          })}
          control={
            <div className="flex w-full flex-col gap-3">
              {options.length > 1 ? (
                <Select value={targetKey} onValueChange={(nextKey) => setExplicitKey(nextKey)}>
                  <SelectTrigger
                    size="lg"
                    className="w-full min-w-0 justify-between"
                    aria-label={intl.formatMessage({
                      id: "settings.workspaceAdditionalDirectories.workspaceLabel",
                    })}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {options.map((option) => (
                      <SelectItem key={option.key} value={option.key}>
                        {option.remote
                          ? intl.formatMessage(
                              { id: "settings.workspaceAdditionalDirectories.remoteOption" },
                              { path: option.label },
                            )
                          : option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <div className="truncate font-mono text-ui-base text-foreground">
                  {targetOption?.label ?? targetKey}
                </div>
              )}

              {directories.length === 0 ? (
                <p className="text-ui-base leading-6 text-foreground-subtle">
                  {intl.formatMessage({ id: "settings.workspaceAdditionalDirectories.empty" })}
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {directories.map((directory) => (
                    <li
                      key={directory}
                      className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
                    >
                      <span className="min-w-0 truncate font-mono text-ui-base text-foreground">
                        {directory}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={!canEdit}
                        aria-label={intl.formatMessage(
                          { id: "settings.workspaceAdditionalDirectories.removeLabel" },
                          { path: directory },
                        )}
                        onClick={() => void handleRemove(directory)}
                      >
                        <Trash2 className="size-4" />
                        {intl.formatMessage({
                          id: "settings.workspaceAdditionalDirectories.remove",
                        })}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" size="sm" disabled={!canAdd} onClick={() => void handleAdd()}>
                  <FolderPlus className="size-4" />
                  {intl.formatMessage({ id: "settings.workspaceAdditionalDirectories.add" })}
                </Button>
                {targetOption?.remote ? (
                  <span className="text-ui-base text-foreground-subtle">
                    {intl.formatMessage({
                      id: "settings.workspaceAdditionalDirectories.remoteUnsupported",
                    })}
                  </span>
                ) : atLimit ? (
                  <span className="text-ui-base text-foreground-subtle">
                    {intl.formatMessage(
                      { id: "settings.workspaceAdditionalDirectories.limitReached" },
                      { count: MAX_WORKSPACE_ADDITIONAL_DIRECTORIES },
                    )}
                  </span>
                ) : null}
              </div>
            </div>
          }
        />
      </SettingsGroupCard>
    </div>
  );
}
