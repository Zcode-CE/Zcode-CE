import { getAppConfigDir } from "@zcode/services/node";
import { join } from "node:path";

/**
 * 本地 Web 服务（远程控制）在磁盘上的**唯一路径所有者**。
 *
 * 契约见 `.reverse/44-remote-ui/WEB-SERVICE-CONTRACT.md` §3。
 * **不得自拼 `~/.zcode`**：`getAppConfigDir()` 是数据目录的唯一所有者
 * （自定义 dataBaseDir 也要跟着走），与 `packages/server/src/entry-http.ts:1` 同一来源。
 */

/** `<getAppConfigDir()>/web-service`（目录权限 0700）。 */
export function resolveWebServiceDir(): string {
  return join(getAppConfigDir(), "web-service");
}

/** 状态文件 `web-service.json`（0600）：接管与状态的唯一持久依据。 */
export function resolveWebServiceStatePath(): string {
  return join(resolveWebServiceDir(), "web-service.json");
}

/** 令牌文件（0600，跨重启复用）：`ZCODE_SERVER_AUTH_TOKENS_FILE` 的真实取值。 */
export function resolveWebServiceTokenPath(): string {
  return join(resolveWebServiceDir(), "token");
}
