export const quickPickDialogClassName =
  // max-md：手机宽度下给弹层留出左右边距。基础 DialogContent 的 max-w-[calc(100%-2rem)] 会被这里的
  // max-w-lg 覆盖（同属性、后者更大），390 实测弹层左右都贴屏幕边缘、圆角被切（task-22 审计 §2.8）。
  // 桌面（≥768）逐项不变。
  "top-1/2 max-w-lg max-md:max-w-[calc(100%-1rem)] -translate-y-1/2 overflow-hidden rounded-2xl! border-popover-border bg-popover p-0 shadow-md";

export const quickPickCommandClassName = "rounded-2xl bg-popover p-0.5 text-foreground";

export const quickPickListClassName = "max-h-[min(460px,64vh)] py-0.5";

export const quickPickItemClassName = "min-h-8 items-center rounded-xl px-2.5 text-ui-base";

export const quickPickShortcutPillClassName =
  // 触屏（手机）上没有键盘：快捷键徽标既用不上、又占掉每行右端宽度，直接不显示
  // （task-22 审计 §2.8：390 下 4 个 Ctrl 徽标 + 徽标列宽约 90px）。桌面不变。
  "inline-flex h-4 min-w-7 items-center justify-center rounded-sm bg-surface px-1 py-0 font-sans text-ui-base leading-none tracking-normal text-foreground-subtle [@media(pointer:coarse)]:hidden";

export const quickPickMetadataClassName =
  "max-w-[45%] truncate font-sans text-ui-base leading-none tracking-normal text-foreground-subtle";
