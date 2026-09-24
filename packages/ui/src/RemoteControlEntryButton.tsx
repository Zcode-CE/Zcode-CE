import { MonitorSmartphone } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 远控入口按钮（ce.3 · 切片 1）。
 *
 * 只负责「入口 + 状态承载」：
 * - 状态**由 props 注入**（切片 4 接到后端的 `webService:status`），本组件不直连任何服务/进程/探测；
 * - 形态：账号区里一个**设备形态图标按钮**，位置由调用方（`WorkspaceSidebarFooter`）摆在账号名右侧；
 * - 触屏可发现性（spec §3.7 硬要求）：状态不能只靠 hover tooltip —— 状态点常显，且**无 hover 设备上
 *   把状态词直接显示出来**（复用仓库既有 `[@media(hover:none)]` 模式，先例见
 *   `ToolCallBlocks/ToolSummaryRow.tsx:216-218`）。
 */
/**
 * 入口状态。**只列真的会被产出的取值**（ce.3 硬规矩：产不出来的取值要么删、要么给出产出路径）。
 *
 * `"waiting"`（等待连接）已在切片 4 删除：它需要"有没有设备连进来"，而连接面
 * （已连设备清单）按契约 §7 **延后到 ce.4** —— `packages/desktop/src/main/web-service/**`
 * 里 0 处 connections，服务端只有限流用的内部 `activeConnections` 计数、未对外暴露。
 * ⇒ 今天它**没有任何产出路径**，留着只会让读者以为存在一条其实不存在的路径。
 * ce.4 落地连接面后，本类型加回 `"waiting"` 并在
 * `remoteControlWiring.resolveRemoteControlEntryStatus` 里给出判定即可。
 */
export type RemoteControlEntryStatus = "off" | "running";

/** 调用方注入的入口状态与打开动作（切片 4 的接线点）。 */
export interface RemoteControlEntry {
  status: RemoteControlEntryStatus;
  onOpen: () => void;
}

export const REMOTE_CONTROL_ENTRY_TEST_ID = "remote-control-entry";

const STATUS_MESSAGE_ID: Record<RemoteControlEntryStatus, string> = {
  off: "remotePanel.entry.status.off",
  running: "remotePanel.entry.status.running",
};

// 两种状态的语义色：未开启=弱化前景（不是"错误"），运行中=success。
// 不使用 destructive —— 「未开启」不是故障（DESIGN.md：语义色只用于真实语义状态）。
const STATUS_DOT_CLASS: Record<RemoteControlEntryStatus, string> = {
  off: "bg-foreground-subtlest",
  running: "bg-[var(--color-success)]",
};

export function RemoteControlEntryButton({
  entry,
  className,
}: {
  entry: RemoteControlEntry;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  const title = intl.formatMessage({ id: "remotePanel.entry.title" });
  const statusLabel = intl.formatMessage({ id: STATUS_MESSAGE_ID[entry.status] });

  return (
    <ControlHintTooltip
      // spec §3.6：悬浮提示标题「远程控制」，第二行是状态。
      title={
        <span className="flex flex-col gap-0.5">
          <span>{title}</span>
          <span className="text-foreground-subtlest">{statusLabel}</span>
        </span>
      }
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-testid={REMOTE_CONTROL_ENTRY_TEST_ID}
        // DOM 断言用：状态既是可读文案，也是机器可读属性（切片 4 接线后同一属性继续有效）。
        data-remote-control-status={entry.status}
        aria-label={`${title} · ${statusLabel}`}
        onClick={() => entry.onOpen()}
        // 触屏（手机）命中区 ≥44：实测桌面 34×24、390 70×24，高度 24 < 44（task-22 §2.7 同一类缺陷，
        // 与 §3b 同一机制：只看 pointer:coarse）。用 min-* 不用 size-*，状态词较长时宽度按内容走。
        className={cn(
          "relative shrink-0 gap-1.5 px-2 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11",
          className,
        )}
      >
        <span className="relative inline-flex">
          <MonitorSmartphone className="size-4" />
          <span
            aria-hidden="true"
            className={cn(
              "absolute -right-0.5 -top-0.5 size-1.5 rounded-full ring-1 ring-[var(--color-panel)]",
              STATUS_DOT_CLASS[entry.status],
            )}
          />
        </span>
        {/* 触屏（hover:none）常显状态词：手机没有 hover，不看 tooltip 也要能看出入口与状态。 */}
        <span className="hidden text-ui-xs text-foreground-subtle [@media(hover:none)]:inline">
          {statusLabel}
        </span>
      </Button>
    </ControlHintTooltip>
  );
}
