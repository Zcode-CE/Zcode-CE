/**
 * 飞书用户展示名的 TTL 缓存（R1）。
 *
 * 为什么独立成模块：缓存 key 含 userId（bot+user 维度），只 set 不 delete 时
 * 无界增长——飞书 Bot 长期运行、服务大量用户时内存缓慢增长，过期项也永不回收。
 * 收敛到这里后，写入路径统一在 set 之前清理已过期项（写入频率本身低：同一用户
 * 10 分钟内最多写一次，全量扫描代价可接受，不需要 LRU）。
 *
 * 注意 accessTokenCache 不在本模块：它的 key 只有 domain:app:credentialRef 三段，
 * 数量受 bot 配置限制且同 key 覆盖，天然有界。
 */
interface UserDisplayNameEntry {
  name: string | null;
  expiresAt: number;
}

const FEISHU_USER_DISPLAY_NAME_TTL_MS = 10 * 60_000;

const cache = new Map<string, UserDisplayNameEntry>();

/** 写入时顺带清过期项（R1）。 */
export function evictExpiredUserDisplayNameCacheEntries(now: number): void {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) {
      cache.delete(key);
    }
  }
}

export type CachedUserDisplayName = { hit: true; name: string | null } | { hit: false };

export function readCachedUserDisplayName(key: string): CachedUserDisplayName {
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { hit: true, name: cached.name };
  }
  return { hit: false };
}

export function writeUserDisplayName(key: string, name: string | null): void {
  evictExpiredUserDisplayNameCacheEntries(Date.now());
  cache.set(key, {
    name,
    expiresAt: Date.now() + FEISHU_USER_DISPLAY_NAME_TTL_MS,
  });
}

/** 缓存条目数（回归测试用：钉住「过期项被回收」这一资源性质）。 */
export function userDisplayNameCacheSize(): number {
  return cache.size;
}
