import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";
import type { IPty } from "node-pty";
import type { ISettingService } from "../src/setting/setting.js";
import { TERMINAL_UNSUBSCRIBED_OUTPUT_MAX_CHARS } from "../src/terminal/terminalOutputBuffer.js";
import { createTerminalService } from "../src/terminal/terminalService.js";

/**
 * 首监听者到来前的 PTY 输出必须缓存并在订阅后回放（上游 3.16.2 X18 / 3.16.3「手机远控终端」同类）。
 *
 * 缺陷形态：renderer 要等 create() 返回才能订阅 onDynamicData，而 PTY 的首个提示符在 spawn 后
 * 约 10ms 就到；本地往返能抢到，远端 SSH 40~200ms 必丢，之后 shell 空闲 ⇒ 用户看到空白终端。
 * 这里用注入的假 node-pty 直接驱动 onData，断言的是「服务接线」而不只是缓冲区本身。
 */

type FakePty = { pty: IPty; emit: (data: string) => void };

function createFakePty(): FakePty {
  let onData: ((data: string) => void) | undefined;
  const pty = {
    onData: (cb: (data: string) => void) => {
      onData = cb;
    },
    onExit: () => {},
    write: () => {},
    resize: () => {},
    kill: () => {},
  } as unknown as IPty;
  return {
    pty,
    emit: (data) => onData?.(data),
  };
}

function createService(pty: IPty) {
  return createTerminalService({
    settingService: { get: async () => ({}) } as unknown as ISettingService,
    localLibcSnapshot: () => ({
      platform: process.platform,
      glibcVersionRuntime: "2.36",
      readFailures: [],
    }),
    loadNodePty: async () => ({ spawn: () => pty }) as never,
  });
}

async function withTerminal(run: (ctx: { emit: (d: string) => void; id: string; service: ReturnType<typeof createService> }) => void | Promise<void>) {
  const previousShell = process.env.SHELL;
  const previousHome = process.env.HOME;
  process.env.SHELL = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh";
  process.env.HOME = tmpdir();
  const fake = createFakePty();
  const service = createService(fake.pty);
  try {
    const { id } = await service.create({ cols: 80, rows: 24, cwd: tmpdir() });
    await run({ emit: fake.emit, id, service });
    (service as unknown as { disposeAll?: () => void }).disposeAll?.();
  } finally {
    if (previousShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = previousShell;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
}

test("判据 1：订阅前的输出按序回放，订阅后转直通", async () => {
  await withTerminal(({ emit, id, service }) => {
    emit("banner\r\n");
    emit("dev@host:~$ ");

    const received: string[] = [];
    service.onDynamicData(id)((data) => received.push(data));
    emit("live");

    assert.deepEqual(received, ["banner\r\n", "dev@host:~$ ", "live"]);
  });
});

test("判据 2：订阅断开期间的输出缓存给下一个监听者", async () => {
  await withTerminal(({ emit, id, service }) => {
    const first: string[] = [];
    const subscription = service.onDynamicData(id)((data) => first.push(data));
    emit("a");
    subscription.dispose();
    emit("b");

    const second: string[] = [];
    service.onDynamicData(id)((data) => second.push(data));
    emit("c");

    assert.deepEqual(first, ["a"]);
    assert.deepEqual(second, ["b", "c"]);
  });
});

test("判据 3：无监听者期间的缓存有上界，丢弃最旧块并保留尾部", async () => {
  await withTerminal(({ emit, id, service }) => {
    const head = "x".repeat(600_000);
    emit(head);
    emit("y".repeat(600_000));
    emit("tail");

    const received: string[] = [];
    service.onDynamicData(id)((data) => received.push(data));

    assert.ok(!received.includes(head), "最旧的块应被丢弃");
    assert.equal(received.at(-1), "tail");
    assert.ok(received.join("").length <= TERMINAL_UNSUBSCRIBED_OUTPUT_MAX_CHARS);
  });
});
