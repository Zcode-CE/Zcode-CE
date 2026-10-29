import type { CSSProperties, SyntheticEvent } from "react";
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { dispatchWorkspaceFileAddToChat } from "@/lib/workspaceFileDrag.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

interface ImagePreviewContentProps {
  title: string;
  imageSource: string;
  fitToContainer?: boolean;
  sourcePath?: string;
  /** 来源工作区作用域：只有带真实来源路径时才允许「添加到聊天」，远端按 identity 匹配。 */
  workspacePath?: string;
  workspaceIdentity?: string;
}

interface ImageNaturalSize {
  source: string;
  width: number;
  height: number;
}

const IMAGE_PREVIEW_CHECKERBOARD_CLASS =
  "[background-color:var(--color-background)] [background-image:linear-gradient(45deg,var(--color-surface)_25%,transparent_25%),linear-gradient(-45deg,var(--color-surface)_25%,transparent_25%),linear-gradient(45deg,transparent_75%,var(--color-surface)_75%),linear-gradient(-45deg,transparent_75%,var(--color-surface)_75%)] [background-position:0_0,0_4px,4px_-4px,-4px_0] [background-size:8px_8px]";

function getImagePreviewPixelRatio(sourceName: string): number {
  const fileName = sourceName.replace(/\\/g, "/").split("/").at(-1) ?? "";
  const match = /@(\d+(?:\.\d+)?)x(?=(?:\.[^./\\]+)?$)/i.exec(fileName);
  const ratio = match ? Number(match[1]) : 1;

  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

/** 把已加载的图片转成 PNG Blob；跨域污染/解码失败都会 reject，由调用方报失败。 */
function imageToPngBlob(image: HTMLImageElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context || canvas.width <= 0 || canvas.height <= 0) {
      reject(new Error("2d context unavailable"));
      return;
    }
    context.drawImage(image, 0, 0);
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("PNG encoding failed"));
    }, "image/png");
  });
}

const IMAGE_EXTENSION_BY_MEDIA_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/apng": "apng",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "image/svg+xml": "svg",
};

function dataUrlBytes(dataUrl: string): { bytes: Uint8Array; mediaType: string } | null {
  const match = /^data:([^;,]+)(?:;charset=[^;,]+)?;base64,(.*)$/u.exec(dataUrl);
  if (!match?.[1] || !match[2]) return null;
  try {
    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return { bytes, mediaType: match[1] };
  } catch {
    return null;
  }
}

function downloadBaseName(title: string, sourcePath?: string): string {
  const raw = (sourcePath ?? title).replace(/\\/gu, "/").split("/").at(-1) ?? title;
  const withoutExtension = raw.replace(/\.[^./]+$/u, "");
  return withoutExtension.trim() || "image";
}

export function ImagePreviewContent({
  title,
  fitToContainer = false,
  imageSource,
  sourcePath,
  workspacePath,
  workspaceIdentity,
}: ImagePreviewContentProps) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [naturalSize, setNaturalSize] = useState<ImageNaturalSize | null>(null);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [copying, setCopying] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const pixelRatio = useMemo(
    () => getImagePreviewPixelRatio(sourcePath ?? title),
    [sourcePath, title],
  );
  const imageStyle = useMemo<CSSProperties | undefined>(() => {
    if (
      fitToContainer ||
      pixelRatio <= 1 ||
      naturalSize?.source !== imageSource ||
      naturalSize.width <= 0 ||
      naturalSize.height <= 0
    ) {
      return undefined;
    }

    return {
      // Retina 文件名里的 @2x/@3x 表示物理像素倍率，预览时折算为 CSS 像素，避免素材被放大显示。
      height: naturalSize.height / pixelRatio,
      width: naturalSize.width / pixelRatio,
    };
  }, [fitToContainer, imageSource, naturalSize, pixelRatio]);
  const handleCopyImage = useCallback(async () => {
    const image = imageRef.current;
    if (!image || !imageLoaded || copying) return;
    setCopying(true);
    try {
      if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
        throw new Error("clipboard unavailable");
      }
      // 必须在用户操作内同步创建 promise：Safari 只在该手势窗口内允许写剪贴板。
      const pngBlobPromise = imageToPngBlob(image);
      await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlobPromise })]);
      toast(intl.formatMessage({ id: "preview.image.copySuccess" }));
    } catch {
      toast(intl.formatMessage({ id: "preview.image.copyFailed" }));
    } finally {
      setCopying(false);
    }
  }, [copying, imageLoaded, intl]);

  const handleAddToChat = useCallback(() => {
    if (!sourcePath) return;
    const normalizedWorkspace = workspacePath?.replace(/\\/gu, "/").replace(/\/+$/u, "");
    const normalizedPath = sourcePath.replace(/\\/gu, "/");
    // 工作区内生成相对引用；工作区外保留绝对路径（同名文件不能被误指向工作区内）。
    const relativePath =
      normalizedWorkspace && normalizedPath.startsWith(`${normalizedWorkspace}/`)
        ? normalizedPath.slice(normalizedWorkspace.length + 1)
        : sourcePath;
    const name = normalizedPath.split("/").at(-1) ?? title;
    const accepted = dispatchWorkspaceFileAddToChat({
      type: "file",
      workspacePath: workspacePath ?? "",
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      path: sourcePath,
      relativePath,
      name,
    });
    if (!accepted) {
      toast(intl.formatMessage({ id: "preview.image.addToChatFailed" }));
    }
  }, [intl, sourcePath, title, workspaceIdentity, workspacePath]);

  const handleDownloadImage = useCallback(async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      // 下载的是预览读到的原始字节（SVG 不会变成截图）；文件名按 MIME 对齐扩展名。
      const parsed = dataUrlBytes(imageSource);
      if (!parsed) throw new Error("image bytes unavailable");
      const extension = IMAGE_EXTENSION_BY_MEDIA_TYPE[parsed.mediaType.toLowerCase()] ?? "png";
      const suggestedName = `${downloadBaseName(title, sourcePath)}.${extension}`;
      // 显式复制到新的 ArrayBuffer：Uint8Array.buffer 的类型是 ArrayBufferLike（可能共享）。
      const data = new ArrayBuffer(parsed.bytes.byteLength);
      new Uint8Array(data).set(parsed.bytes);
      if (platform.saveFile) {
        const result = await platform.saveFile({ data, suggestedName });
        if (result.canceled) return;
        if (!result.success) throw new Error(result.error ?? "save_failed");
        // 原生保存成功只确认「下载成功」，不展示本机路径。
        toast(intl.formatMessage({ id: "preview.image.downloadSuccess" }));
        return;
      }
      const objectUrl = URL.createObjectURL(new Blob([data], { type: parsed.mediaType }));
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = suggestedName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
      toast(intl.formatMessage({ id: "preview.image.downloadStarted" }));
    } catch {
      toast(intl.formatMessage({ id: "preview.image.downloadFailed" }));
    } finally {
      setDownloading(false);
    }
  }, [downloading, imageSource, intl, platform, sourcePath, title]);

  const handleLoad = useCallback(
    (event: SyntheticEvent<HTMLImageElement>) => {
      setImageLoaded(true);
      if (fitToContainer) {
        return;
      }

      const image = event.currentTarget;

      setNaturalSize({
        source: imageSource,
        width: image.naturalWidth,
        height: image.naturalHeight,
      });
    },
    [fitToContainer, imageSource],
  );
  const imageClassName = fitToContainer
    ? "h-full max-h-full w-full max-w-full object-contain"
    : "h-auto max-h-full w-auto max-w-full object-contain";

  return (
    <div
      className={`relative flex h-full min-h-0 items-center justify-center overflow-hidden p-10 ${IMAGE_PREVIEW_CHECKERBOARD_CLASS}`}
    >
      <div className="absolute right-3 top-3 z-10 flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          className="inline-flex h-8 items-center rounded-lg border-0 bg-surface/90 px-3 text-ui-base font-medium text-foreground shadow-sm transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!imageLoaded || !sourcePath}
          onClick={handleAddToChat}
        >
          {intl.formatMessage({ id: "workspaceFileTree.addToChat" })}
        </button>
        <button
          type="button"
          className="inline-flex h-8 items-center rounded-lg border-0 bg-surface/90 px-3 text-ui-base font-medium text-foreground shadow-sm transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!imageLoaded || downloading}
          onClick={() => void handleDownloadImage()}
        >
          {intl.formatMessage({ id: "preview.image.download" })}
        </button>
        <button
          type="button"
          className="inline-flex h-8 items-center rounded-lg border-0 bg-surface/90 px-3 text-ui-base font-medium text-foreground shadow-sm transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!imageLoaded || copying}
          onClick={() => void handleCopyImage()}
        >
          {intl.formatMessage({ id: "preview.image.copy" })}
        </button>
      </div>
      <img
        ref={imageRef}
        alt={title}
        className={imageClassName}
        onLoad={handleLoad}
        src={imageSource}
        style={imageStyle}
      />
    </div>
  );
}

export function SvgPreviewContent({ title, svgContent }: { title: string; svgContent: string }) {
  return (
    <ImagePreviewContent
      fitToContainer
      title={title}
      imageSource={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgContent)}`}
    />
  );
}
