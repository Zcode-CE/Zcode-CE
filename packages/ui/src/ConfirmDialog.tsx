import { useCallback, useEffect, useRef, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox.js";
import { XIcon, TriangleAlertIcon, FolderIcon, SquareTerminalIcon, GlobeIcon } from "lucide-react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog.js";
import { TID_CONFIRM_DIALOG_CONFIRM } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import { cn } from "@/components/lib/utils.js";
import {
  AUTOMATION_CONFIRM_DIALOG_CONTENT_CLASS,
  AUTOMATION_CONFIRM_DIALOG_DESCRIPTION_CLASS,
} from "@/settings/automationConfirmDialogPresentation.js";

export function ConfirmDialogHost() {
  const { intl } = useZCodeIntl();
  const pendingRequest = useConfirmDialogStore((state) => state.pendingRequest);
  const settleConfirmation = useConfirmDialogStore((state) => state.settleConfirmation);

  const settleChoice = useConfirmDialogStore((state) => state.settleChoice);

  const displayedRequestRef = useRef(pendingRequest);
  if (pendingRequest) {
    // Promise 结算后 store 会立刻清空 pendingRequest，但 Radix 关闭动画还会保留一帧内容层。
    // 如果这里直接读取 pendingRequest，退场动画期间标题/描述会先变空，只剩“确认 / 取消”按钮闪一下。
    // 因此关闭完成前继续沿用最后一次可见内容，只让 open 状态控制弹窗退场。
    displayedRequestRef.current = pendingRequest;
  }
  const displayedRequest = pendingRequest ?? displayedRequestRef.current;
  const [checkboxSelection, setCheckboxSelection] = useState<{
    request: typeof displayedRequest;
    checked: boolean;
  }>({ request: undefined, checked: false });
  // 勾选只属于本次请求，关闭后再次打开不能沿用上次的风险确认。
  const checkboxChecked =
    checkboxSelection.request === displayedRequest && checkboxSelection.checked;
  const open = Boolean(pendingRequest);
  const isAutomationConfirmation = displayedRequest?.presentation === "automation-confirmation";
  const isYoloConfirmation = displayedRequest?.presentation === "yolo-confirmation";
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmLabel =
    displayedRequest?.confirmLabel ?? intl.formatMessage({ id: "common.confirm" });
  const cancelLabel = displayedRequest?.cancelLabel ?? intl.formatMessage({ id: "common.cancel" });
  const compact = displayedRequest?.compact === true;

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      // Radix 在点击遮罩或按 Esc 时只会回调 onOpenChange(false)。
      // 如果这里不主动把 Promise 结算为 false，调用侧会一直悬挂，后续删除操作也会被卡住。
      if (!nextOpen) {
        settleChoice("dismiss");
      }
    },
    [settleChoice],
  );

  const handleConfirm = useCallback(() => {
    settleConfirmation(true);
  }, [settleConfirmation]);

  useEffect(() => {
    // 完全访问确认必须由用户勾选后手动点击确认，Enter 兜底会绕过风险告知。
    if (!open || isYoloConfirmation) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Enter") {
        return;
      }

      // 带复选框的选择对话框保留焦点按钮的键盘语义，避免“不了”按 Enter 变成切换。
      if (
        displayedRequest?.checkbox &&
        event.target instanceof HTMLElement &&
        event.target.closest("button,input")
      )
        return;
      // 二次确认场景下如果不接 Enter，键盘用户会只能切到按钮再触发，
      // 体验和桌面端的确认弹窗不一致。这里在弹窗打开时统一兜住 Enter，保持可预期的确认手势。
      event.preventDefault();
      event.stopPropagation();
      settleConfirmation(true);
    }

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [open, isYoloConfirmation, settleConfirmation, displayedRequest]);

  if (isYoloConfirmation) {
    return (
      <AlertDialog open={open} onOpenChange={handleOpenChange}>
        <AlertDialogContent
          data-testid="yolo-confirmation-dialog"
          className="max-h-[calc(100dvh-2rem)] gap-4 overflow-y-auto bg-popover p-4 shadow-md sm:p-5"
          onOpenAutoFocus={(event) => {
            // 默认焦点必须落在「取消」：误触 Enter/回车不能直接开启完全访问。
            event.preventDefault();
            cancelRef.current?.focus();
          }}
        >
          <AlertDialogHeader className="gap-2">
            <AlertDialogTitle className="flex items-center gap-3">
              <TriangleAlertIcon className="size-5 shrink-0" aria-hidden="true" />
              {displayedRequest?.title}
            </AlertDialogTitle>
            <AlertDialogDescription className="leading-relaxed sm:leading-6">
              {intl.formatMessage({ id: "mode.yoloConfirmation.description" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="divide-y divide-border rounded-xl bg-surface px-3">
            {(
              [
                ["files", FolderIcon, "text-icon-blue"],
                ["commands", SquareTerminalIcon, "text-foreground-subtle"],
                ["network", GlobeIcon, "text-icon-blue"],
              ] as const
            ).map(([category, Icon, iconColor]) => (
              <li key={category} className="flex items-center gap-3 py-2">
                <Icon className={cn("size-5 shrink-0", iconColor)} aria-hidden="true" />
                <div className="min-w-0 space-y-0.5">
                  <p className="text-ui-base font-semibold">
                    {intl.formatMessage({ id: `mode.yoloConfirmation.${category}` })}
                  </p>
                  <p className="text-ui-base text-foreground-subtle sm:text-ui-sm">
                    {intl.formatMessage({ id: `mode.yoloConfirmation.${category}.description` })}
                  </p>
                </div>
              </li>
            ))}
          </ul>
          <p className="text-ui-base leading-relaxed text-foreground-subtle sm:text-ui-sm sm:leading-5">
            {intl.formatMessage({ id: "mode.yoloConfirmation.risk" })}
          </p>
          <label className="flex cursor-pointer items-start gap-2 text-ui-base leading-relaxed text-foreground">
            <Checkbox
              data-testid="yolo-confirmation-risk"
              className="mt-1"
              checked={checkboxChecked}
              onCheckedChange={(value) =>
                setCheckboxSelection({ request: displayedRequest, checked: value === true })
              }
            />
            <span>{intl.formatMessage({ id: "mode.yoloConfirmation.acknowledgement" })}</span>
          </label>
          {/* 手机沿用等宽触控按钮；桌面保留紧凑、按内容宽度的操作区。 */}
          <AlertDialogFooter className="grid grid-cols-2 gap-3 sm:flex sm:gap-2">
            <AlertDialogCancel
              ref={cancelRef}
              variant="secondary"
              size="lg"
              className="h-auto min-h-11 whitespace-normal px-4 sm:h-9 sm:min-h-0 sm:whitespace-nowrap"
              data-testid="yolo-confirmation-cancel"
              onClick={() => settleConfirmation(false)}
            >
              {intl.formatMessage({ id: "common.cancel" })}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              size="lg"
              className="h-auto min-h-11 whitespace-normal px-4 sm:h-9 sm:min-h-0 sm:whitespace-nowrap"
              data-testid="yolo-confirmation-confirm"
              disabled={!checkboxChecked}
              onClick={handleConfirm}
            >
              {intl.formatMessage({ id: "mode.yoloConfirmation.confirm" })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        data-confirm-intent={displayedRequest?.intent}
        data-testid={displayedRequest?.testId}
        showCloseButton={false}
        overlayClassName={
          compact ? "bg-black/20 supports-backdrop-filter:backdrop-blur-[2px]" : undefined
        }
        className={cn(
          "gap-5 rounded-2xl border-none bg-popover/98 p-5 ring-border shadow-2xl",
          // 仅依赖共享弹框的响应式 max-width 时，不同入口所在 viewport 会让
          // 同一删除确认框看起来尺寸不一致。定时任务删除按设计固定同一 presentation。
          isAutomationConfirmation ? AUTOMATION_CONFIRM_DIALOG_CONTENT_CLASS : "sm:max-w-md",
          displayedRequest?.compact && "top-[44%] min-h-[161px] gap-4 sm:max-w-[400px]",
        )}
      >
        <DialogHeader className="gap-2">
          <DialogTitle className="text-ui-lg font-semibold text-foreground">
            {displayedRequest?.title}
          </DialogTitle>
          {displayedRequest?.description ? (
            <DialogDescription
              className={cn(
                "whitespace-pre-line pt-0.5 text-ui-base leading-6 text-foreground-subtle",
                isAutomationConfirmation && AUTOMATION_CONFIRM_DIALOG_DESCRIPTION_CLASS,
              )}
            >
              {displayedRequest.description}
            </DialogDescription>
          ) : null}
        </DialogHeader>
        <DialogFooter
          className={cn(
            "gap-2 sm:justify-end",
            displayedRequest?.checkbox && "flex-row flex-wrap items-center",
            // Automation 弹窗的最小高度会拉伸 Grid footer 行，按钮停在行顶导致视觉底距超过 20px。
            isAutomationConfirmation && "mt-auto",
          )}
        >
          {displayedRequest?.checkbox ? (
            <label className="mr-auto flex min-w-0 items-center gap-2 text-ui-base text-foreground-subtle">
              <Checkbox
                checked={checkboxChecked}
                onCheckedChange={(value) => {
                  setCheckboxSelection({ request: displayedRequest, checked: value === true });
                  displayedRequest.checkbox?.onCheckedChange(value === true);
                }}
              />
              {displayedRequest.checkbox.label}
            </label>
          ) : null}
          <div
            className={displayedRequest?.checkbox ? "ml-auto flex items-center gap-2" : "contents"}
          >
            <Button
              type="button"
              variant={compact ? "outline" : "secondary"}
              size={"lg"}
              onClick={() => settleConfirmation(false)}
              className={cn(
                "h-9 gap-3 px-4",
                displayedRequest?.showKeyboardHints !== false && "justify-between sm:min-w-28",
              )}
            >
              <span>{cancelLabel}</span>
              {displayedRequest?.showKeyboardHints !== false ? (
                <span className="font-mono text-ui-base text-foreground-subtle">esc</span>
              ) : null}
            </Button>
            <Button
              type="button"
              autoFocus
              // 普通确认沿用主按钮；仅显式声明 destructive 的不可恢复动作使用危险色。
              variant={displayedRequest?.confirmVariant ?? "default"}
              size={"lg"}
              data-testid={TID_CONFIRM_DIALOG_CONFIRM}
              onClick={handleConfirm}
              className={cn(
                "h-9 gap-3 px-4",
                displayedRequest?.showKeyboardHints !== false && "justify-between sm:min-w-32",
              )}
            >
              <span>{confirmLabel}</span>
              {displayedRequest?.showKeyboardHints !== false ? (
                <span
                  className={
                    displayedRequest?.confirmVariant === "destructive"
                      ? "text-ui-base text-destructive-foreground/60"
                      : "text-ui-base text-primary-foreground/60"
                  }
                >
                  ⏎
                </span>
              ) : null}
            </Button>
          </div>
        </DialogFooter>
        {displayedRequest?.showCloseButton ? (
          <DialogClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={intl.formatMessage({ id: "common.close" })}
              className="absolute right-5 top-5 z-20 text-foreground-subtle hover:bg-surface-hover hover:text-foreground [app-region:no-drag]"
            >
              <XIcon className="size-4" strokeWidth={4 / 3} />
            </Button>
          </DialogClose>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
