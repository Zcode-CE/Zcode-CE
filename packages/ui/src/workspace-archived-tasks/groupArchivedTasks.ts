/**
 * 归档任务按工作区分组（W4 批次 1）。
 *
 * 归档列表是跨工作区视图：分组键与标签由调用方给出（UI 用 workspaceKey/展示名），
 * 保持任务原始顺序；同一工作区只出现一个组，组顺序按首次出现。
 */
export interface ArchivedTaskWorkspaceGroup<T> {
  key: string;
  label: string;
  items: T[];
}

export function groupArchivedTasksByWorkspace<T>(
  tasks: readonly T[],
  keyOf: (task: T) => string,
  labelOf: (task: T, key: string) => string,
): ArchivedTaskWorkspaceGroup<T>[] {
  const groups: ArchivedTaskWorkspaceGroup<T>[] = [];
  const indexByKey = new Map<string, number>();
  for (const task of tasks) {
    const key = keyOf(task);
    let index = indexByKey.get(key);
    if (index === undefined) {
      index = groups.length;
      indexByKey.set(key, index);
      groups.push({ key, label: labelOf(task, key), items: [] });
    }
    groups[index]?.items.push(task);
  }
  return groups;
}
