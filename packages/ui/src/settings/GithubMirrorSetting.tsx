import { useCallback, useEffect, useState } from "react";
import {
  GITHUB_MIRROR_PREFIX_ERROR_CODES,
  resolveGithubMirrorPrefix,
  type GithubMirrorPrefixErrorCode,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { toast } from "@/components/ui/toast.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

/**
 * GitHub 加速前缀设置项。
 *
 * 为什么单独一个组件而不是并进 GeneralSectionContent：后者承载全部通用设置，
 * 本项只服务「GitHub 链路加速」一件事，独立组件能保证校验、脏值判断和错误映射都在一处，
 * 不与其它设置项的保存路径互相影响。
 *
 * 为什么在**保存前**校验而不是交给 schema：schema 拒绝只会让 settingService.update 抛错，
 * 用户看到的是通用失败提示；这里用 shared 的同一份校验提前拦下，才能给出「必须是 https」
 * 这类可操作的原因。两处共用 resolveGithubMirrorPrefix，判定不会分叉。
 */

/** 错误码 → 本地化文案 id；不靠错误文本做分支。 */
const ERROR_MESSAGE_IDS: Record<GithubMirrorPrefixErrorCode, string> = {
  [GITHUB_MIRROR_PREFIX_ERROR_CODES.invalidUrl]: "settings.githubMirror.error.invalidUrl",
  [GITHUB_MIRROR_PREFIX_ERROR_CODES.insecureProtocol]:
    "settings.githubMirror.error.insecureProtocol",
  [GITHUB_MIRROR_PREFIX_ERROR_CODES.credentials]: "settings.githubMirror.error.credentials",
  [GITHUB_MIRROR_PREFIX_ERROR_CODES.queryOrFragment]: "settings.githubMirror.error.queryOrFragment",
};

export function GithubMirrorSetting() {
  const { intl } = useZCodeIntl();
  const { settings, update } = useSettings();
  const saved = settings?.githubMirrorPrefix ?? "";
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(saved);
  }, [saved]);

  const normalizedDraft = draft.trim();
  const isDirty = normalizedDraft !== saved;

  const handleSave = useCallback(async () => {
    const resolution = resolveGithubMirrorPrefix(normalizedDraft);
    if (resolution.errorCode) {
      toast(intl.formatMessage({ id: ERROR_MESSAGE_IDS[resolution.errorCode] }));
      return;
    }
    const nextValue = resolution.prefix ?? "";
    setSaving(true);
    try {
      // 清空必须传空串：RPC 会丢弃 undefined，否则旧前缀会残留在 setting.json 里继续生效。
      await update({ githubMirrorPrefix: nextValue });
      setDraft(nextValue);
      toast(intl.formatMessage({ id: "settings.githubMirrorSavedHint" }));
    } catch (error) {
      logger.warn("[settings] 保存 GitHub 加速前缀失败", { error: String(error) });
      toast(intl.formatMessage({ id: "settings.githubMirror.error.saveFailed" }));
    } finally {
      setSaving(false);
    }
  }, [intl, normalizedDraft, update]);

  return (
    <SettingsGroupCard>
      <SettingsRow
        label={intl.formatMessage({ id: "settings.githubMirror" })}
        description={intl.formatMessage({ id: "settings.githubMirrorDescription" })}
        control={
          <Button
            type="button"
            size="lg"
            disabled={!isDirty || saving}
            onClick={() => void handleSave()}
          >
            {intl.formatMessage({ id: "settings.dataBaseDirSave" })}
          </Button>
        }
        detail={
          <Input
            size="lg"
            value={draft}
            placeholder={intl.formatMessage({ id: "settings.githubMirrorPlaceholder" })}
            aria-label={intl.formatMessage({ id: "settings.githubMirror" })}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && isDirty) {
                void handleSave();
              }
            }}
            className="max-w-[520px] font-mono"
          />
        }
      />
    </SettingsGroupCard>
  );
}
