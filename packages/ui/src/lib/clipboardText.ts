/**
 * 写入纯文本到剪贴板。
 *
 * `navigator.clipboard` 只在安全上下文（https / localhost）存在；Web 远控经常通过
 * http://<内网或 tailnet IP> 访问，此时手机 Safari/Chrome 上它是 undefined，复制按钮会静默无效。
 * 这里回退到选区 + `document.execCommand("copy")`。回退路径必须在用户手势的同步调用栈内执行，
 * 因此调用方应在 click handler 里直接调用本函数（不要先 await）。
 *
 * Writes plain text to the clipboard, falling back to a selection + execCommand("copy")
 * when the async Clipboard API is unavailable (insecure http origins on mobile browsers).
 */
export function writeTextToClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).catch((error: unknown) => {
      if (copyTextWithSelectionFallback(text)) return;
      throw error;
    });
  }
  return copyTextWithSelectionFallback(text)
    ? Promise.resolve()
    : Promise.reject(new Error("clipboard_unavailable"));
}

function copyTextWithSelectionFallback(text: string): boolean {
  if (typeof document === "undefined" || !document.body) return false;
  const selection = document.getSelection();
  const previousRanges: Range[] = [];
  if (selection) {
    for (let index = 0; index < selection.rangeCount; index += 1) {
      previousRanges.push(selection.getRangeAt(index));
    }
  }
  // span + Range 选区在 iOS Safari 上比 textarea.select() 更可靠，也不会唤起键盘。
  const node = document.createElement("span");
  node.textContent = text;
  node.setAttribute("aria-hidden", "true");
  Object.assign(node.style, {
    position: "fixed",
    top: "0",
    left: "0",
    whiteSpace: "pre",
    userSelect: "text",
    webkitUserSelect: "text",
    opacity: "0",
    pointerEvents: "none",
  });
  document.body.appendChild(node);
  let copied = false;
  try {
    const range = document.createRange();
    range.selectNodeContents(node);
    selection?.removeAllRanges();
    selection?.addRange(range);
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  } finally {
    selection?.removeAllRanges();
    for (const range of previousRanges) selection?.addRange(range);
    node.remove();
  }
  return copied;
}
