import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { backupCorruptFile } from "@zcode/shared/node";
import {
  resolveCredentialsFilePath,
  resolveCredentialsFilePathIn,
} from "@zcode/shared/credential-security";

/**
 * CLI 侧共享凭据容器（credentials.json）的路径解析与整文件读取。
 *
 * 与 store 分开是因为失败语义不同：路径一旦与 Host 分叉就会给同一文件造两把密钥，
 * 容器损坏必须保留现场后再失败；store 只负责键值契约与变更通知。
 */

/** 路径来源：store 的选项继承这里，`cipher` 之类与路径无关的选项不属于这一层。 */
export interface SharedZCodeCredentialsPathOptions {
  baseDir?: string;
  env?: Record<string, string | undefined>;
  filePath?: string;
}

/**
 * 凭据文件路径：与 Host 的服务端解析共用同一条规则（`ZCODE_DATA_BASE_DIR` trim 后 > `HOME` >
 * `homedir()`）。系统密钥条目按该绝对路径命名，两侧路径一旦分叉就会给同一文件造两把密钥，
 * 一半密文永久解不开。
 */
export function resolveSharedZCodeCredentialsPath(
  options: SharedZCodeCredentialsPathOptions = {},
): string {
  if (options.filePath) {
    return resolveUserPath(options.filePath);
  }
  if (options.baseDir !== undefined) {
    return resolveCredentialsFilePathIn(resolveUserPath(options.baseDir));
  }
  return resolveCredentialsFilePath(options.env ?? process.env);
}

/** 整文件读取（锁外与锁内共用）；损坏时先备份再抛错，绝不把损坏容器当成空 store。 */
export async function readRawCredentialRecord(filePath: string): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return {};
    }
    throw new Error(`Unable to read shared ZCode credentials: ${filePath}`, { cause: error });
  }

  try {
    return parseCredentialRecord(JSON.parse(raw));
  } catch (error) {
    // 损坏的凭据文件若被当成空对象继续保存，会一次性抹掉其他进程的全部凭据。
    // 先保留现场再失败，调用方必须显式处理恢复，不能静默覆盖。
    const backupPath = await backupCorruptFile(filePath).catch(() => undefined);
    const evidence = backupPath ? ` Backup: ${backupPath}` : "";
    throw new Error(`Shared ZCode credentials are corrupt: ${filePath}.${evidence}`, {
      cause: error,
    });
  }
}

function parseCredentialRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    throw new Error("Credential record must be an object");
  }

  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new Error(`Credential record value must be a string: ${key}`);
    }
    result[key] = entry;
  }
  return result;
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function resolveUserPath(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }
  return resolve(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
