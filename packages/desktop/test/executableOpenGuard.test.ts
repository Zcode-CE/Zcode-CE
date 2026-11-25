/**
 * 可执行类文件「交给系统打开」前的确认（4.0.0 S5 第二道防线，CE 移植）。
 *
 * 钉住的规则:
 * 1. 判定只看平台后缀表与 macOS 脚本执行器身份，不看文件模式位 —— 普通源码带可执行位也不该
 *    反复弹窗（后缀表按平台拆分就是为了这个）；
 * 2. 后缀按 NFKC 归一化并忽略大小写与首尾空白，路径本身或符号链接的真实目标命中都算；
 * 3. 确认框默认按钮与 Esc 都是取消，且文案跟随当前界面语言。
 *
 * 运行: cd packages/desktop && mise exec node@24.14.0 -- node --import tsx --test test/executableOpenGuard.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
import test from "node:test";

register(new URL("./support/stubResolver.mjs", import.meta.url));

const { createExecutableFileOpenConfirmer, isExecutableFilePath, isScriptRunnerApplication } =
  await import("../src/main/file-open-apps/executableOpenGuard.js");
const { stubBrowserWindow, stubDialog } = await import("./support/electronStub.mjs");

interface ShowMessageBoxOptions {
  message?: string;
  detail?: string;
  buttons?: string[];
  defaultId?: number;
  cancelId?: number;
}

/** 用可改写的桩替换 dialog.showMessageBox，返回调用记录与恢复函数。 */
function stubShowMessageBox(response: number) {
  const calls: Array<{ parent?: unknown; options: ShowMessageBoxOptions }> = [];
  const stub = stubDialog as { showMessageBox?: (...args: unknown[]) => Promise<unknown> };
  const previous = stub.showMessageBox;
  stub.showMessageBox = async (...args: unknown[]) => {
    const [parent, options] =
      args.length > 1
        ? [args[0], args[1] as ShowMessageBoxOptions]
        : [undefined, args[0] as ShowMessageBoxOptions];
    calls.push({ parent, options });
    return { response, checkboxChecked: false };
  };
  return {
    calls,
    restore() {
      stub.showMessageBox = previous;
    },
  };
}

const EXPECTED: Array<[NodeJS.Platform, string, boolean]> = [
  ["darwin", "x.terminal", true],
  ["darwin", "x.command", true],
  ["darwin", "Bundle.app", true],
  ["darwin", "x.sh", false],
  ["darwin", "x.exe", false],
  ["win32", "setup.exe", true],
  ["win32", "run.bat", true],
  ["win32", "deploy.ps1", true],
  ["win32", "x.terminal", false],
  ["linux", "install.sh", true],
  ["linux", "app.desktop", true],
  ["linux", "tool.run", true],
  ["linux", "App.AppImage", true],
  ["linux", "payload.terminal", false],
  ["linux", "x.exe", false],
];

test("平台后缀表：只命中该平台交给系统打开会执行的后缀", async () => {
  for (const [platform, path, expected] of EXPECTED) {
    assert.equal(
      await isExecutableFilePath(path, platform),
      expected,
      `${platform} 上的 ${path} 应为 ${expected}`,
    );
  }
});

test("普通文档与只读源码在任何平台都不命中", async () => {
  for (const platform of ["darwin", "win32", "linux"] as const) {
    for (const path of ["notes.txt", "README.md", "photo.png", "archive.zip", "main.ts"]) {
      assert.equal(await isExecutableFilePath(path, platform), false, `${platform}/${path}`);
    }
  }
});

test("后缀归一化：大小写、首尾空白与全角字符都按系统识别的后缀判定", async () => {
  assert.equal(await isExecutableFilePath("SETUP.EXE  ", "win32"), true);
  assert.equal(await isExecutableFilePath("Install.Sh", "linux"), true);
  // 全角字母与全角句点经 NFKC 归一后与 ASCII 后缀一致。
  assert.equal(await isExecutableFilePath("ｒｕｎ．ＳＨ", "linux"), true);
  assert.equal(await isExecutableFilePath("payload.Terminal", "darwin"), true);
  // 只有后缀、没有主文件名时不当作可执行类文件（点号在第 0 位，摘出的后缀为空）。
  assert.equal(await isExecutableFilePath(".sh", "linux"), false);
});

test("符号链接按真实目标判定，参数指向不存在的路径时按字面后缀判定", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-exec-guard-"));
  try {
    const payload = join(dir, "payload.terminal");
    await writeFile(payload, "#!/bin/sh\necho pwned\n");
    const innocentLink = join(dir, "notes.txt");
    await symlink(payload, innocentLink);
    const innocent = join(dir, "plain.txt");
    await writeFile(innocent, "hello");
    const plainLink = join(dir, "alias.txt");
    await symlink(innocent, plainLink);

    assert.equal(
      await isExecutableFilePath(innocentLink, "darwin"),
      true,
      "链接名无害但目标可执行",
    );
    assert.equal(await isExecutableFilePath(plainLink, "darwin"), false);
    assert.equal(await isExecutableFilePath(join(dir, "missing.terminal"), "darwin"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("macOS 终端/脚本类应用即使文件后缀无害也要确认", () => {
  assert.equal(isScriptRunnerApplication("darwin-bundle:com.apple.Terminal", "darwin"), true);
  assert.equal(
    isScriptRunnerApplication("  DARWIN-BUNDLE:COM.GOOGLECODE.ITERM2 ", "darwin"),
    true,
    "身份比较忽略大小写与首尾空白",
  );
  assert.equal(isScriptRunnerApplication("darwin-bundle:com.apple.finder", "darwin"), false);
  assert.equal(isScriptRunnerApplication("darwin-bundle:com.apple.Terminal", "linux"), false);
  assert.equal(isScriptRunnerApplication(undefined, "darwin"), false);
});

test("确认框：默认按钮与 Esc 都是取消，文案跟随界面语言", async () => {
  const zh = stubShowMessageBox(0);
  try {
    const confirm = createExecutableFileOpenConfirmer(() => "zh-CN");
    assert.equal(await confirm("/tmp/dropped/payload.terminal"), false, "Esc 对应索引 0，视为取消");
    const [call] = zh.calls;
    assert.ok(call);
    assert.equal(call.options.message, "此文件打开后可能执行命令");
    assert.match(call.options.detail ?? "", /payload\.terminal/u);
    assert.deepEqual(call.options.buttons, ["取消", "仍然打开"]);
    assert.equal(call.options.defaultId, 0);
    assert.equal(call.options.cancelId, 0);
  } finally {
    zh.restore();
  }

  const en = stubShowMessageBox(1);
  try {
    const confirm = createExecutableFileOpenConfirmer(() => "en-US");
    assert.equal(await confirm("/tmp/dropped/setup.exe"), true, "索引 1 是「仍然打开」");
    const [call] = en.calls;
    assert.ok(call);
    assert.equal(call.options.message, "Opening this file may run commands");
    assert.deepEqual(call.options.buttons, ["Cancel", "Open anyway"]);
  } finally {
    en.restore();
  }
});

test("确认框挂在当前聚焦窗口上，没有窗口时用无父窗口形态", async () => {
  const fakeWindow = { id: 7 };
  const previousFocused = stubBrowserWindow.getFocusedWindow;
  const withParent = stubShowMessageBox(0);
  try {
    stubBrowserWindow.getFocusedWindow = () => fakeWindow as never;
    await createExecutableFileOpenConfirmer(() => "en-US")("/tmp/setup.exe");
    assert.equal(withParent.calls[0]?.parent, fakeWindow);
  } finally {
    stubBrowserWindow.getFocusedWindow = previousFocused;
    withParent.restore();
  }

  const withoutParent = stubShowMessageBox(0);
  try {
    await createExecutableFileOpenConfirmer(() => "en-US")("/tmp/setup.exe");
    assert.equal(withoutParent.calls[0]?.parent, undefined);
  } finally {
    withoutParent.restore();
  }
});
