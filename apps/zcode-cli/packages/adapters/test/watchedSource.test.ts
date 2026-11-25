import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Stats } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Logger } from "@zcode/contracts";
import type { WatchedLoad } from "../src/watch/contract.js";
import type { WatchDependencies, WatchOptions } from "../src/watch/deps.js";
import {
  WATCHED_SOURCE_DEBOUNCE_MS,
  WATCH_BIND_TIMEOUT_MS,
  createRefcountedRegistry,
  createWatchedEntry,
  type WatchedEntry,
} from "../src/watch/watched-source.js";

/**
 * 通用监听原语（watch/watched-source.ts）的行为契约。
 *
 * 为什么测这一层：上游 4.0.0 把这个原语当作「会话启动长时间卡住」的根因修复点 —— 修复前
 * 一次 bind 对锚点 stat 和等 watcher ready/error 都没有上限，网盘或 Windows 网络共享上
 * stat 挂住、watcher 既不就绪也不报错时，条目创建与 flush 一直等，新会话创建被拖住。
 * 桩测试要盯的就是三个可观察结果：截止时间到点即降级（不无限等待）、连续文件事件只读一次盘、
 * dispose 之后不再读盘也不再回调。这三条任一退化成「没有截止」或「逐事件读盘」，
 * 用户侧表现分别是会话启动卡住和一次保存反复读盘，都不会报错。
 *
 * 为什么注入系统边界（第二个参数 deps）：stat 挂住与 watcher 永不就绪只由网络盘触发，
 * 真实磁盘上无法复现；node:test 的模块 mock 需要 --experimental-test-module-mocks，
 * 而测试入口（scripts/run-tests.mjs）不带该参数。所以原语把 stat/watch 收敛成可注入的边界，
 * 生产调用不传，仍走真实实现。
 *
 * 修复前必红的对照：删掉 bindTimeoutMs 与截止时间相关分支后，第一、二个用例会一直等到
 * SETTLE_LIMIT_MS 超时；把 scheduleAfterQuiet 改成直接 schedule 后，第五个用例读到 5 次。
 *
 * 运行：cd apps/zcode-cli/packages/adapters && mise exec node@24.14.0 -- node --import tsx --test test/watchedSource.test.ts
 */

const LABEL = "MCP configuration";
const BIND_TIMEOUT_MESSAGE = `${LABEL} watcher bind timed out`;
const FAILURE_MESSAGE = `${LABEL} watcher failed`;
const STOPPED_MESSAGE = `${LABEL} watcher stopped after repeated failures`;
const CONFIG_NAME = "config.json";
/** 注入的短截止时间：用例快，又能区分「等满截止」与「根本没等」。 */
const SHORT_BIND_TIMEOUT_MS = 120;
/** 判定用的有限等待；修复前条目创建不会返回，不能让整个测试进程陪等。 */
const SETTLE_LIMIT_MS = 5_000;

type Loaded = WatchedLoad & { value: string };

interface Fixture {
  root: string;
  config: string;
  dispose(): Promise<void>;
}

/** 系统边界的替身：记录 stat 调用与创建的 watcher，按用例决定它们怎么响应。 */
interface FakeSystem {
  deps: WatchDependencies;
  watchers: RecordingWatcher[];
  statCalls: string[];
}

/** 假 watcher：只实现原语用到的事件（all / raw / ready / error）与 close。 */
class RecordingWatcher extends EventEmitter {
  closed = false;

  constructor(
    readonly anchor: string,
    readonly options: WatchOptions,
  ) {
    super();
  }

  close(): void {
    this.closed = true;
  }
}

async function fixtureOf(prefix: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const config = join(root, CONFIG_NAME);
  await writeFile(config, "v1");
  return { root, config, dispose: () => rm(root, { recursive: true, force: true }) };
}

/** 每次读盘都按当前磁盘内容重新登记依赖文件，与真实加载器一致。 */
function loaderOf(fixture: Fixture, onLoad?: () => void) {
  return async (): Promise<Loaded> => {
    onLoad?.();
    const value = await readFile(fixture.config, "utf8");
    return { value, files: new Set([fixture.config]), commit: () => {} };
  };
}

function fakeSystem(
  options: {
    stat?: (path: string) => Promise<Stats>;
    onWatch?: (watcher: RecordingWatcher) => void;
  } = {},
): FakeSystem {
  const watchers: RecordingWatcher[] = [];
  const statCalls: string[] = [];
  const statOf = options.stat ?? ((path: string) => stat(path));
  return {
    watchers,
    statCalls,
    deps: {
      stat: (path) => {
        statCalls.push(path);
        return statOf(path);
      },
      watch: (path, watchOptions) => {
        const watcher = new RecordingWatcher(path, watchOptions);
        watchers.push(watcher);
        // 默认立刻就绪；用例可改成永不就绪或在就绪前后报错。
        if (options.onWatch) options.onWatch(watcher);
        else queueMicrotask(() => watcher.emit("ready"));
        return watcher;
      },
    },
  };
}

function loggerOf() {
  const warnings: Array<{ message: string; context?: Record<string, unknown> }> = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (message, context) => {
      warnings.push({ message, context });
    },
    error: () => {},
    child: () => logger,
  };
  return { logger, warnings };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function withTimeout<T>(promise: Promise<T>, limitMs: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} 在 ${limitMs}ms 内没有结束`)), limitMs);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

async function waitFor(predicate: () => boolean, what: string, limitMs = SETTLE_LIMIT_MS) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > limitMs) throw new Error(`${what} 在 ${limitMs}ms 内没有发生`);
    await sleep(20);
  }
}

function watchFailure(): Error {
  return Object.assign(new Error("UNKNOWN: unknown error, watch"), { code: "UNKNOWN" });
}

test("锚点 stat 挂住时，一次绑定在截止时间内降级而不是无限等待", async () => {
  const fixture = await fixtureOf("zcode-watch-hung-stat-");
  const hung = new Promise<Stats>(() => {});
  const fake = fakeSystem({
    stat: (path) => (path === fixture.root ? hung : stat(path)),
  });
  const { logger, warnings } = loggerOf();
  try {
    const started = performance.now();
    const entry = await withTimeout(
      createWatchedEntry(
        { load: loaderOf(fixture), bounds: [fixture.root], label: LABEL, logger, bindTimeoutMs: SHORT_BIND_TIMEOUT_MS },
        fake.deps,
      ),
      SETTLE_LIMIT_MS,
       "条目创建",
    );
    const elapsed = performance.now() - started;
    try {
      // 等满了截止时间才放弃（立即返回说明根本没等 stat），且只多等一份截止时间。
      assert.ok(elapsed >= SHORT_BIND_TIMEOUT_MS - 20, `实际等待 ${elapsed}ms，短于截止时间`);
      assert.ok(elapsed < SHORT_BIND_TIMEOUT_MS * 2 + 500, `实际等待 ${elapsed}ms，超过一份截止时间`);
      assert.deepEqual(
        warnings.map((warning) => warning.message),
        [BIND_TIMEOUT_MESSAGE],
      );
      assert.equal(warnings[0]?.context?.path, fixture.root);
      // 拿不到身份就没有锚点，不建 watcher；条目本身仍可用。
      assert.equal(fake.watchers.length, 0);
      await writeFile(fixture.config, "v2");
      const flushed = performance.now();
      await entry.flush();
      assert.ok(
        performance.now() - flushed < SHORT_BIND_TIMEOUT_MS,
        "断路之后 flush 不应再等一个截止时间",
      );
      assert.equal(entry.current().value, "v2", "降级后仍读得到最新内容");
      // 超时标记跟条目走：同一锚点不再 stat、不重建 watcher、不再记 warn。
      assert.equal(fake.statCalls.filter((path) => path === fixture.root).length, 1);
      assert.equal(fake.watchers.length, 0);
      assert.equal(warnings.length, 1);
    } finally {
      entry.close();
    }
  } finally {
    await fixture.dispose();
  }
});

test("生产默认 1 秒：watcher 既不就绪也不报错时也在 1 秒后降级", async () => {
  const fixture = await fixtureOf("zcode-watch-never-ready-");
  // 不触发 ready、不触发 error：chokidar 在网盘路径上既不就绪也不报错是真实故障形态。
  const fake = fakeSystem({ onWatch: () => {} });
  const { logger, warnings } = loggerOf();
  try {
    assert.equal(WATCH_BIND_TIMEOUT_MS, 1_000, "生产默认截止时间是一秒");
    const started = performance.now();
    const entry = await withTimeout(
      createWatchedEntry(
        { load: loaderOf(fixture), bounds: [fixture.root], label: LABEL, logger },
        fake.deps,
      ),
      SETTLE_LIMIT_MS,
      "条目创建",
    );
    const elapsed = performance.now() - started;
    try {
      assert.ok(elapsed >= WATCH_BIND_TIMEOUT_MS - 50, `实际等待 ${elapsed}ms，短于 1 秒`);
      assert.ok(elapsed < WATCH_BIND_TIMEOUT_MS + 1_000, `实际等待 ${elapsed}ms，远超 1 秒`);
      assert.equal(fake.watchers.length, 1);
      assert.equal(fake.watchers[0]?.closed, true, "超时的 watcher 必须关闭");
      assert.deepEqual(
        warnings.map((warning) => warning.message),
        [BIND_TIMEOUT_MESSAGE],
      );
      await writeFile(fixture.config, "v2");
      await entry.flush();
      assert.equal(entry.current().value, "v2");
      assert.equal(fake.watchers.length, 1, "断路后 flush 不再重建 watcher");
    } finally {
      entry.close();
    }
  } finally {
    await fixture.dispose();
  }
});

test("watcher 就绪后连续报错两次即停止监听，warn 不吞且 flush 仍全量重读", async () => {
  const fixture = await fixtureOf("zcode-watch-two-strikes-");
  const fake = fakeSystem({
    onWatch: (watcher) => {
      queueMicrotask(() => watcher.emit("ready"));
      setImmediate(() => watcher.emit("error", watchFailure()));
    },
  });
  const { logger, warnings } = loggerOf();
  try {
    const entry = await withTimeout(
      createWatchedEntry(
        { load: loaderOf(fixture), bounds: [fixture.root], label: LABEL, logger },
        fake.deps,
      ),
      SETTLE_LIMIT_MS,
      "条目创建",
    );
    try {
      // 第一次就绪后报错只重绑一次，第二次即停止：恰好 2 个 watcher。
      assert.equal(fake.watchers.length, 2);
      assert.equal(fake.watchers[0]?.closed, true);
      assert.deepEqual(
        warnings.map((warning) => warning.message),
        [FAILURE_MESSAGE, STOPPED_MESSAGE],
      );
      assert.equal(warnings[1]?.context?.path, fixture.root);
      await writeFile(fixture.config, "v2");
      await entry.flush();
      assert.equal(entry.current().value, "v2", "停止监听不影响全量重读");
      assert.equal(fake.watchers.length, 2, "停止监听后不再新建 watcher");
    } finally {
      entry.close();
    }
  } finally {
    await fixture.dispose();
  }
});

test("真实磁盘：写入事件经去抖后读盘并更新快照", async () => {
  const fixture = await fixtureOf("zcode-watch-real-");
  const { logger, warnings } = loggerOf();
  const entry = await createWatchedEntry({
    load: loaderOf(fixture),
    bounds: [fixture.root],
    label: LABEL,
    logger,
  });
  try {
    const refreshed = new Promise<void>((resolve) => entry.listen(resolve));
    await writeFile(fixture.config, "v2");
    await withTimeout(refreshed, SETTLE_LIMIT_MS, "文件事件触发的重载");
    assert.equal(entry.current().value, "v2");
    assert.deepEqual(warnings, []);
  } finally {
    entry.close();
    await fixture.dispose();
  }
});

test("连续文件事件在 300ms 尾部去抖后合并成一次读盘", async () => {
  const fixture = await fixtureOf("zcode-watch-debounce-");
  let loads = 0;
  const fake = fakeSystem();
  const entry = await createWatchedEntry(
    {
      load: loaderOf(fixture, () => {
        loads += 1;
      }),
      bounds: [fixture.root],
      label: LABEL,
    },
    fake.deps,
  );
  try {
    assert.equal(WATCHED_SOURCE_DEBOUNCE_MS, 300, "尾部去抖是 300ms");
    const watcher = fake.watchers[0];
    assert.ok(watcher);
    const baseline = loads;
    // 一次保存常产生多个 raw / all 事件：5 个事件必须只触发 1 次读盘。
    for (let index = 0; index < 5; index += 1) {
      watcher.emit("raw", "change", CONFIG_NAME, { watchedPath: fixture.root });
    }
    await sleep(WATCHED_SOURCE_DEBOUNCE_MS + 400);
    assert.equal(loads - baseline, 1, "去抖后只读一次盘");
  } finally {
    entry.close();
    await fixture.dispose();
  }
});

test("dispose 后不再读盘也不再回调", async () => {
  const fixture = await fixtureOf("zcode-watch-dispose-");
  let loads = 0;
  const fake = fakeSystem();
  const entry = await createWatchedEntry(
    {
      load: loaderOf(fixture, () => {
        loads += 1;
      }),
      bounds: [fixture.root],
      label: LABEL,
    },
    fake.deps,
  );
  try {
    let calls = 0;
    const refreshed = new Promise<void>((resolve) => {
      entry.listen(() => {
        calls += 1;
        resolve();
      });
    });
    const watcher = fake.watchers[0];
    assert.ok(watcher);
    watcher.emit("raw", "change", CONFIG_NAME, { watchedPath: fixture.root });
    await withTimeout(refreshed, SETTLE_LIMIT_MS, "关闭前的重载");
    assert.equal(calls, 1);

    entry.close();
    assert.equal(watcher.closed, true, "close 要关闭底层 watcher");
    const loadsAfterClose = loads;
    watcher.emit("raw", "change", CONFIG_NAME, { watchedPath: fixture.root });
    await sleep(WATCHED_SOURCE_DEBOUNCE_MS + 300);
    assert.equal(loads, loadsAfterClose, "dispose 后不再读盘");
    assert.equal(calls, 1, "dispose 后不再回调");
    assert.equal(entry.current().value, "v1", "快照停在最后一次提交");
  } finally {
    entry.close();
    await fixture.dispose();
  }
});

test("flush 跳过去抖立即读盘，并清掉挂起的去抖定时器", async () => {
  const fixture = await fixtureOf("zcode-watch-flush-");
  let loads = 0;
  const fake = fakeSystem();
  const entry = await createWatchedEntry(
    {
      load: loaderOf(fixture, () => {
        loads += 1;
      }),
      bounds: [fixture.root],
      label: LABEL,
    },
    fake.deps,
  );
  try {
    const watcher = fake.watchers[0];
    assert.ok(watcher);
    const baseline = loads;
    watcher.emit("raw", "change", CONFIG_NAME, { watchedPath: fixture.root });
    await writeFile(fixture.config, "v2");
    await entry.flush();
    assert.equal(entry.current().value, "v2", "flush 不等去抖窗口");
    assert.equal(loads - baseline, 1);
    await sleep(WATCHED_SOURCE_DEBOUNCE_MS + 300);
    assert.equal(loads - baseline, 1, "挂起的去抖定时器已被清掉");
  } finally {
    entry.close();
    await fixture.dispose();
  }
});

test("读盘期间关闭：迟到的结果不发布、不重建监听", async () => {
  const fixture = await fixtureOf("zcode-watch-close-midload-");
  let loads = 0;
  let gated = false;
  let releaseLoad: (() => void) | undefined;
  const fake = fakeSystem();
  const gatedLoad = async (): Promise<Loaded> => {
    loads += 1;
    // 只闸住事件触发的那次读盘：创建时的首载与 flush 必须正常完成。
    if (gated) {
      gated = false;
      await new Promise<void>((resolve) => {
        releaseLoad = resolve;
      });
    }
    const value = await readFile(fixture.config, "utf8");
    return { value, files: new Set([fixture.config]), commit: () => {} };
  };
  const entry = await createWatchedEntry(
    { load: gatedLoad, bounds: [fixture.root], label: LABEL },
    fake.deps,
  );
  try {
    let calls = 0;
    entry.listen(() => {
      calls += 1;
    });
    const watcher = fake.watchers[0];
    assert.ok(watcher);
    gated = true;
    watcher.emit("raw", "change", CONFIG_NAME, { watchedPath: fixture.root });
    await waitFor(() => releaseLoad !== undefined, "事件触发的读盘已开始");
    const loadsAtClose = loads;
    entry.close();
    releaseLoad?.();
    await sleep(WATCHED_SOURCE_DEBOUNCE_MS);
    assert.equal(calls, 0, "关闭后迟到的读盘结果不发布");
    assert.equal(fake.watchers.length, 1, "关闭后不再重建 watcher");
    assert.equal(loads, loadsAtClose, "关闭后不再读盘");
  } finally {
    entry.close();
    await fixture.dispose();
  }
});

test("同一 key 复用条目：复用先读最新内容，最后一个 view 释放后关闭 watcher", async () => {
  const fixture = await fixtureOf("zcode-watch-registry-");
  const fake = fakeSystem();
  const registry = createRefcountedRegistry<
    { root: string },
    WatchedEntry<Loaded>,
    { entry: WatchedEntry<Loaded>; release: () => void }
  >({
    label: LABEL,
    key: (options) => options.root,
    create: () =>
      createWatchedEntry(
        { load: loaderOf(fixture), bounds: [fixture.root], label: LABEL },
        fake.deps,
      ),
    view: (entry, _options, release) => ({ entry, release }),
  });
  try {
    const first = await registry.acquire({ root: fixture.root });
    assert.equal(fake.watchers.length, 1);
    await writeFile(fixture.config, "v2");
    const second = await registry.acquire({ root: fixture.root });
    assert.equal(second.entry, first.entry, "同一 key 共用一个条目");
    assert.equal(second.entry.current().value, "v2", "复用条目先 flush 读最新内容");
    assert.equal(fake.watchers.length, 1, "复用不新建 watcher");

    first.release();
    assert.equal(fake.watchers[0]?.closed, false, "还有引用时不关闭");
    second.release();
    assert.equal(fake.watchers[0]?.closed, true, "最后一个 view 释放时关闭");

    const third = await registry.acquire({ root: fixture.root });
    assert.notEqual(third.entry, first.entry, "释放后重建条目");
    assert.equal(fake.watchers.length, 2, "重建时重新监听");
    third.release();
  } finally {
    registry.close();
    await fixture.dispose();
  }
});

test("目录条目只接受直接子目录与登记文件", async () => {
  const fixture = await fixtureOf("zcode-watch-directories-");
  const skills = join(fixture.root, "skills");
  await mkdir(join(skills, "existing"), { recursive: true });
  await writeFile(join(skills, "README.md"), "notes");
  await writeFile(join(skills, "existing", "SKILL.md"), "---\nname: existing\n---\n");
  const fake = fakeSystem();
  const entry = await createWatchedEntry(
    {
      load: async () => ({
        files: new Set([join(skills, "SKILL.md")]),
        directories: new Set([skills]),
        commit: () => {},
      }),
      bounds: [fixture.root],
      childName: (name) => !name.startsWith("."),
      label: "Skill catalog",
    },
    fake.deps,
  );
  try {
    assert.deepEqual(
      fake.watchers.map((watcher) => watcher.anchor),
      [skills],
    );
    const ignored = fake.watchers[0]!.options.ignored;
    const directory = await stat(join(skills, "existing"));
    const plainFile = await stat(join(skills, "README.md"));
    // 目录自身、直接子目录（新建/删除/改名都落在根目录事件里）都相关。
    assert.equal(ignored(skills), false);
    assert.equal(ignored(join(skills, "existing")), false);
    assert.equal(ignored(join(skills, "existing"), directory), false);
    assert.equal(ignored(join(skills, "fresh")), false);
    // 未登记的直接子文件不相关（chokidar 会给通过过滤的文件各开句柄）。
    assert.equal(ignored(join(skills, "README.md"), plainFile), true);
    assert.equal(ignored(join(skills, "SKILL.md"), plainFile), false);
    // 被 childName 排除的名字与嵌套文件都不相关。
    assert.equal(ignored(join(skills, ".hidden"), directory), true);
    assert.equal(ignored(join(skills, "existing", "SKILL.md"), plainFile), true);
    assert.equal(ignored(join(fixture.root, "elsewhere"), directory), true);
  } finally {
    entry.close();
    await fixture.dispose();
  }
});
