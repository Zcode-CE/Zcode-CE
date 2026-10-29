/**
 * 工作区附加目录（上游 X16）在 AppSettings 侧的存放、归一与下发片段。
 *
 * 为什么放在 AppSettings 而不是工作区注册表：注册表是索引（服务端枚举、只读、多客户端逐条一致），
 * 把可变配置塞进索引表会让「枚举语义」和「配置语义」互相污染。附加目录是用户对某个项目
 * 「额外带上哪些目录」的编辑型偏好，归属客户端设置。决策与取舍见
 * `docs/development/project-model.md` §3A。
 *
 * 键 = workspaceKey（`workspaceIdentity?.trim() || workspacePath`，全仓统一的身份口径）。
 * 缺席与空表都表示「该工作区没有附加目录」——因此归一化在「没有有效项」时返回 undefined，
 * 而不是给每份老配置写进一份空表。
 */

/** 每个工作区可配置的附加目录上限；与 v4 createSession 协议 schema 的上限同值。 */
export const MAX_WORKSPACE_ADDITIONAL_DIRECTORIES = 256;

/** workspaceKey → 该工作区的附加目录（绝对路径，已归一：去空白、去空串、去重、截断）。 */
export type WorkspaceAdditionalDirectories = Record<string, string[]>;

/**
 * 单个工作区的目录列表归一：去首尾空白、丢弃空串、按出现顺序去重、截断到上限。
 * 读盘（schema 归一）与设置页保存共用同一份判定，避免两处规则分叉。
 */
export function normalizeAdditionalDirectoryList(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
    if (normalized.length >= MAX_WORKSPACE_ADDITIONAL_DIRECTORIES) break;
  }
  return normalized;
}

/**
 * 整表归一：丢弃空键与空列表。整表没有有效项时返回 undefined ——
 * 「字段缺席」与「空表」等价，返回 undefined 才不会给老配置伪造出一份空表。
 */
export function normalizeWorkspaceAdditionalDirectories(
  value: Readonly<Record<string, readonly string[]>>,
): WorkspaceAdditionalDirectories | undefined {
  const normalized: WorkspaceAdditionalDirectories = {};
  for (const [rawKey, directories] of Object.entries(value)) {
    const key = rawKey.trim();
    if (key.length === 0) continue;
    const list = normalizeAdditionalDirectoryList(directories);
    if (list.length === 0) continue;
    normalized[key] = list;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/** 取某工作区的附加目录；未配置 = 空数组（不区分「没这个键」与「这个键是空表」）。 */
export function resolveWorkspaceAdditionalDirectories(
  map: Readonly<Record<string, readonly string[]>> | undefined,
  workspaceKey: string,
): string[] {
  const list = map?.[workspaceKey.trim()];
  return list ? [...list] : [];
}

/**
 * 设置页保存用的单键补丁（不是整表）。
 *
 * 为什么只提交被改的键：设置更新走 RPC 的浅合并，但记录型字段会被整块替换。若把整表发回去，
 * 两个客户端同时编辑不同工作区时，后写方会拿自己读到的旧表覆盖对方刚改的键。
 * 单键补丁 + 服务端按键合并（mergeWorkspaceAdditionalDirectories）让两个编辑互不覆盖。
 *
 * 空列表是显式的「删除这个键」信号：服务端看得到它，合并时才会真正移除；
 * 若在这里就丢掉空列表，删除动作会退化成「没有改动」。
 */
export function buildWorkspaceAdditionalDirectoriesPatch(
  workspaceKey: string,
  directories: readonly string[],
): WorkspaceAdditionalDirectories {
  const key = workspaceKey.trim();
  if (key.length === 0) return {};
  return { [key]: normalizeAdditionalDirectoryList(directories) };
}

/**
 * 服务端合并：在当前表上按 key 应用补丁；补丁里的空列表表示删除该键。
 * 结果整表为空时返回 undefined（与「字段缺席」等价，不制造空对象）。
 */
export function mergeWorkspaceAdditionalDirectories(
  current: Readonly<Record<string, readonly string[]>> | undefined,
  patch: Readonly<Record<string, readonly string[]>>,
): WorkspaceAdditionalDirectories | undefined {
  const next: Record<string, readonly string[]> = { ...current };
  for (const [rawKey, directories] of Object.entries(patch)) {
    const key = rawKey.trim();
    if (key.length === 0) continue;
    const list = normalizeAdditionalDirectoryList(directories);
    if (list.length === 0) {
      delete next[key];
    } else {
      next[key] = list;
    }
  }
  return normalizeWorkspaceAdditionalDirectories(next);
}

/**
 * v4 `createSession` payload 的附加目录片段。
 *
 * 空目录时返回空对象而不是 `{ additionalDirectories: [] }`：协议里「缺席」就是「无附加目录」，
 * 写一个空数组只会让 wire 上多一条无意义字段（也与 CLI 侧「缺席即无」的口径不一致）。
 */
export function buildAdditionalDirectoriesPayload(directories: readonly string[]): {
  additionalDirectories?: string[];
} {
  return directories.length > 0 ? { additionalDirectories: [...directories] } : {};
}
