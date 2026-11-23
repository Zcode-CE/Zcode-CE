/**
 * 主窗口 `window.open` / `target=_blank` 边界（上游 v4.0.0 `desktopWindowChrome.ts` 的
 * `createBrowserWindow:681-694` setWindowOpenHandler，逐 hunk 移植）单测。
 *
 * 钉住的契约：主窗口不创建未经管控的原生子窗口。合法 http(s) 外链不在这里直开系统浏览器，
 * 而是经既有 `PlatformChannels.OpenBrowserUrl` 交给 renderer 的 Browser 路由；其余协议一律 deny。
 * 理由：不装 handler 时 Electron 会用继承的 webPreferences 造新原生窗口（同样挂 preload），
 * 直接 navegate 到远程页面就拿到整窗特权 IPC；而 `window.open` 恰好绕过 DOM 链接检查。
 *
 * 为什么用桩：node:test 里无法 require 真实 electron（见 support/electronStub.mjs）。
 *
 * 运行：cd packages/desktop && node --import tsx --test test/mainWindowWindowOpen.test.ts
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register(new URL("./support/stubResolver.mjs", import.meta.url));

const { createMainWindowWindowOpenHandler, isAllowedEmbeddedBrowserNewWindowUrl } =
  await import("../src/main/desktopWindowChrome.js");

interface RecordedRequest {
  url: string;
  disposition: string;
}

function createHarness() {
  const sent: RecordedRequest[] = [];
  const warnings: unknown[][] = [];
  const handler = createMainWindowWindowOpenHandler({
    sendOpenBrowserUrl: (request: RecordedRequest) => sent.push(request),
    logger: { warn: (...args: unknown[]) => warnings.push(args) },
  });
  return { handler, sent, warnings };
}

test("纯函数判定:只有 http(s) 算可转交的新窗口 URL", () => {
  for (const url of [
    "https://example.com/a?b=1",
    "http://127.0.0.1:3000/x",
    "HTTP://Example.COM/Path",
  ]) {
    assert.equal(isAllowedEmbeddedBrowserNewWindowUrl(url), true, url);
  }

  for (const url of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "about:blank",
    "blob:https://example.com/2f7a",
    "mailto:someone@example.com",
    "zcode://oauth/callback?code=x",
    "//example.com/protocol-relative",
    "/relative/path",
    "",
  ]) {
    assert.equal(isAllowedEmbeddedBrowserNewWindowUrl(url), false, url);
  }
});

test("合法外链:一律 deny 原生窗口,转交 OpenBrowserUrl 通道", () => {
  const { handler, sent, warnings } = createHarness();

  for (const disposition of [
    "foreground-tab",
    "background-tab",
    "new-window",
    "default",
  ] as const) {
    const response = handler({ url: "https://example.com/doc", disposition });
    // 即使 URL 合法也不允许 Electron 自己造窗口：路由必须由 renderer 的 Browser 面板决定。
    assert.deepEqual(response, { action: "deny" }, disposition);
  }

  assert.deepEqual(sent, [
    { url: "https://example.com/doc", disposition: "foreground-tab" },
    { url: "https://example.com/doc", disposition: "background-tab" },
    { url: "https://example.com/doc", disposition: "new-window" },
    { url: "https://example.com/doc", disposition: "default" },
  ]);
  assert.deepEqual(warnings, []);
});

test("非白名单协议:一律 deny 且不转交任何通道", () => {
  const { handler, sent, warnings } = createHarness();
  const blocked = [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "about:blank",
    "zcode://oauth/callback?code=x",
    "//example.com/protocol-relative",
    "not a url",
    "",
  ];

  for (const url of blocked) {
    assert.deepEqual(handler({ url, disposition: "new-window" }), { action: "deny" }, url);
  }

  assert.deepEqual(sent, [], "被拒的协议不得经 OpenBrowserUrl 转出");
  assert.equal(warnings.length, blocked.length);
  // 与导航守卫一致：只记事件、不写 URL（可能带凭据）。
  assert.deepEqual(warnings[0], ["[desktop-window] blocked unsupported popup protocol"]);
});

test("接线:主窗口创建路径装了 setWindowOpenHandler", async () => {
  const chromeSource = await readFile(
    new URL("../src/main/desktopWindowChrome.ts", import.meta.url),
    "utf8",
  );

  assert.match(chromeSource, /win\.webContents\.setWindowOpenHandler\(/);
  assert.match(chromeSource, /createMainWindowWindowOpenHandler\(/);
  // 主窗口边界不允许直开系统浏览器：外链必须复用 renderer 的 Browser 路由通道。
  assert.match(chromeSource, /send\(PlatformChannels\.OpenBrowserUrl, request\)/);
});
