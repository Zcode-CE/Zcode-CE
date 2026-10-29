type AppBadgeSetter = (count: number) => void;
type OverlayIconSetter = (count: number) => void;

export function parseWindowUnreadCount(payload: unknown): number | null {
  if (typeof payload !== "number" || !Number.isInteger(payload) || payload < 0) {
    return null;
  }

  return payload;
}

export function sumWindowUnreadCounts(windowUnreadCountMap: ReadonlyMap<number, number>): number {
  let totalUnreadCount = 0;

  for (const unreadCount of windowUnreadCountMap.values()) {
    totalUnreadCount += unreadCount;
  }

  return totalUnreadCount;
}

function supportsAppUnreadBadge(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "linux";
}

/**
 * 未读角标按平台走两条原生路径：
 * - macOS / Linux：`app.setBadgeCount`（Dock / Launcher 计数）；
 * - Windows：任务栏角标是 overlay icon，没有数字 API；用红色圆点表示「有未读」，
 *   数量放在 overlay 的 description 里（辅助技术可读）。传入 setOverlayIcon 才算支持；
 *   未提供时保持既有行为（不显示角标）。
 */
export function syncAppUnreadBadge(options: {
  platform: NodeJS.Platform;
  totalUnreadCount: number;
  setBadgeCount: AppBadgeSetter;
  setOverlayIcon?: OverlayIconSetter;
}): void {
  if (options.platform === "win32") {
    options.setOverlayIcon?.(options.totalUnreadCount);
    return;
  }
  if (!supportsAppUnreadBadge(options.platform)) {
    return;
  }

  options.setBadgeCount(options.totalUnreadCount);
}
