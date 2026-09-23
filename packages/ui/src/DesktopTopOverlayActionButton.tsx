import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";

interface DesktopTopOverlayActionButtonProps {
  title: string;
  ariaLabel: string;
  children: ReactNode;
  shortcut?: string;
  disabled?: boolean;
  onClick: () => void;
  onMouseEnter?: () => void;
  side?: ComponentProps<typeof ControlHintTooltip>["side"];
  buttonClassName?: string;
  testId?: string;
}

export function DesktopTopOverlayActionButton({
  title,
  ariaLabel,
  children,
  shortcut,
  disabled,
  onClick,
  onMouseEnter,
  side = "bottom",
  buttonClassName,
  testId,
}: DesktopTopOverlayActionButtonProps) {
  return (
    <ControlHintTooltip title={title} shortcut={shortcut} side={side}>
      <Button
        type="button"
        variant="ghost"
        size="icon-md"
        // 基础 Button 默认 transition-all，缩放窗口时会把标题栏按钮的尺寸/位置变化也动画化，
        // Windows 连续缩放下会像按钮先复位再跟随；这里的浮层按钮只需要 hover 色彩过渡。
        // 触屏（手机）上把命中区补到 44×44：icon-md 实测只有 28×28，而拇指命中区约 44px，
        // 相邻按钮中心距仅 32px 时必然误触（task-22 审计 §2.3）。桌面鼠标路径（pointer: fine）逐项不变。
        className={cn(
          "[app-region:no-drag] transition-colors [@media(pointer:coarse)]:size-11",
          buttonClassName,
        )}
        data-testid={testId}
        aria-label={ariaLabel}
        disabled={disabled}
        // 顶部浮层的新建任务入口会复用带可选 provider 参数的业务函数。
        // 如果直接交给 React onClick，MouseEvent 会被当成 provider 传下去，并在日志 IPC 克隆时抛错。
        // 这里统一丢弃 DOM 事件，只调用组件约定的无参动作。
        onClick={() => onClick()}
        onMouseEnter={onMouseEnter}
      >
        {children}
      </Button>
    </ControlHintTooltip>
  );
}
