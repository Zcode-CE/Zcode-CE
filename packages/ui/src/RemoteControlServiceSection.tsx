import { useCallback, useState } from "react";
import { KeyRoundIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { cn } from "@/components/lib/utils.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  REMOTE_CONTROL_LISTEN_SCOPE_TEST_ID,
  REMOTE_CONTROL_PORT_INPUT_TEST_ID,
  REMOTE_CONTROL_ROTATE_TOKEN_TEST_ID,
  type RemoteControlStartScope,
} from "@/remoteControlPanelModel.js";

/**
 * 服务面控件（ce.4，spec §3.3）：监听范围、端口、令牌轮换。
 *
 * 这块是桌面面板专属。它承载的能力（起停服务、改监听、轮换令牌）只在"服务由我启动"
 * 时成立 —— 面板跑在那个服务之上时，停止等于自杀、启动不可能（spec §3.1 的服务面所有权）。
 * 因此：
 *
 * - 令牌轮换入口按能力门控：`onRotateToken` 没注入就整块不渲染（不是渲染成禁用）。
 *   这样 Web 侧天然没有这个入口，不需要在那里写一句"此功能不可用"——那是承诺一个不存在的动作。
 *   判据刻意选成"动作对象是否存在"这一条可测事实（与 canRenderRemoteControlImBotTab 同形）。
 * - 端口默认自动：不填就是不传 `port`，由服务端挑空闲端口。填了才传 ——
 *   这与桌面端 service.ts 的语义一致（显式端口被占用时明确失败，不偷偷换端口，
 *   否则用户复制出去的链接是错的）。
 * - 改监听范围要重开：运行中不允许直接改（改了也不会生效，那是"看着能改其实没用"）。
 *   运行中只提供一键切回环这一个动作，它明确地停掉再用回环重开。
 */

export interface RemoteControlServiceSectionProps {
  /** 当前选择（面板本地状态；服务未运行时是"下次开启用什么"）。 */
  scope: RemoteControlStartScope;
  onScopeChange: (scope: RemoteControlStartScope) => void;
  /** 自定义端口；空串 = 自动选择空闲端口。 */
  port: string;
  onPortChange: (port: string) => void;
  /** 服务是否在跑（运行中时监听范围只读，另给一键切回环）。 */
  running: boolean;
  /** 当前实际是否绑回环；false 且运行中时才有"仅本机"这个动作。 */
  loopback: boolean;
  /**
   * 令牌轮换。不传 ⇒ 不渲染该入口（桌面专属，spec §6.5 决策④）。
   */
  onRotateToken?: () => void | Promise<void>;
  /** 一键切回环（仅运行中且当前非回环时出现）。 */
  onSwitchToLoopback?: () => void | Promise<void>;
  className?: string;
}

export function RemoteControlServiceSection({
  scope,
  onScopeChange,
  port,
  onPortChange,
  running,
  loopback,
  onRotateToken,
  onSwitchToLoopback,
  className,
}: RemoteControlServiceSectionProps) {
  const { intl } = useZCodeIntl();
  const t = useCallback((id: string) => intl.formatMessage({ id }), [intl]);
  const confirmDialog = useConfirmDialog();
  const [rotating, setRotating] = useState(false);
  const [switching, setSwitching] = useState(false);

  const rotateToken = useCallback(async () => {
    if (!onRotateToken) return;
    const confirmed = await confirmDialog({
      title: t("remotePanel.confirm.rotateToken.title"),
      description: t("remotePanel.confirm.rotateToken.body"),
      confirmVariant: "destructive",
    });
    if (!confirmed) return;
    setRotating(true);
    try {
      await onRotateToken();
    } finally {
      setRotating(false);
    }
  }, [confirmDialog, onRotateToken, t]);

  const switchToLoopback = useCallback(async () => {
    if (!onSwitchToLoopback) return;
    setSwitching(true);
    try {
      await onSwitchToLoopback();
    } finally {
      setSwitching(false);
    }
  }, [onSwitchToLoopback]);

  return (
    <section
      data-testid={REMOTE_CONTROL_LISTEN_SCOPE_TEST_ID}
      data-remote-control-listen-scope={scope}
      data-remote-control-listen-locked={running ? "true" : "false"}
      className={cn("flex flex-col gap-2", className)}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ui-base font-medium text-foreground">
          {t("remotePanel.listen.label")}
        </span>
        {/*
          两个选项用 aria-pressed 表达选中（本仓既有模式，见 ConversationShareMenu.tsx:60）。
          运行中锁定：改了不会生效，允许点就是在承诺一个不存在的动作。
        */}
        <ScopeOption
          active={scope === "loopback"}
          disabled={running}
          label={t("remotePanel.listen.loopback")}
          onClick={() => onScopeChange("loopback")}
        />
        <ScopeOption
          active={scope === "lan"}
          disabled={running}
          label={t("remotePanel.listen.lan")}
          onClick={() => onScopeChange("lan")}
        />
        {/* 运行中且非回环 ⇒ 一键切回环（spec §3.3 决策①的硬要求）。 */}
        {running && !loopback && onSwitchToLoopback ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid={REMOTE_CONTROL_LISTEN_SCOPE_TEST_ID + "-loopback"}
            disabled={switching}
            className="[@media(pointer:coarse)]:min-h-11"
            onClick={() => void switchToLoopback()}
          >
            {t("remotePanel.listen.loopback")}
          </Button>
        ) : null}
      </div>

      {/* 端口：留空 = 自动选空闲端口（默认）。运行中不允许改（同上，改了不生效）。 */}
      <div className="flex flex-wrap items-center gap-2">
        <label
          htmlFor={REMOTE_CONTROL_PORT_INPUT_TEST_ID}
          className="text-ui-base text-foreground-subtle"
        >
          {t("remotePanel.listen.portLabel")}
        </label>
        <Input
          id={REMOTE_CONTROL_PORT_INPUT_TEST_ID}
          data-testid={REMOTE_CONTROL_PORT_INPUT_TEST_ID}
          inputMode="numeric"
          disabled={running}
          value={port}
          placeholder={t("remotePanel.listen.portPlaceholder")}
          className="w-40 [@media(pointer:coarse)]:min-h-11"
          onChange={(event) => onPortChange(event.target.value)}
        />
        <span className="text-ui-caption text-foreground-subtle">
          {port.trim() === ""
            ? t("remotePanel.listen.portAuto")
            : t("remotePanel.listen.customPort")}
        </span>
      </div>

      {/*
        令牌轮换：桌面专属（spec §6.5 决策④）。没有动作就整块不渲染 ——
        这一行是"Web 面板不暴露轮换入口"的可执行形式。
      */}
      {onRotateToken ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid={REMOTE_CONTROL_ROTATE_TOKEN_TEST_ID}
            disabled={rotating}
            className="[@media(pointer:coarse)]:min-h-11"
            onClick={() => void rotateToken()}
          >
            <KeyRoundIcon aria-hidden="true" className="size-3.5" />
            {rotating ? t("remotePanel.action.rotatingToken") : t("remotePanel.action.rotateToken")}
          </Button>
          <span className="min-w-0 text-ui-caption text-foreground-subtle">
            {t("remotePanel.danger.sharedToken")}
          </span>
        </div>
      ) : null}
    </section>
  );
}

function ScopeOption({
  active,
  disabled,
  label,
  onClick,
}: {
  active: boolean;
  disabled: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant={active ? "secondary" : "ghost"}
      size="sm"
      aria-pressed={active}
      disabled={disabled}
      className="[@media(pointer:coarse)]:min-h-11"
      onClick={onClick}
    >
      {label}
    </Button>
  );
}
