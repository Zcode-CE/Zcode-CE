import { existsSync } from "node:fs";
import type { ServerLayout } from "./paths.js";

/**
 * 已安装判据：发布包安装时写入的 ownership marker（`install.json`）。
 *
 * 为什么不用 `uninstalled.json`：那是卸载后残留的一次性标记，重装时不一定被清掉，
 * 用它做判据会把「已重装」误报成「未安装」。install.json 在卸载流程的 allowlist 里被删除，
 * 因此它在场等价于「有安装记录」，也是桌面探测「未安装 / 已安装未运行 / 运行中」的最左一档。
 */
export function isServerInstalled(layout: Pick<ServerLayout, "installFile">): boolean {
  return existsSync(layout.installFile);
}
