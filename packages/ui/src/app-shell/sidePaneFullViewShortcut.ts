/**
 * 侧边面板全视图快捷键判定（⌘⇧F / Ctrl+Shift+F）。
 *
 * 抽成纯函数的原因：键位判断分散在 window keydown 里时，Alt 组合、大小写、
 * 浏览器保留键这些边界只能靠人工试；这里用单元测试把边界钉住。
 */
export function isSidePaneFullViewShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === "f"
  );
}
