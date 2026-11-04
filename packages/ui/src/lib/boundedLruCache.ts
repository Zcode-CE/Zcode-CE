/**
 * 有界 LRU 缓存：按插入顺序淘汰最久未使用的一项。
 *
 * 为什么需要：renderer 里的 snapshot 缓存以「service + 请求参数」为键，键会随着用户看过的
 * 任务不断增长；没有上限时堆占用只增不减（与持久化侧 20 条 / 2 MB 的策略不对称）。
 * 命中与写入都刷新顺序，保证当前正在看的那条不会被刚淘汰掉。
 */
export interface BoundedLruCache<K, V> {
  readonly size: number;
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  has(key: K): boolean;
  delete(key: K): boolean;
  clear(): void;
  keys(): IterableIterator<K>;
}

export function createBoundedLruCache<K, V>(maxEntries: number): BoundedLruCache<K, V> {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new Error(`maxEntries must be a positive integer, got ${maxEntries}`);
  }
  const entries = new Map<K, V>();

  /** 命中即移到队尾：最近用过的不该先被淘汰。 */
  const touch = (key: K) => {
    const value = entries.get(key);
    if (value === undefined) return;
    entries.delete(key);
    entries.set(key, value);
  };

  return {
    get size() {
      return entries.size;
    },
    get(key) {
      if (!entries.has(key)) return undefined;
      touch(key);
      return entries.get(key);
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    },
    has(key) {
      return entries.has(key);
    },
    delete(key) {
      return entries.delete(key);
    },
    clear() {
      entries.clear();
    },
    keys() {
      return entries.keys();
    },
  };
}
