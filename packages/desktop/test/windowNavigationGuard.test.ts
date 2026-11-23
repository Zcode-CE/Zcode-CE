/**
 * 挂 preload 窗口的顶层导航守卫（上游 v4.0.0 `desktopWindowChrome.ts` 的
 * `guardWindowNavigation` / `isAppOriginMainWindowUrl`，逐 hunk 移植）单测。
 *
 * 钉住的契约：挂了 `window.zcode` preload 的窗口（主窗口 + `windowKind=update-status`）
 * 顶层导航只能停留在应用自身的渲染入口；其余一律 preventDefault。理由：这类窗口的渲染进程
 * 持有全套特权 IPC，Mermaid 渲染出的 SVG 里 `<a xlink:href>` 点击即窗口内顶层导航，
 * 而该链接内容由模型输出（Markdown）决定 ⇒ 不拦就是「模型输出 → 顶层导航 → preload 特权」。
 *
 * 为什么用桩：node:test 里无法 require 真实 electron（见 support/electronStub.mjs 说明）。
 *
 * 运行：cd packages/desktop && node --import tsx --test test/windowNavigationGuard.test.ts
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register(new URL("./support/stubResolver.mjs", import.meta.url));

const { guardWindowNavigation, isAppOriginMainWindowUrl } =
  await import("../src/main/desktopWindowChrome.js");

const RENDERER_DIR = "/opt/zcode/out/renderer";
const PACKAGED_ENV = {
  isPackaged: true,
  rendererDevUrl: undefined,
  rendererDir: RENDERER_DIR,
};

test("打包态:renderer 目录下的应用入口允许(含 query/hash)", () => {
  const allowed = [
    "file:///opt/zcode/out/renderer/index.html",
    "file:///opt/zcode/out/renderer/index.html?windowKind=update-status&locale=zh-CN",
    "file:///opt/zcode/out/renderer/login.html#top",
  ];

  for (const url of allowed) {
    assert.equal(isAppOriginMainWindowUrl(url, PACKAGED_ENV), true, url);
  }
});

test("打包态:同名前缀兄弟目录/文件不算应用入口(前缀必须带尾部分隔符)", () => {
  const blocked = [
    "file:///opt/zcode/out/renderer-evil/index.html",
    "file:///opt/zcode/out/rendererX/index.html",
    "file:///opt/zcode/out/renderer.html",
  ];

  for (const url of blocked) {
    assert.equal(isAppOriginMainWindowUrl(url, PACKAGED_ENV), false, url);
  }
});

test("打包态:远程页面 / 非应用协议 / 非法 URL 一律拒绝", () => {
  const blocked = [
    "https://example.com/",
    "http://127.0.0.1:5173/index.html",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "about:blank",
    "//example.com/relative",
    "index.html",
    "",
  ];

  for (const url of blocked) {
    assert.equal(isAppOriginMainWindowUrl(url, PACKAGED_ENV), false, url);
  }
});

test("开发态:只认 dev server 同源,file 入口不在可信集合内", () => {
  const devEnv = {
    isPackaged: false,
    rendererDevUrl: "http://localhost:5173",
    rendererDir: RENDERER_DIR,
  };

  assert.equal(
    isAppOriginMainWindowUrl("http://localhost:5173/index.html?windowKind=main", devEnv),
    true,
  );
  assert.equal(isAppOriginMainWindowUrl("http://localhost:5173/login.html", devEnv), true);
  // 端口（origin 的一部分）与协议不同即不是同一来源。
  assert.equal(isAppOriginMainWindowUrl("http://localhost:5174/index.html", devEnv), false);
  assert.equal(isAppOriginMainWindowUrl("https://localhost:5173/index.html", devEnv), false);
  assert.equal(isAppOriginMainWindowUrl("http://evil.example/index.html", devEnv), false);
  // 开发态入口由 dev server 承载：file 入口不是可信来源（与上游同一判定）。
  assert.equal(
    isAppOriginMainWindowUrl("file:///opt/zcode/out/renderer/index.html", devEnv),
    false,
  );
});

test("打包态忽略继承的 ELECTRON_RENDERER_URL", () => {
  const env = {
    isPackaged: true,
    rendererDevUrl: "http://localhost:5173",
    rendererDir: RENDERER_DIR,
  };

  // 生产包若信任进程环境里的 dev 地址，本机开发会话就能把自己变成可信来源。
  assert.equal(isAppOriginMainWindowUrl("http://localhost:5173/index.html", env), false);
  assert.equal(isAppOriginMainWindowUrl("file:///opt/zcode/out/renderer/index.html", env), true);
});

test("开发态 dev 地址不可解析时按拒绝处理(不放行任何导航)", () => {
  const env = {
    isPackaged: false,
    rendererDevUrl: "not-a-url",
    rendererDir: RENDERER_DIR,
  };

  assert.equal(isAppOriginMainWindowUrl("file:///opt/zcode/out/renderer/index.html", env), false);
  assert.equal(isAppOriginMainWindowUrl("http://localhost:5173/index.html", env), false);
});

test("挂载:will-navigate 非应用入口阻止默认导航,且 warn 不写 URL", () => {
  const listeners = new Map<string, (event: FakeNavEvent, url: string) => void>();
  const fakeContents = {
    on(event: string, handler: (event: FakeNavEvent, url: string) => void) {
      listeners.set(event, handler);
      return fakeContents;
    },
  };
  const warnings: unknown[][] = [];

  guardWindowNavigation(
    fakeContents as never,
    { warn: (...args: unknown[]) => warnings.push(args) },
    PACKAGED_ENV,
  );

  const handler = listeners.get("will-navigate");
  assert.ok(handler, "必须挂在 will-navigate 上");

  let prevented = 0;
  const event: FakeNavEvent = {
    preventDefault: () => {
      prevented += 1;
    },
  };

  handler(event, "https://evil.example/steal");
  assert.equal(prevented, 1, "远程页面必须被拦下");
  assert.equal(warnings.length, 1);
  // 被拦的地址可能带凭据（OAuth 回调等），日志只记事件、不记 URL。
  assert.deepEqual(warnings[0], ["[desktop-window] blocked window top-level navigation"]);

  handler(event, "file:///opt/zcode/out/renderer/index.html?windowKind=main");
  assert.equal(prevented, 1, "应用自身入口不得被拦");
  assert.equal(warnings.length, 1);
});

test("接线:主窗口与更新状态窗口的创建路径都挂了守卫", async () => {
  // 上游修复前的形态是「只有 guest 级 will-navigate、主窗口零守卫」；
  // 这里钉住两处挂载点本身，删掉任一处即在 CI 变红。
  const chromeSource = await readFile(
    new URL("../src/main/desktopWindowChrome.ts", import.meta.url),
    "utf8",
  );
  const mainSource = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");

  assert.match(chromeSource, /guardWindowNavigation\(win\.webContents, options\.logger\)/);
  assert.match(mainSource, /guardWindowNavigation\(win\.webContents, logger\)/);
});

interface FakeNavEvent {
  preventDefault: () => void;
}
