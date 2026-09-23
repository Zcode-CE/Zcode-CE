import { useEffect, useState } from "react";

/**
 * 运行期连接状态覆盖层（仅网页端使用）。
 *
 * 为什么需要它：在 task-16 之前，运行期断线（手机锁屏、切后台、Wi-Fi 切换、服务重启）
 * 没有任何提示 —— 页面看着正常但完全不动，只能手动刷新。这里把「正在重连/无法连接」
 * 明确画出来，并在放弃自动重试后给一个可点的重试入口。
 *
 * 文案按 `navigator.language` 二选一，沿用 web 入口既有的做法（`WebBootstrapErrorScreen`），
 * 以避免为此改动 packages/ui 的 i18n 资源（那是 PR #1 那条线的范围）。
 */
export function ConnectionStatusOverlay({
  phase,
  attempt,
  onRetry,
}: {
  phase: "connecting" | "connected" | "reconnecting" | "failed";
  attempt: number;
  onRetry: () => void;
}) {
  const [isChinese, setIsChinese] = useState(false);
  useEffect(() => {
    setIsChinese(/^zh\b/i.test(globalThis.navigator?.language ?? ""));
  }, []);

  if (phase === "connected") {
    return null;
  }

  const failed = phase === "failed";
  const title = failed
    ? isChinese
      ? "无法连接服务器"
      : "Cannot reach the server"
    : isChinese
      ? "连接已中断，正在重连"
      : "Connection lost, reconnecting";
  const detail = failed
    ? isChinese
      ? "自动重连已停止。请确认服务仍在运行，然后重试。"
      : "Automatic reconnection stopped. Check that the server is still running, then retry."
    : isChinese
      ? "正在尝试第 " + (attempt + 1) + " 次。恢复后本页会自动继续，无需刷新。"
      : "Attempt " +
        (attempt + 1) +
        " in progress. This page resumes automatically once the connection is back.";

  return (
    <div
      data-testid="web-connection-overlay"
      data-connection-phase={phase}
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 2147483000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "0.75rem",
        padding: "0.6rem 1rem",
        background: failed ? "rgb(127 29 29 / 0.95)" : "rgb(23 23 23 / 0.92)",
        color: "#fafafa",
        fontSize: "13px",
        lineHeight: 1.4,
        boxShadow: "0 1px 0 rgb(255 255 255 / 0.08)",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: "0.5rem",
          height: "0.5rem",
          borderRadius: "9999px",
          background: failed ? "#fca5a5" : "#fbbf24",
        }}
      />
      <span style={{ fontWeight: 500 }}>{title}</span>
      <span style={{ opacity: 0.85 }}>{detail}</span>
      {failed ? (
        <button
          type="button"
          data-testid="web-connection-retry"
          onClick={onRetry}
          style={{
            marginLeft: "0.25rem",
            border: "1px solid rgb(255 255 255 / 0.35)",
            borderRadius: "0.375rem",
            background: "transparent",
            color: "inherit",
            fontSize: "12px",
            padding: "0.2rem 0.6rem",
            cursor: "pointer",
          }}
        >
          {isChinese ? "重试" : "Retry"}
        </button>
      ) : null}
    </div>
  );
}
