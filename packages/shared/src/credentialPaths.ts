/**
 * 凭据文件路径的唯一解析规则。
 *
 * 为什么单独成文件、而且只依赖 `node:path` / `node:os`：服务端的 `packages/services/src/paths.ts`
 * 会被打进浏览器产物（packages/ui 以值导入它，见 test/pathsBrowserBundleLoad.test.ts），
 * 不能 import `credential-security`（那里有 node:crypto、node:fs 与原生钥匙串）。
 * 而系统凭据库条目按凭据文件绝对路径命名：同一台机器上两个进程若用不同路径算 account，
 * 就会给同一个文件造两把密钥，一半密文永久解不开。所以规则必须只有一份，两侧都从这里取。
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** `{baseDir}/.zcode/v2/credentials.json`；`resolve()` 归一化（绝对化 + 折叠 `..`）。 */
export function resolveCredentialsFilePathIn(baseDir: string): string {
  return join(resolve(baseDir), ".zcode", "v2", "credentials.json");
}

/**
 * 无显式数据根时的规则：`ZCODE_DATA_BASE_DIR`（trim 后）> `HOME`（trim 后）> `homedir()`。
 * 桌面切过数据根时只有服务端知道新根，因此服务端用 `resolveCredentialsFilePathIn(getDataBaseDir())`。
 */
export function resolveCredentialsFilePath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const baseDir = env.ZCODE_DATA_BASE_DIR?.trim() || env.HOME?.trim() || homedir();
  return resolveCredentialsFilePathIn(baseDir);
}
