/**
 * 工作区「项目投影」：把四处既有事实读成一份视图，不新增表。
 *
 * 事实来源（见 docs/development/project-model.md §1.5/§3B′）：
 * - 主根 = workspacePath；
 * - 附加根 = AppSettings.workspaceAdditionalDirectories（X16，已落地）；
 * - 展示名 = AppSettings.workspaceDisplayNames（仅本机展示，不改身份/路径）；
 * - 分组/归档 = 既有 task_groups（不在本模块）。
 *
 * 纯函数、跨端可用（shared 不能依赖 node:path）：basename 用两种分隔符自行切分。
 */

export const WORKSPACE_DISPLAY_NAME_MAX_LENGTH = 120;

export interface WorkspaceProjectView {
  workspaceKey: string;
  /** 主根：会话/命令执行的真实根，永远等于工作区路径。 */
  primaryRoot: string;
  /** 附加根：模型可见范围与技能/命令根的扩展，不含主根。 */
  additionalRoots: string[];
  /** 展示名：用户覆盖 > 路径末段；不参与任何身份判定。 */
  displayName: string;
  displayNameSource: "override" | "basename";
}

export type WorkspaceDisplayNames = Record<string, string>;

/** 路径末段（兼容 POSIX 与 Windows 分隔符；去尾部分隔符）。 */
export function workspacePathBasename(workspacePath: string): string {
  const trimmed = workspacePath.replace(/[\\/]+$/u, "");
  const segments = trimmed.split(/[\\/]+/u);
  return segments[segments.length - 1] || trimmed || workspacePath;
}

/** 展示名归一：去首尾空白、压缩控制字符、截断；空值表示「没有覆盖」。 */
export function normalizeWorkspaceDisplayName(
  value: string | null | undefined,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .trim()
    .slice(0, WORKSPACE_DISPLAY_NAME_MAX_LENGTH);
  return normalized.length > 0 ? normalized : undefined;
}

/** 整表归一：丢弃空键与空值；无有效项返回 undefined（与「字段缺席」等价）。 */
export function normalizeWorkspaceDisplayNames(
  value: Readonly<Record<string, string>>,
): WorkspaceDisplayNames | undefined {
  const next: WorkspaceDisplayNames = {};
  for (const [rawKey, rawName] of Object.entries(value)) {
    const key = rawKey.trim();
    if (key.length === 0) continue;
    const name = normalizeWorkspaceDisplayName(rawName);
    if (name) next[key] = name;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/** 设置页保存用的单键补丁；空值表示删除该键（与附加目录同一套语义）。 */
export function buildWorkspaceDisplayNamePatch(
  workspaceKey: string,
  displayName: string | null | undefined,
): WorkspaceDisplayNames {
  const key = workspaceKey.trim();
  if (key.length === 0) return {};
  return { [key]: normalizeWorkspaceDisplayName(displayName) ?? "" };
}

/**
 * 服务端按 key 合并：补丁里的空串表示删除该键；整表为空时返回 undefined。
 * 与 workspaceAdditionalDirectories 的合并语义一致，避免跨客户端互相覆盖。
 */
export function mergeWorkspaceDisplayNames(
  current: Readonly<Record<string, string>> | undefined,
  patch: Readonly<Record<string, string>>,
): WorkspaceDisplayNames | undefined {
  const next: Record<string, string> = { ...current };
  for (const [rawKey, rawName] of Object.entries(patch)) {
    const key = rawKey.trim();
    if (key.length === 0) continue;
    const name = normalizeWorkspaceDisplayName(rawName);
    if (name) next[key] = name;
    else delete next[key];
  }
  return normalizeWorkspaceDisplayNames(next);
}

/** 组合出投影；附加根去重、去主根、按出现顺序保留。 */
export function resolveWorkspaceProjectView(input: {
  workspaceKey: string;
  workspacePath: string;
  additionalRoots?: readonly string[];
  displayNames?: Readonly<Record<string, string>>;
}): WorkspaceProjectView {
  const key = input.workspaceKey.trim() || input.workspacePath;
  const seen = new Set<string>([input.workspacePath]);
  const additionalRoots: string[] = [];
  for (const root of input.additionalRoots ?? []) {
    const trimmed = root.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    additionalRoots.push(trimmed);
  }
  const override = normalizeWorkspaceDisplayName(input.displayNames?.[key]);
  return {
    workspaceKey: key,
    primaryRoot: input.workspacePath,
    additionalRoots,
    displayName: override ?? workspacePathBasename(input.workspacePath),
    displayNameSource: override ? "override" : "basename",
  };
}
