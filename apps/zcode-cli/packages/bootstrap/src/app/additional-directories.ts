import { isAbsolute, resolve } from "node:path";

/** 与 shared 协议 schema 的 `additionalDirectories` 上限同值；wire 与运行时共用同一不变量。 */
export const ADDITIONAL_DIRECTORIES_MAX = 256;

/**
 * 归一 Host 下发的附加目录（X16）。
 *
 * 为什么在 bootstrap 归一而不是只在协议层：wire 只保证「非空字符串数组、≤256」，
 * 绝对性与去重是运行时语义——环境 prompt 要让模型读到可直接使用的路径，重复项只是噪声。
 * 相对路径按 `workingDirectory` 解析（本次运行的 cwd，与命令/技能根的解析基点一致）。
 * 附加目录不参与 workspace 身份、权限边界与文件执行根，这里也不写回任何 workspace 字段。
 */
export function normalizeAdditionalDirectories(
  directories: readonly string[] | undefined,
  workingDirectory: string,
): string[] {
  if (!directories?.length) return [];
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const directory of directories) {
    const trimmed = directory.trim();
    if (!trimmed) continue;
    const absolute = isAbsolute(trimmed) ? trimmed : resolve(workingDirectory, trimmed);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    normalized.push(absolute);
    if (normalized.length >= ADDITIONAL_DIRECTORIES_MAX) break;
  }
  return normalized;
}
