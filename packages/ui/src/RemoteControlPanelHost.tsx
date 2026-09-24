import { useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { RemoteControlPanel } from "@/RemoteControlPanel.js";
import { REMOTE_CONTROL_PANEL_TEST_ID } from "@/remoteControlPanelModel.js";
import type { useRemoteControlWiring } from "@/hooks/useRemoteControlWiring.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 远程控制面板的**宿主**弹窗（ce.3 · 切片 4）。
 *
 * 为什么单独一层：切片 1/3 的组件是纯 props 的（可注入、可真浏览器验收），
 * 接线是另一件事。这一层是唯一同时知道"IPC 状态"与"面板 props"的地方 ——
 * 面板本身仍然不知道 IPC 存在。
 *
 * **接线只做一次**：`wiring` 由调用方（WorkspaceSidebar）用
 * `useRemoteControlWiring()` 取好后传进来，而不是入口与宿主各取一次 ——
 * 取两次会建立**两条 IPC 订阅**并各自拉一次状态，两边可能短暂不一致
 * （入口显示"运行中"而面板显示"未开启"）。
 */
export function RemoteControlPanelHost({
  wiring,
  open,
  onOpenChange,
}: {
  wiring: ReturnType<typeof useRemoteControlWiring>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const renderable = wiring.renderable;

  // 能力缺失（Web 客户端）时若宿主已被打开，立刻关掉 —— 不留下一个空弹窗。
  useEffect(() => {
    if (!renderable && open) onOpenChange(false);
  }, [onOpenChange, open, renderable]);

  // 能力缺失 ⇒ 不渲染（与入口同一判据；不是渲染成禁用）。
  if (!renderable || !wiring.panel) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid={REMOTE_CONTROL_PANEL_TEST_ID + "-host"}
        className="sm:max-w-lg"
        showCloseButton
      >
        <DialogHeader className="gap-1">
          <DialogTitle className="text-ui-lg font-semibold text-foreground">
            {intl.formatMessage({ id: "remotePanel.title" })}
          </DialogTitle>
          <DialogDescription className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "remotePanel.subtitle" })}
          </DialogDescription>
        </DialogHeader>
        <RemoteControlPanel
          status={wiring.panel.status}
          connection={wiring.panel.connection}
          lanExposureConfirmed={wiring.lanExposureConfirmed}
          onLanExposureConfirmed={wiring.confirmLanExposure}
          onStart={(options) => wiring.actions.start(options)}
          onStop={() => wiring.actions.stop()}
        />
      </DialogContent>
    </Dialog>
  );
}
