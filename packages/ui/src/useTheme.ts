import { useEffect, useState, useCallback } from "react";
import { logger } from "@/logger.js";

export type Theme = "light" | "dark" | "zai-light" | "zai-dark" | "system";
export type ResolvedTheme = "light" | "dark";

/**
 * 主题偏好持久化 key 与内置回退值。
 *
 * issue #2 背景：注入页面可以向渲染层 localStorage 写入外来主题条目（报告人写的
 * zcode-custom-themes / zcode-theme-palette 在本仓库与官方 3.14.3/3.14.4 发行包中
 * 都不存在；真正会被污染的是这个 zcode-theme）。所有读取/采纳入口都必须校验：
 * 非法值回退到内置 palette 并记录 warn，不能让外来条目改变整条主题链路。
 */
export const THEME_STORAGE_KEY = "zcode-theme";
export const DEFAULT_THEME: Theme = "zai-dark";

const BROWSER_THEME_SURFACE_ATTRIBUTE = "data-zcode-browser-theme-surface";

function getSystemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme === "system") {
    return getSystemTheme();
  }

  return theme === "dark" || theme === "zai-dark" ? "dark" : "light";
}

export function normalizeThemePreference(theme: Theme): Theme {
  if (theme === "dark") return "zai-dark";
  if (theme === "light") return "zai-light";
  return theme;
}

function setThemeMetaContent(name: "theme-color" | "color-scheme", content: string) {
  let meta = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = name;
    document.head.append(meta);
  }
  meta.content = content;
}

function syncBrowserThemeSurface(resolved: ResolvedTheme) {
  const root = document.documentElement;
  if (
    typeof root.hasAttribute !== "function" ||
    !root.hasAttribute(BROWSER_THEME_SURFACE_ATTRIBUTE)
  ) {
    return;
  }

  // Electron 为 vibrancy 保持透明根背景，但普通浏览器需要从文档根和标准 meta
  // 获得页面主题。只切换 React 的 dark class 会让浏览器工具栏、原生控件和 overscroll 留在旧主题。
  root.setAttribute(BROWSER_THEME_SURFACE_ATTRIBUTE, resolved);
  root.style.colorScheme = resolved;
  setThemeMetaContent("color-scheme", resolved);

  const background = getComputedStyle(root).getPropertyValue("--color-background").trim();
  if (background) {
    setThemeMetaContent("theme-color", background);
  }
}

export function applyTheme(theme: Theme) {
  // 采纳入口先消毒：外来/非法值（第三方写入 localStorage 或广播通道传入的字符串）
  // 在这里回退到内置 palette。否则 html 上 theme-zai-light / theme-zai-dark 两个类
  // 会同时缺失，整个 UI 只剩 @theme 里的裸默认变量，失去主题归属。
  const safeTheme = sanitizeTheme(theme);
  const resolved = resolveTheme(safeTheme);
  const appliedTheme =
    safeTheme === "system"
      ? resolved === "dark"
        ? "zai-dark"
        : "zai-light"
      : normalizeThemePreference(safeTheme);
  document.documentElement.classList.toggle("dark", resolved === "dark");
  document.documentElement.classList.toggle("theme-zai-light", appliedTheme === "zai-light");
  document.documentElement.classList.toggle("theme-zai-dark", appliedTheme === "zai-dark");
  syncBrowserThemeSurface(resolved);
}

function isTheme(value: unknown): value is Theme {
  return (
    value === "light" ||
    value === "dark" ||
    value === "zai-light" ||
    value === "zai-dark" ||
    value === "system"
  );
}

const warnedInvalidThemeValues = new Set<string>();

function warnInvalidTheme(raw: unknown, source: string): void {
  const dedupeKey = source + ":" + String(raw);
  if (warnedInvalidThemeValues.has(dedupeKey)) return;
  warnedInvalidThemeValues.add(dedupeKey);
  // 用 lifecycle.warn 而非普通 warn：第三方篡改是低频但需要在生产可观测的事件，
  // 普通 renderer warn 在生产构建里 no-op（见 logger.ts 的生产日志门控），
  // lifecycle.warn 在桌面端经 window.zcode.log 桥落到 main 进程日志。
  logger.lifecycle.warn("[Theme] 主题条目非法或疑似第三方篡改，已回退内置 palette", {
    source,
    key: THEME_STORAGE_KEY,
    raw,
  });
}

/**
 * 读取并校验持久化的主题偏好。
 *
 * 非法/外来条目（例如注入页面写入的 custom:jarvis-vivid-quantum）不得改变 UI 主题：
 * 回退 DEFAULT_THEME 并记录 warn。localStorage 不可读（隐私模式、沙箱 iframe）时静默回退。
 */
export function readPersistedTheme(): Theme {
  let raw: string | null;
  try {
    raw = localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return DEFAULT_THEME;
  }
  if (raw === null) {
    return DEFAULT_THEME;
  }
  if (!isTheme(raw)) {
    warnInvalidTheme(raw, "localStorage");
    return DEFAULT_THEME;
  }
  return normalizeThemePreference(raw);
}

/**
 * 校验运行时传入的主题值（类型断言挡不住广播/外部调用传入的任意字符串），
 * 非法值回退 DEFAULT_THEME 并记录 warn，防止外来值被持久化或广播。
 */
export function sanitizeTheme(value: unknown): Theme {
  if (isTheme(value)) {
    return normalizeThemePreference(value);
  }
  warnInvalidTheme(value, "runtime");
  return DEFAULT_THEME;
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => {
    // 默认主题统一收敛到 Zai dark，避免旧 hook 兜底值和 Zustand store 默认值分叉。
    return readPersistedTheme();
  });

  const setTheme = useCallback((t: Theme) => {
    // 广播和其他调用方可能绕过类型检查传入非法字符串，写入前消毒，
    // 避免外来值落盘并扩散到其他窗口。
    const normalizedTheme = sanitizeTheme(t);
    localStorage.setItem(THEME_STORAGE_KEY, normalizedTheme);
    setThemeState(normalizedTheme);
    applyTheme(normalizedTheme);
  }, []);

  // 初始化 + system 模式下监听系统偏好变化
  useEffect(() => {
    applyTheme(theme);

    if (theme !== "system") return;

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => applyTheme("system");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  return { theme, setTheme } as const;
}
