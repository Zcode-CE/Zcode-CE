import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * `web-service.json` 的读写删（契约 §3）。
 *
 * 三条容易被写错的规则，都在这里收口：
 * 1. **只在探活通过之后写**（调用方负责时序），`pid` 是刚启动子进程的 pid；
 * 2. **原子替换**：临时文件 + `rename`。直接 `writeFile` 会让并发的读者看到半截 JSON ——
 *    `settingService` 里已记过同类事故（"setting.json 可能正被另一次 update 覆盖写入"）；
 * 3. **权限**：目录 0700、状态文件 0600。状态文件里含 `workspacePath` 与 `tokenFile` 绝对路径，
 *    不该被同机其他用户读到。
 */

const STATE_SCHEMA_VERSION = 1;

export interface WebServiceStateRecord {
  schemaVersion: number;
  pid: number;
  host: string;
  port: number;
  workspacePath?: string;
  tokenFile: string;
  staticRoot?: string;
  startedAt: number;
  entry: string;
}

/** 建目录（0700）。`recursive: true` 时 mode 只在新建时生效，所以显式 chmod 一次兜底。 */
export async function ensureWebServiceDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await chmod(dir, 0o700);
  } catch {
    // 目录权限收紧失败不阻断主流程（例如 Windows 上 chmod 语义不同），但不得静默改变语义：
    // 调用方在需要严格权限时用 assertWebServicePermissions 显式检查。
  }
}

export async function writeWebServiceState(
  path: string,
  record: Omit<WebServiceStateRecord, "schemaVersion">,
): Promise<void> {
  await ensureWebServiceDir(dirname(path));
  const payload: WebServiceStateRecord = { schemaVersion: STATE_SCHEMA_VERSION, ...record };
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  try {
    await chmod(temporaryPath, 0o600);
  } catch {
    // 同上：Windows 语义不同。真正的护栏是"以 0600 创建"，chmod 只是收紧兜底。
  }
  await rename(temporaryPath, path);
}

/**
 * 读状态文件。
 *
 * 不存在 ⇒ `undefined`（= `stopped`）；**损坏 ⇒ 也返回 `undefined`**（= 当成 stopped）：
 * 半截 JSON 或字段类型不对时无法据此判定接管，继续拿着它去 `process.kill` 会误杀无关进程。
 * 契约 §3 要求"陈旧条目允许覆盖"，所以这里不抛错、由上层按 stopped 处理并在覆盖时原子重建。
 */
export async function readWebServiceState(
  path: string,
): Promise<WebServiceStateRecord | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<WebServiceStateRecord>;
    if (
      parsed.schemaVersion !== STATE_SCHEMA_VERSION ||
      typeof parsed.pid !== "number" ||
      typeof parsed.host !== "string" ||
      typeof parsed.port !== "number" ||
      typeof parsed.tokenFile !== "string" ||
      typeof parsed.startedAt !== "number" ||
      typeof parsed.entry !== "string"
    ) {
      return undefined;
    }
    return parsed as WebServiceStateRecord;
  } catch {
    return undefined;
  }
}

/** 删状态文件（仅在"我们主动停止且子进程已退出"之后调用，契约 §3 规则 2）。 */
export async function removeWebServiceState(path: string): Promise<void> {
  await rm(path, { force: true });
}
