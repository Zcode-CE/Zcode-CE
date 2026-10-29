import assert from "node:assert/strict";
import test from "node:test";
import { syncAppUnreadBadge } from "../src/main/unreadBadge.js";

/**
 * F6：未读角标的平台分流。
 *
 * macOS/Linux 走 `app.setBadgeCount`；Windows 只认 `setOverlayIcon`（没有数字 API）。
 * 这条分支写错的形态是静默的：Windows 上角标永不出现，或把 badge 调用打到不支持的平台。
 */

test("macOS/Linux 走 badge，不碰 overlay", () => {
  for (const platform of ["darwin", "linux"] as const) {
    const badge: number[] = [];
    const overlay: number[] = [];
    syncAppUnreadBadge({
      platform,
      totalUnreadCount: 3,
      setBadgeCount: (count) => badge.push(count),
      setOverlayIcon: (count) => overlay.push(count),
    });
    assert.deepEqual(badge, [3]);
    assert.deepEqual(overlay, []);
  }
});

test("Windows 走 overlay（0 表示清除），不碰 badge", () => {
  const badge: number[] = [];
  const overlay: number[] = [];
  syncAppUnreadBadge({
    platform: "win32",
    totalUnreadCount: 2,
    setBadgeCount: (count) => badge.push(count),
    setOverlayIcon: (count) => overlay.push(count),
  });
  syncAppUnreadBadge({
    platform: "win32",
    totalUnreadCount: 0,
    setBadgeCount: (count) => badge.push(count),
    setOverlayIcon: (count) => overlay.push(count),
  });
  assert.deepEqual(badge, []);
  assert.deepEqual(overlay, [2, 0]);
});

test("Windows 没有 overlay setter 时保持原行为（不调用 badge）", () => {
  const badge: number[] = [];
  syncAppUnreadBadge({
    platform: "win32",
    totalUnreadCount: 1,
    setBadgeCount: (count) => badge.push(count),
  });
  assert.deepEqual(badge, []);
});
