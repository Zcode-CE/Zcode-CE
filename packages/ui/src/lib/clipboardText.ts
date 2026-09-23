/**
 * 写入纯文本到剪贴板。
 *
 * ⚠️ 本文件是 packages/ui 里**唯一**允许调用 `document.execCommand("copy")` 的地方，请勿扩散；
 * 也不要把回退路径当成死代码"清理"掉（test/clipboardText.test.ts 锁定了它）。
 *
 * 为什么异步 Clipboard API 覆盖不了这个场景：`navigator.clipboard` 只暴露在安全上下文里；
 * 当 `window.isSecureContext === false`（例如手机经 http://<局域网 / tailnet IP> 打开 Web 远控）时，
 * 浏览器直接不提供 `navigator.clipboard`（是 undefined，而不是一个会被拒绝的 Promise），
 * 没有任何权限提示或降级可走。已废弃的 `execCommand("copy")` 不受安全上下文限制，只要求在用户手势内调用，
 * 是这种情况下唯一可用的写剪贴板手段。
 *
 * Why the async Clipboard API can't cover this: `navigator.clipboard` is only exposed in secure
 * contexts. When `isSecureContext === false` (e.g. the web remote UI opened from a phone over
 * plain http://<LAN or tailnet IP>) it is `undefined`, so there is nothing to call or await.
 * The deprecated `execCommand("copy")` is not gated on secure contexts (only on a user gesture),
 * which makes it the only working path there. Keep it confined to this helper.
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
