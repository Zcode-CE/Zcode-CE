import assert from "node:assert/strict";
import test from "node:test";
import { resolveMermaidExternalLinkUrl } from "../src/components/ai-elements/mermaid-block.js";

/**
 * Mermaid SVG 外链判定的回归测试。
 *
 * 钉住的性质：Mermaid 渲染出的 SVG 里 `<a xlink:href>` 不经过应用的链接组件，点击时默认在窗口内
 * 做顶层导航；挂 `window.zcode` preload 的窗口一旦被远程页面接管，该页面就继承整窗特权 IPC，
 * 而链接内容由模型输出（Markdown）决定。因此只有绝对 HTTP(S) 链接可以交给宿主外开，
 * 其余协议与相对地址一律不许。
 *
 * 覆盖三类：
 * 1. **放行且规整**：绝对 http/https（含大小写与首尾空白）返回规范化的 href；
 * 2. **拒绝危险协议**：javascript: / data: / file: / mailto: / 应用自定义协议；
 * 3. **拒绝没有可信基准的输入**：协议相对、站内相对、纯锚点、空值。
 *
 * 边界：本文件只测纯函数。DOM 级点击（`Element.closest("a")` → preventDefault → platform.openExternal）
 * 不在覆盖范围内；即便 UI 漏拦，主进程的 `guardWindowNavigation` 仍是兜底（见 windowNavigationGuard 测试）。
 *
 * 运行方式（沿用既有 *.test.ts 的 node:test 约定，必须在包目录内执行：ui 的 `@/*` 别名依赖 tsconfig paths）：
 *   cd packages/ui && node --import tsx --test test/mermaidExternalLink.test.ts
 */

test("绝对 HTTP(S) 链接放行,并按 URL 规范化", () => {
  const allowed: Array<[string, string]> = [
    ["https://example.com/a?b=1#c", "https://example.com/a?b=1#c"],
    ["  https://example.com/  ", "https://example.com/"],
    ["http://127.0.0.1:8080/x", "http://127.0.0.1:8080/x"],
    ["HTTPS://Example.COM/Path", "https://example.com/Path"],
  ];

  for (const [input, expected] of allowed) {
    assert.equal(resolveMermaidExternalLinkUrl(input), expected, input);
  }
});

test("危险协议一律拒绝(javascript/data/file/mailto/应用自定义协议)", () => {
  const blocked = [
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "mailto:someone@example.com",
    "zcode://oauth/callback?code=x",
  ];

  for (const input of blocked) {
    assert.equal(resolveMermaidExternalLinkUrl(input), null, input);
  }
});

test("没有可信基准的输入一律拒绝(协议相对/相对路径/纯锚点/空值)", () => {
  const blocked: Array<string | null | undefined> = [
    "//example.com/protocol-relative",
    "/relative/path",
    "#anchor",
    "",
    "   ",
    null,
    undefined,
  ];

  for (const input of blocked) {
    assert.equal(resolveMermaidExternalLinkUrl(input), null, String(input));
  }
});
