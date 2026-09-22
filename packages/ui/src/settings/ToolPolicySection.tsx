import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
  DEFAULT_DANGEROUS_EXECUTABLES,
  MAX_CUSTOM_DANGEROUS_ENTRIES,
  MAX_DANGEROUS_PATTERN_LENGTH,
  PRIVILEGE_WRAPPERS,
  normalizeDangerousPattern,
  resolveDangerousCommandPolicy,
  type DangerousCommandPolicy,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import {
  SettingsResourceGroupHeader,
  SettingsResourceList,
} from "@/settings/SettingsResourceGroup.js";

/**
 * 「工具与权限」设置分区。
 *
 * 定位：这是**全局策略**页，只回答两个问题 ——
 * ① 危险命令能不能被「记住」（持久授权）；② 哪些命令算危险。
 * 资源级启停（MCP / 插件）属于各自的资源页，本页**不提供**，避免两个真相源
 * （AGENTS.md「避免重复状态和多条写入路径」）。
 *
 * 生效时机是**新建会话**：策略随 session 创建经运行时偏好链路冻结。已运行的会话不重新读，
 * 所以页面上如实标注 —— 用户改了开关却发现当前会话没变化，会以为开关坏了。
 */

interface PolicyDraft {
  allowPersistentAuthorization: boolean;
  disabledEntries: string[];
  customEntries: Array<{ pattern: string; enabled: boolean }>;
}

function toDraft(policy: DangerousCommandPolicy | undefined): PolicyDraft {
  return {
    allowPersistentAuthorization: policy?.allowPersistentAuthorization === true,
    customEntries: (policy?.customEntries ?? []).map((entry) => ({
      enabled: entry.enabled !== false,
      pattern: entry.pattern,
    })),
    disabledEntries: [...(policy?.disabledEntries ?? [])],
  };
}

function toPolicy(draft: PolicyDraft): DangerousCommandPolicy {
  return {
    allowPersistentAuthorization: draft.allowPersistentAuthorization,
    customEntries: draft.customEntries,
    disabledEntries: draft.disabledEntries,
  };
}

function DangerousEntryRow({
  description,
  enabled,
  label,
  saving,
  onToggle,
  onDelete,
}: {
  description: string;
  enabled: boolean;
  label: string;
  saving: boolean;
  onToggle: (next: boolean) => void;
  /** 只在用户自加项上传入：默认项只能关闭，不能删除（关闭可逆、删除不可逆）。 */
  onDelete?: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-ui-base text-foreground">{label}</div>
        <div className="mt-0.5 text-ui-sm text-foreground-subtle">{description}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Switch
          checked={enabled}
          disabled={saving}
          onCheckedChange={(checked) => onToggle(checked === true)}
          aria-label={intl.formatMessage(
            {
              id: enabled
                ? "settings.toolPolicy.entry.disable"
                : "settings.toolPolicy.entry.enable",
            },
            { name: label },
          )}
        />
        {onDelete ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={saving}
            aria-label={intl.formatMessage(
              { id: "settings.toolPolicy.custom.delete" },
              { name: label },
            )}
            onClick={onDelete}
          >
            <Trash2 className="size-4" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function ToolPolicySection({
  policy,
  saving,
  onChange,
}: {
  policy: DangerousCommandPolicy | undefined;
  saving: boolean;
  onChange: (next: DangerousCommandPolicy) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const [draft, setDraft] = useState<PolicyDraft>(() => toDraft(policy));
  const [customInput, setCustomInput] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);

  // 生效策略：与 core 侧同一个 resolver，页面上「哪些项在生效」就是判定用的那份。
  const resolved = useMemo(() => resolveDangerousCommandPolicy(toPolicy(draft)), [draft]);

  const commit = (next: PolicyDraft) => {
    setDraft(next);
    void onChange(toPolicy(next));
  };

  const setEntryEnabled = (id: string, enabled: boolean) => {
    const disabled = new Set(draft.disabledEntries);
    if (enabled) {
      disabled.delete(id);
    } else {
      disabled.add(id);
    }
    commit({ ...draft, disabledEntries: [...disabled] });
  };

  const addCustom = () => {
    const normalized = normalizeDangerousPattern(customInput);
    if (!normalized) {
      setInputError(intl.formatMessage({ id: "settings.toolPolicy.custom.invalid" }));
      return;
    }
    if (draft.customEntries.some((entry) => entry.pattern === normalized)) {
      setInputError(intl.formatMessage({ id: "settings.toolPolicy.custom.duplicate" }));
      return;
    }
    if (draft.customEntries.length >= MAX_CUSTOM_DANGEROUS_ENTRIES) {
      setInputError(intl.formatMessage({ id: "settings.toolPolicy.custom.tooMany" }));
      return;
    }
    setInputError(null);
    setCustomInput("");
    commit({
      ...draft,
      customEntries: [...draft.customEntries, { enabled: true, pattern: normalized }],
    });
  };

  // 提权项排在最前：它管的是「任何提权命令都走保守化」，覆盖面比单个可执行名大。
  const defaultEntries = useMemo(
    () => [
      ...PRIVILEGE_WRAPPERS.map((name) => ({ id: name, kind: "privilege" as const })),
      ...DEFAULT_DANGEROUS_EXECUTABLES.map((name) => ({ id: name, kind: "executable" as const })),
    ],
    [],
  );
  const enabledCount =
    resolved.enabledDefaultEntries.length +
    draft.customEntries.filter((entry) => entry.enabled).length;

  return (
    <div className="space-y-4">
      <SettingsGroupCard>
        <SettingsRow
          controlLayout="stacked"
          label={intl.formatMessage({ id: "settings.toolPolicy.persistent.label" })}
          description={
            <span className="block space-y-1">
              <span className="block">
                {intl.formatMessage({ id: "settings.toolPolicy.persistent.description" })}
              </span>
              <span className="block">
                {intl.formatMessage({ id: "settings.toolPolicy.persistent.behaviorChange" })}
              </span>
              {/* 如实声明生效时机：新建会话才生效，不能写成"已生效"。 */}
              <span className="block text-foreground-subtlest">
                {intl.formatMessage({ id: "settings.toolPolicy.appliesToNewSessions" })}
              </span>
            </span>
          }
          control={
            <Switch
              checked={draft.allowPersistentAuthorization}
              disabled={saving}
              onCheckedChange={(checked) =>
                commit({ ...draft, allowPersistentAuthorization: checked === true })
              }
              aria-label={intl.formatMessage({ id: "settings.toolPolicy.persistent.label" })}
            />
          }
        />
      </SettingsGroupCard>

      <div className="space-y-2">
        <SettingsResourceGroupHeader
          actions={
            <span className="min-w-0 text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "settings.toolPolicy.list.hint" })}
            </span>
          }
          count={enabledCount}
          title={intl.formatMessage({ id: "settings.toolPolicy.list.title" })}
        />
        <SettingsResourceList
          getKey={(entry) => entry.id}
          items={defaultEntries}
          renderItem={(entry) => (
            <DangerousEntryRow
              description={intl.formatMessage({
                id:
                  entry.kind === "privilege"
                    ? "settings.toolPolicy.entry.privilege.description"
                    : "settings.toolPolicy.entry.executable.description",
              })}
              enabled={!resolved.disabledDefaultEntries.includes(entry.id)}
              label={
                entry.kind === "privilege"
                  ? intl.formatMessage(
                      { id: "settings.toolPolicy.entry.privilege" },
                      { name: entry.id },
                    )
                  : entry.id
              }
              saving={saving}
              onToggle={(next) => setEntryEnabled(entry.id, next)}
            />
          )}
        />
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.toolPolicy.list.defaultsNotDeletable" })}
        </p>
      </div>

      <div className="space-y-2">
        <SettingsResourceGroupHeader
          count={draft.customEntries.length}
          title={intl.formatMessage({ id: "settings.toolPolicy.custom.title" })}
        />
        <SettingsResourceList
          getKey={(entry) => entry.pattern}
          items={draft.customEntries}
          renderItem={(entry) => (
            <DangerousEntryRow
              description={intl.formatMessage({
                id: entry.pattern.includes(" ")
                  ? "settings.toolPolicy.custom.prefix.description"
                  : "settings.toolPolicy.custom.executable.description",
              })}
              enabled={entry.enabled}
              label={entry.pattern}
              saving={saving}
              onDelete={() =>
                commit({
                  ...draft,
                  customEntries: draft.customEntries.filter(
                    (candidate) => candidate.pattern !== entry.pattern,
                  ),
                })
              }
              onToggle={(next) =>
                commit({
                  ...draft,
                  customEntries: draft.customEntries.map((candidate) =>
                    candidate.pattern === entry.pattern
                      ? { ...candidate, enabled: next }
                      : candidate,
                  ),
                })
              }
            />
          )}
        />
        <SettingsGroupCard>
          <SettingsRow
            controlLayout="stacked"
            control={null}
            label={intl.formatMessage({ id: "settings.toolPolicy.custom.add.label" })}
            description={intl.formatMessage({ id: "settings.toolPolicy.custom.add.description" })}
            detail={
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    aria-label={intl.formatMessage({ id: "settings.toolPolicy.custom.add.label" })}
                    className="min-w-0 flex-1 font-mono"
                    maxLength={MAX_DANGEROUS_PATTERN_LENGTH}
                    placeholder={intl.formatMessage({
                      id: "settings.toolPolicy.custom.add.placeholder",
                    })}
                    size="lg"
                    spellCheck={false}
                    value={customInput}
                    onChange={(event) => {
                      setCustomInput(event.currentTarget.value);
                      setInputError(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        addCustom();
                      }
                    }}
                  />
                  <Button
                    disabled={saving}
                    size="lg"
                    type="button"
                    variant="outline"
                    onClick={addCustom}
                  >
                    <Plus className="size-4" />
                    <span>
                      {intl.formatMessage({ id: "settings.toolPolicy.custom.add.action" })}
                    </span>
                  </Button>
                </div>
                {inputError ? (
                  <div className="text-ui-sm text-destructive">{inputError}</div>
                ) : null}
              </div>
            }
          />
        </SettingsGroupCard>
      </div>
    </div>
  );
}
