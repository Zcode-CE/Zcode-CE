import { useCallback, useState } from "react";
import { MonitorSmartphoneIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  REMOTE_CONTROL_DEVICES_TEST_ID,
  REMOTE_CONTROL_DEVICE_REVOKE_ALL_TEST_ID,
  REMOTE_CONTROL_DEVICE_REVOKE_ONE_TEST_ID,
  REMOTE_CONTROL_DEVICE_ROW_TEST_ID,
  type RemoteControlConnection,
  type RemoteControlConnectionsSnapshotOrUnknown,
} from "@/remoteControlPanelModel.js";

/**
 * 「已连设备」区块（ce.4 连接面，spec §3.3 / §3.5）。
 *
 * 三件事必须一起看，否则会把状态说错：
 *
 * 1. 读不到与没有设备是两个不同的事实。`connections === null` 是「不知道」
 *    （服务没在跑 / HTTP 读失败 / 载荷畸形），此时显示一句如实的话，不显示「暂无设备」 ——
 *    后者是一个断言（"确实没人连着"），而我们知道的事实只是"读不到"。
 *    反过来，空数组才是真的「暂无设备」。
 * 2. 断开动作由能力门控：`onRevoke` 没注入就不渲染断开按钮（不是渲染成禁用）。
 *    禁用按钮会承诺一个不存在的动作，与本仓既有纪律同形
 *    （见 remoteControlPanelModel.ts 的 canRenderRemoteControlPanel）。
 * 3. 危险动作一律二次确认：复用全局 ConfirmDialogHost（`useConfirmDialog`），
 *    不新造弹窗。断开一个设备会让那台设备上的人掉线，不该一键生效。
 *
 * 角色显示（`terminal-client` / `trusted-host`）走 i18n 而不是直接打印枚举值：
 * 用户看到的是「浏览器」/「受信主机」，枚举值是协议内部词汇。
 */
export interface RemoteControlDevicesSectionProps {
  /** 读面快照；`null` = 读不到（与「空数组 = 暂无设备」严格区分）。 */
  connections: RemoteControlConnectionsSnapshotOrUnknown;
  /**
   * 断开动作。不传 ⇒ 不渲染断开按钮（能力缺失 ⇒ 不渲染）。
   * `{ id }` 断开单个；`{ all: true }` 全部断开 —— 形状逐字对齐 spec §6.4。
   */
  onRevoke?: (input: { id: string } | { all: true }) => void | Promise<void>;
  className?: string;
}

export function RemoteControlDevicesSection({
  connections,
  onRevoke,
  className,
}: RemoteControlDevicesSectionProps) {
  const { intl } = useZCodeIntl();
  const t = useCallback((id: string) => intl.formatMessage({ id }), [intl]);
  const confirmDialog = useConfirmDialog();
  // 在途标记是渲染进程本地状态：断开请求发出到结算之间必须让用户看出"正在断"，
  // 否则连点会发第二次请求（与面板 start/stop 的在途机制同源）。
  const [inFlight, setInFlight] = useState<string | null>(null);

  const revoke = useCallback(
    async (input: { id: string } | { all: true }, confirmKey: "revokeOne" | "revokeAll") => {
      if (!onRevoke) return;
      const confirmed = await confirmDialog({
        title: t(`remotePanel.confirm.${confirmKey}.title`),
        description: t(`remotePanel.confirm.${confirmKey}.body`),
        confirmVariant: "destructive",
      });
      if (!confirmed) return;
      const key = "all" in input ? "all" : input.id;
      setInFlight(key);
      try {
        await onRevoke(input);
      } finally {
        setInFlight(null);
      }
    },
    [confirmDialog, onRevoke, t],
  );

  // 读不到 ⇒ 如实说，不显示「暂无设备」（那是一个我们不知道的断言）。
  if (connections == null) {
    return (
      <section
        data-testid={REMOTE_CONTROL_DEVICES_TEST_ID}
        data-remote-control-devices="unknown"
        className={className}
      >
        <p className="text-ui-base text-foreground-subtle">{t("remotePanel.devices.unknown")}</p>
      </section>
    );
  }

  const rows = connections.connections;

  return (
    <section
      data-testid={REMOTE_CONTROL_DEVICES_TEST_ID}
      data-remote-control-devices={rows.length === 0 ? "empty" : "listed"}
      data-remote-control-devices-revision={String(connections.revision)}
      className={className}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-ui-base font-medium text-foreground">
          {t("remotePanel.devices.title")}
        </span>
        {/*
          全部断开：只在确实有设备且宿主提供动作时渲染。
          0 台时渲染它是承诺一个无事可做的动作；没注入动作时渲染它是承诺一个不存在的动作。
        */}
        {onRevoke && rows.length > 0 ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid={REMOTE_CONTROL_DEVICE_REVOKE_ALL_TEST_ID}
            disabled={inFlight !== null}
            className="[@media(pointer:coarse)]:min-h-11"
            onClick={() => void revoke({ all: true }, "revokeAll")}
          >
            {t("remotePanel.devices.revokeAll")}
          </Button>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <p className="text-ui-base text-foreground-subtle">{t("remotePanel.devices.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <DeviceRow
              key={row.id}
              row={row}
              busy={inFlight !== null}
              onRevoke={onRevoke ? () => void revoke({ id: row.id }, "revokeOne") : undefined}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

const ROLE_MESSAGE_ID: Record<RemoteControlConnection["role"], string> = {
  "terminal-client": "remotePanel.devices.role.terminalClient",
  "trusted-host": "remotePanel.devices.role.trustedHost",
};

function DeviceRow({
  row,
  busy,
  onRevoke,
}: {
  row: RemoteControlConnection;
  busy: boolean;
  onRevoke?: () => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });

  return (
    <li
      data-testid={REMOTE_CONTROL_DEVICE_ROW_TEST_ID}
      data-remote-control-device-role={row.role}
      className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2"
    >
      <MonitorSmartphoneIcon
        aria-hidden="true"
        className="size-4 shrink-0 text-foreground-subtle"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/* 地址是这一行最要紧的信息（用户据此判断"这是不是我"），因此它用正常前景色。 */}
        <span className="min-w-0 truncate text-ui-base text-foreground">{row.address}</span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-ui-caption text-foreground-subtle">
          <Badge variant="outline" className="shrink-0">
            {t(ROLE_MESSAGE_ID[row.role])}
          </Badge>
          {/* 连接时间：按用户 locale 格式化。connectedAt 是 epoch 毫秒（传输层只传事实）。 */}
          <span>{formatConnectedAt(row.connectedAt, locale)}</span>
          {row.userAgent ? (
            <span className="min-w-0 truncate" title={row.userAgent}>
              {row.userAgent}
            </span>
          ) : null}
        </span>
      </div>
      {onRevoke ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid={REMOTE_CONTROL_DEVICE_REVOKE_ONE_TEST_ID}
          data-remote-control-revoke-device-id={row.id}
          disabled={busy}
          className="shrink-0 [@media(pointer:coarse)]:min-h-11"
          onClick={onRevoke}
        >
          {t("remotePanel.devices.revokeOne")}
        </Button>
      ) : null}
    </li>
  );
}

/**
 * 连接时间格式化。用 Intl 按当前 locale 渲染，不自己拼字符串 ——
 * 面板要同时服务中文与英文用户，手拼的「2026-09-27 14:03」在两种语言下都不合规范。
 *
 * 时间戳非法时返回空串而不是 "Invalid Date"：那是给开发者看的，不是给用户看的文案。
 * 校验在 model 的 parseRemoteControlConnections 已做过一次（fail-closed），这里是显示层的兜底。
 */
function formatConnectedAt(connectedAt: number, locale: string): string {
  if (!Number.isFinite(connectedAt)) return "";
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(connectedAt));
}
