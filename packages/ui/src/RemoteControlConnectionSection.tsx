import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { AlertTriangleIcon, CheckIcon, CopyIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { writeTextToClipboard } from "@/lib/clipboardText.js";
import { logger } from "@/logger.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  REMOTE_CONTROL_PANEL_CONNECTION_TEST_ID,
  REMOTE_CONTROL_PANEL_COPY_TEST_ID,
  REMOTE_CONTROL_PANEL_FAILURE_TEST_ID,
  REMOTE_CONTROL_PANEL_LINK_TEST_ID,
  REMOTE_CONTROL_PANEL_QR_TEST_ID,
  hasUsableRemoteControlLink,
  shouldRenderQrCode,
  type RemoteControlConnectionInfo,
  type RemoteControlPanelView,
} from "@/remoteControlPanelModel.js";

/**
 * 「Web 控制」标签页的连接面（task-93 从 `RemoteControlPanel` 原样搬出，**逻辑零改动**）。
 *
 * 为什么值得单独一个文件：面板加上标签页后触到了仓库的 `max-lines` 上限（400，含注释与空行）。
 * 拆分的判据不是"行数好看了"，而是这几块本来就是**独立的一件事** ——
 * 连接面（地址/链接/二维码/复制）与失败块各自有自己的 testid 与判定来源，
 * 面板本体只负责"哪一档、放哪些块"。
 *
 * 行为与原文件逐条一致：
 * - 链接存在性只由 {@link hasUsableRemoteControlLink} 判定（**唯一所有者**）；
 * - 二维码判定只调用一次 {@link shouldRenderQrCode}（测试断言"只有一个调用点"）。
 */
export function RemoteControlConnectionSection({
  view,
  connection,
  className,
}: {
  view: RemoteControlPanelView;
  connection?: RemoteControlConnectionInfo | null;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  // 链接变化后重置复制反馈：否则用户会看到上一个链接的「已复制」留在新链接上。
  const link = connection?.linkWithToken ?? "";
  // 「有没有可用链接」只判定一次（model 的唯一所有者），链接行与二维码共用同一个结论。
  const hasLink = hasUsableRemoteControlLink(connection);
  useEffect(() => {
    setCopyState("idle");
  }, [link]);

  const copyLink = () => {
    if (!hasLink) return;
    // 非安全上下文（局域网 http://<ip>:<port>）没有 navigator.clipboard，
    // 必须走既有 lib/clipboardText.ts（它在用户手势的同步调用栈内回退到 execCommand）。
    writeTextToClipboard(link).then(
      () => setCopyState("copied"),
      (error: unknown) => {
        logger.warn("[RemoteControlPanel] 复制链接失败", error);
        setCopyState("failed");
      },
    );
  };

  const showQr = shouldRenderQrCode(view, connection);

  return (
    <>
      {/* 失败/异常分支：把原因单独成块，避免它和正常态挤在同一行被忽略。 */}
      {view.branch === "failed" || view.branch === "untrusted" ? (
        <div
          data-testid={REMOTE_CONTROL_PANEL_FAILURE_TEST_ID}
          data-remote-control-failure={view.branch}
          className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive"
        >
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0">{t(view.adviceMessageId)}</span>
        </div>
      ) : null}

      {/* 连接面：地址 / 链接 / 二维码 / 复制链接。只在 running 档渲染。 */}
      {view.showConnection ? (
        <section
          data-testid={REMOTE_CONTROL_PANEL_CONNECTION_TEST_ID}
          className={cn("flex flex-col gap-3", className)}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-ui-base font-medium text-foreground">
              {t("remotePanel.connection.title")}
            </span>
            <span className="text-ui-caption text-foreground-subtle">
              {t("remotePanel.connection.audience")}
            </span>
          </div>

          {hasLink ? (
            <div className="flex flex-wrap items-center gap-2">
              <code
                data-testid={REMOTE_CONTROL_PANEL_LINK_TEST_ID}
                className="min-w-0 flex-1 truncate rounded-md border border-border bg-surface px-2 py-1 text-ui-base text-foreground"
              >
                {link}
              </code>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                data-testid={REMOTE_CONTROL_PANEL_COPY_TEST_ID}
                data-remote-control-copy-state={copyState}
                // 粗指针（手机/平板）命中区 ≥44：size="sm" 只有 24 高，触屏上很难点中。
                // 与切片 1 入口同一机制（只按 pointer:coarse，桌面保持紧凑）。
                className="[@media(pointer:coarse)]:min-h-11"
                onClick={copyLink}
              >
                {copyState === "copied" ? (
                  <CheckIcon className="size-3.5" />
                ) : (
                  <CopyIcon className="size-3.5" />
                )}
                {copyState === "copied"
                  ? t("remotePanel.action.copied")
                  : copyState === "failed"
                    ? t("remotePanel.action.copyFailed")
                    : t("remotePanel.action.copyLink")}
              </Button>
            </div>
          ) : (
            <p className="text-ui-base text-foreground-subtle">
              {t("remotePanel.connection.linkPending")}
            </p>
          )}

          {/*
            二维码的渲染判定**只有这一个所有者**（model 的 shouldRenderQrCode）。
            这里刻意**不**把它塞进上面 `link ?` 的分支里：那样会出现两个判定点，
            改坏其中一个时另一个仍然兜住，反向验证就会"怎么改都不变红"——
            等于这条断言没打在它声称的面上（实测踩过：只改 shouldRenderQrCode 时 0 条变红）。
          */}
          {showQr ? <RemoteControlQrCode value={link} alt={t("remotePanel.qr.alt")} /> : null}
          <p className="text-ui-caption text-foreground-subtle">{t("remotePanel.qr.fallback")}</p>
        </section>
      ) : null}
    </>
  );
}

/**
 * 二维码：复用既有 `qrcode` 依赖（`packages/ui` 的 dependencies 里已有，**不新增依赖**）。
 *
 * 用 SVG 渲染而不是 canvas：`qrcode/lib/browser.js` 的 `toString({type:"svg"})` 不碰
 * `document.createElement("canvas")`，因此**可断言**（SVG 直接进 DOM，浏览器脚本能读到
 * `<path d>`），而 canvas 只能靠像素比对。
 */
function RemoteControlQrCode({ value, alt }: { value: string; alt: string }) {
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    QRCode.toString(value, { type: "svg", margin: 1, width: 160, errorCorrectionLevel: "M" }).then(
      (markup: string) => {
        if (!disposed) setSvg(markup);
      },
      (error: unknown) => {
        // 生成失败就当作没有二维码（不渲染半张图）；链接本身仍可复制。
        logger.warn("[RemoteControlPanel] 二维码生成失败", error);
        if (!disposed) setSvg(null);
      },
    );
    return () => {
      disposed = true;
    };
  }, [value]);

  if (!svg) return null;
  return (
    <div
      data-testid={REMOTE_CONTROL_PANEL_QR_TEST_ID}
      // 二维码**本身就是凭据**：不给它加 title/可复制文本，避免被顺手截图外发时的额外提示。
      role="img"
      aria-label={alt}
      className="size-40 shrink-0 rounded-md bg-white p-1 [&>svg]:size-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
