import { randomBytes } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ensureWebServiceDir } from "./state.js";

/**
 * 令牌文件的所有者（契约 §2/§6）。
 *
 * **这是唯一被服务端接受的传递方式**：`ZCODE_SERVER_AUTH_TOKENS_FILE` 指向本文件
 * （`packages/server/src/entry-http.ts:68`）；明文 env `ZCODE_SERVER_AUTH_TOKEN` **禁用** ——
 * 它会出现在 `/proc/<pid>/environ`，同机任何用户都能读。
 *
 * 文件格式由 `packages/server/src/authToken.ts` 定义：每行 `<token>` 或 `<token> <标签>`，
 * `#` 开头与空行忽略。这里写的是**裸令牌一行**（标签留空：标签会进服务端日志，我们没有需要标的设备）。
 *
 * 权限 0600、目录 0700；文件**跨重启复用**（契约 §3 规则 4，轮换在本切片延后）。
 * `ensure` 只在文件不存在时生成 —— 覆盖会让已扫码连接的设备立刻失效。
 */

export const WEB_SERVICE_TOKEN_BYTES = 32;

/** 生成令牌：32 字节 CSPRNG，base64url（无 `+/`，可直接进 URL query 与二维码）。 */
export function generateWebServiceToken(): string {
  return randomBytes(WEB_SERVICE_TOKEN_BYTES).toString("base64url");
}

export async function readWebServiceToken(path: string): Promise<string | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    // 与服务端解析口径一致：取第一条非注释非空行的第一个字段。
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
      const token = trimmed.split(/\s+/)[0];
      if (token) return token;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** 确保令牌文件存在（不存在则生成），返回当前令牌。读不到内容时**重新生成**并覆盖。 */
export async function ensureWebServiceToken(path: string): Promise<string> {
  const existing = await readWebServiceToken(path);
  if (existing) return existing;

  await ensureWebServiceDir(dirname(path));
  const token = generateWebServiceToken();
  await writeFile(path, `${token}\n`, { mode: 0o600 });
  try {
    await chmod(path, 0o600);
  } catch {
    // Windows 语义不同；护栏是"以 0600 创建"。
  }
  return token;
}
