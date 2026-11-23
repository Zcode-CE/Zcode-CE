"use client";

import { createMermaidPlugin, type MermaidConfig } from "@streamdown/mermaid";
import { Loader2Icon } from "lucide-react";
import type { HTMLAttributes, MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { cn } from "@/components/lib/utils.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import type { Theme } from "@/useTheme.js";
import { resolveTheme } from "@/useTheme.js";

type MermaidRenderState =
  | {
      status: "loading";
    }
  | {
      status: "ready";
      svg: string;
    }
  | {
      status: "plaintext";
    };

export interface MermaidBlockProps extends HTMLAttributes<HTMLDivElement> {
  code: string;
  /**
   * 应用主题（store 耦合剥离）：由调用方从上层状态传入。
   * 默认 "system" 跟随操作系统，供旧调用点/待删代码兜底。
   */
  theme?: Theme;
  onOpenPreview?: () => void;
  onPreviewSvgChange?: (svg: string | null) => void;
}

const mermaidPlugin = createMermaidPlugin();
let mermaidRenderQueue = Promise.resolve();
const MERMAID_COLOR_CANVAS_SENTINEL = "#010203";

// Mermaid 底层的 khroma 解析器不支持 Tailwind v4 常见的 oklab/color-mix 结果。
// 先让浏览器解析主题 token，再通过 canvas 采样成传统 rgb/rgba，避免把现代 CSS 颜色直接传给 Mermaid。
// Web 远程控制的启动测试只提供了最小 document mock，SSR/预渲染环境也可能没有 DOM 工厂；
// 颜色归一化是增强能力，不能让 MessageResponse 的静态导入在这些环境中直接崩溃。
const canCreateDomElements =
  typeof document !== "undefined" && typeof document.createElement === "function";
const mermaidColorResolverEl: HTMLSpanElement | null = canCreateDomElements
  ? document.createElement("span")
  : null;
const mermaidColorNormalizeCtx: CanvasRenderingContext2D | null = (() => {
  if (!canCreateDomElements) {
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (ctx) {
    ctx.globalCompositeOperation = "copy";
  }
  return ctx;
})();

/**
 * Mermaid 渲染出的 SVG 里，`click A href "…"` 会变成 `<a xlink:href>`，不经过应用的链接组件。
 * 点击这类锚点默认在窗口内做顶层导航：挂 `window.zcode` preload 的窗口一旦被远程页面接管，
 * 该页面就继承了整窗特权 IPC，而链接内容由模型输出（Markdown）决定。
 * 因此只把绝对 HTTP(S) 链接当作可外开的候选，其余协议（javascript: / data: / file: / mailto:
 * / 应用自定义协议）一律不交给宿主打开。
 */
const MERMAID_EXTERNAL_LINK_PROTOCOLS = new Set(["http:", "https:"]);

/** 把 SVG 锚点的 href 规整成可交给系统浏览器打开的 URL；不安全或不可解析时返回 null。 */
export function resolveMermaidExternalLinkUrl(href: string | null | undefined): string | null {
  const trimmedHref = href?.trim();
  if (!trimmedHref) {
    return null;
  }

  try {
    const url = new URL(trimmedHref);
    return MERMAID_EXTERNAL_LINK_PROTOCOLS.has(url.protocol) ? url.href : null;
  } catch {
    // 相对地址没有可信基准（文档 URL 本身可能就是 file:/dev server），按不可外开处理。
    return null;
  }
}

function enqueueMermaidRender<T>(task: () => Promise<T>): Promise<T> {
  const run = mermaidRenderQueue.then(task, task);
  mermaidRenderQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function hashMermaidCode(code: string): string {
  let hash = 2166136261;
  for (let index = 0; index < code.length; index += 1) {
    hash ^= code.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

function normalizeCssColorForMermaid(raw: string, fallback: string): string {
  if (!raw || !mermaidColorResolverEl || !mermaidColorNormalizeCtx || !document.body) {
    return raw || fallback;
  }

  try {
    document.body.appendChild(mermaidColorResolverEl);
    mermaidColorResolverEl.style.color = "";
    mermaidColorResolverEl.style.color = raw;
    const resolved = getComputedStyle(mermaidColorResolverEl).color;
    if (!resolved) {
      return fallback;
    }

    mermaidColorNormalizeCtx.clearRect(0, 0, 1, 1);
    mermaidColorNormalizeCtx.fillStyle = MERMAID_COLOR_CANVAS_SENTINEL;
    const sentinelFillStyle = mermaidColorNormalizeCtx.fillStyle;
    mermaidColorNormalizeCtx.fillStyle = resolved;
    // 如果 canvas 也不支持该颜色格式，fillStyle 会停在哨兵色，直接回退到 Mermaid 可解析的安全色。
    if (mermaidColorNormalizeCtx.fillStyle === sentinelFillStyle) {
      return fallback;
    }

    mermaidColorNormalizeCtx.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 255] = mermaidColorNormalizeCtx.getImageData(0, 0, 1, 1).data;
    const roundedAlpha = +(a / 255).toFixed(3);
    return roundedAlpha >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${roundedAlpha})`;
  } catch {
    return fallback;
  } finally {
    mermaidColorResolverEl.remove();
  }
}

function resolveCssColor(variableName: string, fallback: string): string {
  if (typeof document === "undefined" || !document.body) {
    return fallback;
  }

  const probe = document.createElement("span");
  probe.style.color = `var(${variableName})`;
  probe.style.pointerEvents = "none";
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();

  return normalizeCssColorForMermaid(color, fallback);
}

function createMermaidConfig(resolvedTheme: "light" | "dark"): MermaidConfig {
  const background = resolveCssColor(
    "--color-card",
    resolvedTheme === "dark" ? "#18181b" : "#ffffff",
  );
  const surface = resolveCssColor(
    "--color-surface",
    resolvedTheme === "dark" ? "#27272a" : "#f4f4f5",
  );
  const accent = resolveCssColor(
    "--color-accent",
    resolvedTheme === "dark" ? "#1f2937" : "#f0f9ff",
  );
  const text = resolveCssColor(
    "--color-foreground",
    resolvedTheme === "dark" ? "#f4f4f5" : "#27272a",
  );
  const subtleText = resolveCssColor(
    "--color-foreground-subtle",
    resolvedTheme === "dark" ? "#a1a1aa" : "#52525b",
  );
  const border = resolveCssColor(
    "--color-border",
    resolvedTheme === "dark" ? "#3f3f46" : "#d4d4d8",
  );

  return {
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
    securityLevel: "strict",
    startOnLoad: false,
    suppressErrorRendering: true,
    theme: "base",
    themeVariables: {
      actorBkg: background,
      actorBorder: border,
      actorTextColor: text,
      background,
      lineColor: subtleText,
      mainBkg: background,
      nodeBorder: border,
      noteBkgColor: accent,
      noteTextColor: text,
      primaryBorderColor: border,
      primaryColor: surface,
      primaryTextColor: text,
      secondaryBorderColor: border,
      secondaryColor: accent,
      secondaryTextColor: text,
      signalColor: subtleText,
      signalTextColor: text,
      tertiaryBorderColor: border,
      tertiaryColor: background,
      tertiaryTextColor: text,
      textColor: text,
    },
  };
}

function resolveBrowserTheme(theme: Theme): "light" | "dark" {
  if (typeof window === "undefined") {
    return theme === "dark" || theme === "zai-dark" ? "dark" : "light";
  }

  return resolveTheme(theme);
}

function useSystemThemeRevision(theme: Theme): number {
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (theme !== "system" || typeof window === "undefined") {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => setRevision((current) => current + 1);

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }

    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, [theme]);

  return revision;
}

function normalizeMermaidRenderError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function MermaidBlock({
  code,
  className,
  theme = "system",
  onOpenPreview,
  onPreviewSvgChange,
  ...props
}: MermaidBlockProps) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const systemThemeRevision = useSystemThemeRevision(theme);
  const renderIdPrefix = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const trimmedCode = code.trim();
  const resolvedTheme = resolveBrowserTheme(theme);
  const themeKey = `${theme}:${resolvedTheme}:${systemThemeRevision}`;
  const mermaidConfig = useMemo(
    () => createMermaidConfig(resolvedTheme),
    [resolvedTheme, themeKey],
  );
  const renderKey = useMemo(
    () => `${themeKey}:${hashMermaidCode(trimmedCode)}`,
    [themeKey, trimmedCode],
  );
  const [renderState, setRenderState] = useState<MermaidRenderState>({
    status: "loading",
  });

  /**
   * SVG 内部的锚点点击先在这里截住：无论链接是否安全都阻止窗口内顶层导航，
   * 安全链接改走宿主的 platform/openExternal 通道（与 Markdown 外链同一出口）。
   */
  const handleSvgClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const target = event.target;
      const anchor =
        typeof Element === "undefined" || !(target instanceof Element) ? null : target.closest("a");
      if (!anchor) {
        return;
      }

      event.preventDefault();
      const url = resolveMermaidExternalLinkUrl(
        anchor.getAttribute("href") ?? anchor.getAttribute("xlink:href"),
      );
      if (!url) {
        logger.debug("[MermaidBlock] 已拦截非 HTTP(S) 的 SVG 链接点击", {
          hasHref: anchor.hasAttribute("href") || anchor.hasAttribute("xlink:href"),
        });
        return;
      }

      if (platform) {
        platform.openExternal(url);
        return;
      }
      // 普通 Web / 只读分享页没有 PlatformProvider：新开标签页并拒绝交出 opener。
      globalThis.open?.(url, "_blank", "noopener,noreferrer");
    },
    [platform],
  );

  useEffect(() => {
    let cancelled = false;

    if (!trimmedCode) {
      setRenderState({
        status: "plaintext",
      });
      onPreviewSvgChange?.(null);
      return;
    }

    setRenderState({ status: "loading" });
    onPreviewSvgChange?.(null);
    const renderId = `zcode-mermaid-${renderIdPrefix}-${hashMermaidCode(renderKey)}`;

    void enqueueMermaidRender(async () => {
      const renderer = mermaidPlugin.getMermaid(mermaidConfig);
      return renderer.render(renderId, trimmedCode);
    })
      .then(({ svg }) => {
        if (!cancelled) {
          setRenderState({ status: "ready", svg });
          onPreviewSvgChange?.(svg);
        }
      })
      .catch((error: unknown) => {
        const message = normalizeMermaidRenderError(error);
        logger.debug("[MermaidBlock] Mermaid 渲染失败", {
          error: message,
          codeLength: trimmedCode.length,
        });
        if (!cancelled) {
          // Mermaid 解析失败常见于模型流式输出未完成或用户粘贴了非标准语法。
          // 退回纯文本能保留内容可读，避免用错误面板打断聊天阅读。
          setRenderState({ status: "plaintext" });
          onPreviewSvgChange?.(null);
        }
      });

    return () => {
      cancelled = true;
      onPreviewSvgChange?.(null);
    };
  }, [intl, mermaidConfig, onPreviewSvgChange, renderIdPrefix, renderKey, trimmedCode]);

  return (
    <div
      className={cn("group/mermaid relative min-h-32 w-full bg-card", className)}
      data-mermaid-block=""
      {...props}
    >
      <div className="max-h-[420px] overflow-auto p-3 text-foreground">
        {renderState.status === "loading" ? (
          <div className="flex min-h-28 items-center justify-center gap-2 text-foreground-subtle text-ui-base">
            <Loader2Icon className="size-4 animate-spin" />
            <span>{intl.formatMessage({ id: "codeBlock.mermaid.loading" })}</span>
          </div>
        ) : null}
        {renderState.status === "plaintext" ? (
          <pre className="m-0 min-h-28 min-w-max bg-transparent font-mono text-foreground text-ui-base leading-relaxed">
            {code}
          </pre>
        ) : null}
        {renderState.status === "ready" ? (
          <div
            aria-label={intl.formatMessage({ id: "codeBlock.mermaid.ariaLabel" })}
            className="flex min-h-28 min-w-max items-center justify-center [&_svg]:h-auto [&_svg]:max-w-none"
            dangerouslySetInnerHTML={{ __html: renderState.svg }}
            onClick={handleSvgClick}
            onDoubleClick={onOpenPreview}
            role="img"
          />
        ) : null}
      </div>
    </div>
  );
}
