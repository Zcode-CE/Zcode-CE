import { useCallback, useEffect, useState } from "react";
import {
  normalizeRemoteAssetCdnBaseUrl,
  REMOTE_ASSET_CDN_BASE_URL_ERROR_CODES,
  type RemoteAssetCdnBaseUrlErrorCode,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { toast } from "@/components/ui/toast.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

/**
 * 「自定义远程资产 CDN 地址」设置项（远程工作区的资产发布根）。
 *
 * 产品规则（优先级、唯一所有者、三种环境是否生效）见
 * `docs/development/remote-workspace.md` §3.1 —— 文档与实现必须一起读。
 *
 * 三个刻意的决定：
 * 1. **保存前用 shared 的同一份归一化校验**，而不是等 `settingService.update` 的 schema 抛错 ——
 *    schema 拒绝只给通用失败提示，用户看不到"必须是 http/https""不要带版本号"这类可操作原因。
 *    两处共用 `normalizeRemoteAssetCdnBaseUrl`，判定不会分叉。
 * 2. **非法值当场报错，绝不静默降级**：静默丢弃会让用户以为设置生效，实际仍走默认 CDN ——
 *    这个功能的失败现象本来就是"取资源 404"，再叠加静默丢弃就无法排查了。
 * 3. **组件在 Web 侧不会渲染**（分区注册里按 `isDesktop` 过滤，见 settingsPageConfig.ts）：
 *    这条链只有 desktop main 消费，Web 上显示一个点了没用的开关就是 UI 说谎。
 */

/** 错误码 → 本地化文案 id；按码分支，不解析错误文本。 */
const ERROR_MESSAGE_IDS: Record<RemoteAssetCdnBaseUrlErrorCode, string> = {
  [REMOTE_ASSET_CDN_BASE_URL_ERROR_CODES.notString]: "settings.remoteAssets.error.invalid",
  [REMOTE_ASSET_CDN_BASE_URL_ERROR_CODES.tooLong]: "settings.remoteAssets.error.tooLong",
  [REMOTE_ASSET_CDN_BASE_URL_ERROR_CODES.protocol]: "settings.remoteAssets.error.protocol",
  [REMOTE_ASSET_CDN_BASE_URL_ERROR_CODES.unparsable]: "settings.remoteAssets.error.invalid",
  [REMOTE_ASSET_CDN_BASE_URL_ERROR_CODES.queryOrFragment]:
    "settings.remoteAssets.error.queryOrFragment",
};

export function RemoteAssetsSetting() {
  const { intl } = useZCodeIntl();
  const { settings, update } = useSettings();
  const saved = settings?.remoteAssetCdnBaseUrl ?? "";
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [errorMessageId, setErrorMessageId] = useState<string | null>(null);

  useEffect(() => {
    setDraft(saved);
    setErrorMessageId(null);
  }, [saved]);

  const normalizedDraft = draft.trim();
  const isDirty = normalizedDraft !== saved;

  const handleSave = useCallback(async () => {
    const normalized = normalizeRemoteAssetCdnBaseUrl(normalizedDraft);
    if (normalized.kind === "invalid") {
      setErrorMessageId(ERROR_MESSAGE_IDS[normalized.code]);
      return;
    }
    setErrorMessageId(null);
    // 清空必须传空串：RPC 会丢弃 undefined，否则旧基址会残留在 setting.json 里继续生效。
    const nextValue = normalized.kind === "valid" ? normalized.value : "";
    setSaving(true);
    try {
      await update({ remoteAssetCdnBaseUrl: nextValue });
      setDraft(nextValue);
      toast(intl.formatMessage({ id: "settings.remoteAssets.savedHint" }));
    } catch (error) {
      logger.warn("[settings] 保存自定义远程资产 CDN 地址失败", { error: String(error) });
      toast(intl.formatMessage({ id: "settings.remoteAssets.error.saveFailed" }));
    } finally {
      setSaving(false);
    }
  }, [intl, normalizedDraft, update]);

  return (
    <SettingsGroupCard>
      <SettingsRow
        label={intl.formatMessage({ id: "settings.remoteAssets.cdnBaseUrl" })}
        description={intl.formatMessage({ id: "settings.remoteAssets.cdnBaseUrlDescription" })}
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
          <>
            <Input
              size="lg"
              value={draft}
              placeholder="https://your-host/assets"
              aria-label={intl.formatMessage({ id: "settings.remoteAssets.cdnBaseUrl" })}
              aria-invalid={errorMessageId !== null}
              onChange={(event) => {
                setDraft(event.currentTarget.value);
                // 用户一开始改就把上一次的错误收掉，避免"改了字错误还在"的误导。
                if (errorMessageId !== null) setErrorMessageId(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && isDirty) void handleSave();
              }}
              className="max-w-[520px] font-mono"
            />
            {errorMessageId !== null && (
              <p className="mt-1.5 text-ui-base text-destructive">
                {intl.formatMessage({ id: errorMessageId })}
              </p>
            )}
          </>
        }
      />
    </SettingsGroupCard>
  );
}
