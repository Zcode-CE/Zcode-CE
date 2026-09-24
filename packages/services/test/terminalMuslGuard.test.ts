import assert from "node:assert/strict";
import test from "node:test";
import { createTerminalService } from "../src/terminal/terminalService.js";
import {
  assertLocalTerminalNativeSupported,
  classifyLocalLibc,
  type LocalLibcSnapshot,
} from "../src/terminal/localLibcSupport.js";

const GLIBC: LocalLibcSnapshot = {
  platform: "linux",
  glibcVersionRuntime: "2.36",
  readFailures: [],
};

const MUSL: LocalLibcSnapshot = {
  platform: "linux",
  muslLoaderPath: "/lib/ld-musl-x86_64.so.1",
  readFailures: [],
};

test("判据：有 glibcVersionRuntime ⇒ glibc", () => {
  const probe = classifyLocalLibc(GLIBC);
  assert.equal(probe.libc, "glibc");
  assert.match(probe.evidence.join("；"), /glibcVersionRuntime=2\.36/u);
});

test("判据：无 glibcVersionRuntime 且有 musl loader ⇒ musl", () => {
  const probe = classifyLocalLibc(MUSL);
  assert.equal(probe.libc, "musl");
  assert.match(probe.evidence.join("；"), /ld-musl-x86_64\.so\.1/u);
});

test("判据：两者都判不出 ⇒ unknown（留给 fail-open）", () => {
  assert.equal(classifyLocalLibc({ platform: "linux", readFailures: [] }).libc, "unknown");
});

test("判据：非 Linux（darwin）⇒ 跳过判定", () => {
  const probe = classifyLocalLibc({
    platform: "darwin",
    muslLoaderPath: "/lib/ld-musl-x86_64.so.1",
    readFailures: [],
  });
  assert.equal(probe.libc, "unknown");
  assert.match(probe.evidence.join("；"), /只在 Linux 上做/u);
});

test("守卫：musl ⇒ 抛可操作错误（说清后果与修法）", () => {
  assert.throws(
    () => assertLocalTerminalNativeSupported({ snapshot: MUSL }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /musl libc/u, "必须给出判定");
      assert.match(message, /段错误/u, "必须说清失败模式");
      assert.match(message, /exit 139|core dumped/u, "必须给出可核对的信号");
      assert.match(message, /杀掉整个进程/u, "必须说清后果不是可恢复错误");
      assert.match(message, /glibc 发行版/u, "必须给可操作修法");
      assert.match(message, /headless-server\.md/u, "必须指向文档");
      return true;
    },
  );
});

test("守卫：glibc ⇒ 放行且不打扰日志", () => {
  const logs: string[] = [];
  assertLocalTerminalNativeSupported({ snapshot: GLIBC, log: (message) => logs.push(message) });
  assert.deepEqual(logs, []);
});

test("守卫：判据不足 ⇒ fail-open 放行，但必须留日志（不静默）", () => {
  const logs: string[] = [];
  assertLocalTerminalNativeSupported({
    snapshot: { platform: "linux", readFailures: ["读取 /lib 失败：boom"] },
    log: (message, ...rest) => logs.push([message, ...rest].join(" ")),
  });
  assert.equal(logs.length, 1, "放行必须留痕");
  assert.match(logs[0], /无法判定/u);
  assert.match(logs[0], /读取 \/lib 失败：boom/u, "判据不足的原因必须带出来");
});

/** 只统计"到底有没有走到原生装载"：这是本任务的核心断言。 */
function createCountingTerminalService(snapshot: LocalLibcSnapshot) {
  const calls: string[] = [];
  const service = createTerminalService({
    settingService: {
      get: async () => ({}),
    } as never,
    localLibcSnapshot: () => snapshot,
    loadNodePty: async () => {
      calls.push("loadNodePty");
      return {
        spawn: () => {
          throw new Error("stub spawn（测试桩，不真的建终端）");
        },
      } as never;
    },
  });
  return { service, calls };
}

test("musl 主机：建终端在原生装载之前就被拦住 —— loadNodePty 调用数必须为 0", async () => {
  const { service, calls } = createCountingTerminalService(MUSL);
  await assert.rejects(
    () => service.create({ cols: 80, rows: 24 }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /musl libc/u);
      return true;
    },
  );
  assert.deepEqual(calls, [], "musl 判定后不允许发生 dlopen/原生装载");
});

test("glibc 主机：仍然走到装载（不得误伤现役路径）", async () => {
  const { service, calls } = createCountingTerminalService(GLIBC);
  await assert.rejects(
    () => service.create({ cols: 80, rows: 24 }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.doesNotMatch(message, /musl libc/u, "glibc 主机不得被 musl 守卫拦下");
      return true;
    },
  );
  assert.deepEqual(calls, ["loadNodePty"], "glibc 主机必须走到装载（否则会把现役路径一起挡掉）");
});
