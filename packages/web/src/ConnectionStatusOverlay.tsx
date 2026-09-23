import { useEffect, useState } from "react";
import { buildUnauthorizedMessage } from "./authProbe.js";

/**
 * 运行期连接状态覆盖层（仅网页端使用）。
 *
 * 三种真实状态，绝不混说：
 * - reconnecting：连接断了正在退避重连（网络层问题）；
 * - failed：自动重连预算用尽，给手动重试；
 * - unauthorized：服务在运行、但拒绝我们（401/403）—— 这是**授权问题**，不再显示
 *   「正在重连（第 N 次）」，而是给出「怎么拿到带 token 的链接」的可照做文案，且不自动重试
 *   （401 不会自愈）。文案与启动期未授权屏共用 authProbe.buildUnauthorizedMessage。
 *
 * 文案按 navigator.language 二选一，沿用 web 入口既有做法（WebBootstrapErrorScreen），
 * 以避免为此改动 packages/ui 的 i18n 资源。
 */
export type ConnectionOverlayPhase =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed"
  | "unauthorized";

export function ConnectionStatusOverlay({
  phase,
  attempt,
  onRetry,
}: {
  phase: ConnectionOverlayPhase;
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

  const unauthorized = phase === "unauthorized";
  const failed = phase === "failed";
  const title = unauthorized
    ? isChinese
      ? "未授权：这台服务器需要访问令牌"
      : "Unauthorized: this server requires an access token"
    : failed
      ? isChinese
        ? "无法连接服务器"
        : "Cannot reach the server"
      : isChinese
        ? "连接已中断，正在重连"
        : "Connection lost, reconnecting";
  const detail = unauthorized
    ? buildUnauthorizedMessage(isChinese, globalThis.location?.origin ?? "")
    : failed
      ? isChinese
        ? "自动重连已停止。请确认服务仍在运行，然后重试。"
        : "Automatic reconnection stopped. Check that the server is still running, then retry."
      : isChinese
        ? "正在尝试第 " + (attempt + 1) + " 次。恢复后本页会自动继续，无需刷新。"
        : "Attempt " +
          (attempt + 1) +
          " in progress. This page resumes automatically once the connection is back.";

  return (
    // 覆盖层承担两点职责（缺一就会变成「看起来可用、点了没反应」）：
    // 1) 状态条本身：断线/失败/未授权三种真实状态，文案不混说；
    // 2) 阻断指针：整层铺满视口（半透明底 + 不透明状态条），让被覆盖的应用确实不可交互。
    //    旧实现只有 56px 的顶部条：应用头部按钮（y=14..42）被它盖住点不到，而其余区域
    //    照旧可点却是死交互 —— 手机用户会以为是自己点错（task-22 审计 §2.5 实测）。
    // 未授权态「不渲染应用内容」由 WebAppRoot 的 session && !unauthorized 保证，与本层无关。
    <div
      data-testid="web-connection-overlay"
      data-connection-phase={phase}
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2147483000,
        background: "rgb(0 0 0 / 0.35)",
      }}
    >
      <div
        style={{
          display: "flex",
          // 窄屏（390）下标题与详情必须能换行：并排时标题被挤成两行、详情只剩一条缝。
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "center",
          columnGap: "0.75rem",
          rowGap: "0.35rem",
          padding: "0.6rem 1rem",
          background: unauthorized
            ? "rgb(120 53 15 / 0.95)"
            : failed
              ? "rgb(127 29 29 / 0.95)"
              : "rgb(23 23 23 / 0.92)",
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
            background: unauthorized ? "#fcd34d" : failed ? "#fca5a5" : "#fbbf24",
          }}
        />
        <span style={{ fontWeight: 500 }}>{title}</span>
        <span style={{ opacity: 0.85 }}>{detail}</span>
        {unauthorized || failed ? (
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
    </div>
  );
}
