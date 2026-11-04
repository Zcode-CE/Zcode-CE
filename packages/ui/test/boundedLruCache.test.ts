import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createBoundedLruCache } from "../src/lib/boundedLruCache.js";

/**
 * 内存快照缓存的上限（审计 A8）。
 *
 * 回归形态：snapshot 缓存以「service + 请求参数」为键，键随用户看过的任务增长；
 * 持久化侧有 20 条 / 2 MB 策略，内存侧却没有上限 ⇒ renderer 堆只增不减。
 * 这里钉住 LRU 语义：超限淘汰最久未使用的项，命中会刷新顺序，
 * 因而「用户正看着的那个任务」不会被随后打开的新任务挤掉。
 */

test("超过上限淘汰最旧的一项，size 收敛到上限", () => {
  const cache = createBoundedLruCache<string, number>(3);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);
  cache.set("d", 4);
  assert.equal(cache.size, 3);
  assert.equal(cache.get("a"), undefined, "最早写入的应被淘汰");
  assert.deepEqual([...cache.keys()], ["b", "c", "d"]);
});

test("命中刷新顺序：最近用过的不会被下一次写入淘汰", () => {
  const cache = createBoundedLruCache<string, number>(3);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);
  // 「a」被重新读到，成为最近使用；最旧的变成 b。
  assert.equal(cache.get("a"), 1);
  cache.set("d", 4);
  assert.equal(cache.get("b"), undefined, "b 才是此刻最久未使用的");
  assert.equal(cache.get("a"), 1);
  assert.equal(cache.get("c"), 3);
  assert.equal(cache.get("d"), 4);
});

test("重写已有键同样刷新顺序，不会重复占位", () => {
  const cache = createBoundedLruCache<string, number>(2);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("a", 11);
  assert.equal(cache.size, 2);
  cache.set("c", 3);
  // a 刚被重写，仍在使用；b 被淘汰。
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), 11);
  assert.equal(cache.get("c"), 3);
});

test("当前正在查看的任务不会被随后打开的任务挤掉", () => {
  const cache = createBoundedLruCache<string, string>(4);
  cache.set("old-1", "1");
  cache.set("old-2", "2");
  cache.set("current", "任务正文");
  // 用户切走去看别的任务：每次读取都会刷新 current 的顺序。
  for (const task of ["n1", "n2", "n3", "n4"]) {
    cache.set(task, task);
    assert.equal(cache.get("current"), "任务正文");
  }
  assert.equal(cache.get("current"), "任务正文");
  assert.equal(cache.size, 4);
  assert.equal(cache.get("old-1"), undefined);
});

test("上限必须是正整数", () => {
  assert.throws(() => createBoundedLruCache(0));
  assert.throws(() => createBoundedLruCache(-1));
  assert.throws(() => createBoundedLruCache(1.5));
});

test("任务快照缓存接上同一上限（避免内存与持久化策略不对称）", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(resolve(here, "../src/hooks/useZCodeTaskService.ts"), "utf8");
  assert.match(source, /createBoundedLruCache</);
  assert.match(source, /SNAPSHOT_MEMORY_CACHE_MAX_ENTRIES = SNAPSHOT_CACHE_MAX_ENTRIES/);
});
