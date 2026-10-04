import assert from "node:assert/strict";
import test from "node:test";
import {
  evictExpiredUserDisplayNameCacheEntries,
  readCachedUserDisplayName,
  userDisplayNameCacheSize,
  writeUserDisplayName,
} from "../src/bots/providers/feishuDisplayNameCache.js";

/**
 * 飞书 displayName 缓存的过期回收（R1）。
 *
 * 背景：缓存 key 含 userId（bot+user 维度），原先只 set 不 delete——飞书 Bot
 * 长期运行、服务大量用户时内存缓慢增长，过期项永不回收。修复后写入路径统一
 * 先清过期项。缓存的「读」行为（命中返回名字 / 未命中去查 API）不变。
 *
 * 运行：cd packages/services && node --import tsx --test test/feishuDisplayNameCache.test.ts
 */

/** 先清空到已知状态，避免与同进程其它用例的模块级状态互相污染。 */
function clearCache(): void {
  evictExpiredUserDisplayNameCacheEntries(Number.MAX_SAFE_INTEGER);
  assert.equal(userDisplayNameCacheSize(), 0, "前置：缓存已清空");
}

test("写入新条目时，已过期的条目被一并清除（R1 的核心：不再只增不删）", () => {
  clearCache();
  writeUserDisplayName("bot:app:cred:user-a", "Alice");
  assert.equal(userDisplayNameCacheSize(), 1);
  // 把时间推进到 TTL（10 分钟）之后：现有条目全部过期
  evictExpiredUserDisplayNameCacheEntries(Date.now() + 11 * 60_000);
  assert.equal(userDisplayNameCacheSize(), 0, "过期条目必须被回收");
});

test("未过期的条目不被误清（写入另一个用户时保留仍在 TTL 内的项）", () => {
  clearCache();
  writeUserDisplayName("bot:app:cred:user-fresh", "Bob");
  writeUserDisplayName("bot:app:cred:user-fresh-2", "Carol");
  // 不推进时间（两条都在 TTL 内）
  assert.equal(userDisplayNameCacheSize(), 2, "TTL 内的条目必须保留");
});

test("读语义不变：命中返回缓存名字（含 null 名字的命中，避免重复查 API）", () => {
  clearCache();
  writeUserDisplayName("bot:app:cred:user-null", null);
  const hitNull = readCachedUserDisplayName("bot:app:cred:user-null");
  assert.deepEqual(
    hitNull,
    { hit: true, name: null },
    "无展示名的用户也命中，不得重复请求 contact API",
  );
  writeUserDisplayName("bot:app:cred:user-named", "Dave");
  assert.deepEqual(readCachedUserDisplayName("bot:app:cred:user-named"), {
    hit: true,
    name: "Dave",
  });
});

test("读语义不变：过期后未命中（下次读取会重新查询）", () => {
  clearCache();
  writeUserDisplayName("bot:app:cred:user-stale", "Eve");
  evictExpiredUserDisplayNameCacheEntries(Date.now() + 11 * 60_000);
  assert.deepEqual(
    readCachedUserDisplayName("bot:app:cred:user-stale"),
    { hit: false },
    "过期项回收后读取必须未命中",
  );
});
