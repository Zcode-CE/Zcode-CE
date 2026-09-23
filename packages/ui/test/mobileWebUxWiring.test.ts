import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
// 两个 locale 文件都是 default 导出（与 IntlProvider 的加载方式一致）。
import zhCN from "../src/i18n/locales/zh-CN.js";
import enUS from "../src/i18n/locales/en-US.js";

/**
 * 手机 / 触屏 Web 端体验修复的 UI 接线回归。
 *
 * 这些都是**渲染路径上的接线约束**：漏掉任何一处只会在真机上表现为
 * 「操作栏找不到」「tooltip 显示 key 原文」「http 远控下复制静默失败」，
 * 类型检查和桌面端手测都发现不了。用源码断言锁死，比拉完整 React 渲染树便宜。
 *
 * 运行：cd packages/ui && node --import tsx --test test/mobileWebUxWiring.test.ts
 */

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

function readSource(relativePath: string): string {
  return readFileSync(join(packageRoot, relativePath), "utf8");
}

/** 触屏（无 hover）设备上让 opacity-0 操作栏常显的类。 */
const TOUCH_VISIBLE_CLASS = "[@media(hover:none)]:opacity-100";

/** 找到包含 `anchor` 的那一行（操作栏 className 与其 hover 分组锚点写在同一行）。 */
function linesContaining(source: string, anchor: string): string[] {
  return source.split("\n").filter((line) => line.includes(anchor));
}

test("「复制完整回复」文案在两个 locale 中都存在（点分后缀命名）", () => {
  assert.equal(enUS["chat.message.copy.fullResponse"], "Copy full response");
  assert.equal(zhCN["chat.message.copy.fullResponse"], "复制完整回复");
  // 旧的驼峰 key 已改名，不得残留。
  assert.equal("chat.message.copyFullResponse" in enUS, false);
  assert.equal("chat.message.copyFullResponse" in zhCN, false);
});

test("轮尾工具栏的复制按钮使用 chat.message.copy.fullResponse", () => {
  const source = readSource("src/v4/ConversationRowView.tsx");
  assert.match(
    source,
    /copyScope === "turn" \? "chat\.message\.copy\.fullResponse" : "chat\.message\.copy"/,
  );
});

test("ConversationRowView：用户行与助手行的操作栏在触屏上常显", () => {
  const source = readSource("src/v4/ConversationRowView.tsx");
  for (const anchor of [
    "group-hover/user-row:opacity-100",
    "group-hover/assistant-row:opacity-100",
  ]) {
    const lines = linesContaining(source, anchor);
    assert.equal(lines.length, 1, `${anchor} 应只出现在一个操作栏上`);
    assert.ok(
      lines[0]?.includes(TOUCH_VISIBLE_CLASS),
      `${anchor} 的操作栏缺少 ${TOUCH_VISIBLE_CLASS}`,
    );
  }
});

test("ConversationTurnGroup：轮尾操作栏（完整操作栏与仅 hook 操作栏）在触屏上常显", () => {
  const source = readSource("src/v4/ConversationTurnGroup.tsx");
  const lines = linesContaining(source, "group-hover/assistant-turn:opacity-100");
  assert.equal(lines.length, 2, "轮尾应有两处 hover 显隐的操作栏");
  for (const line of lines) {
    assert.ok(
      line.includes(TOUCH_VISIBLE_CLASS),
      `轮尾操作栏缺少 ${TOUCH_VISIBLE_CLASS}：${line.trim()}`,
    );
  }
  assert.match(source, /copyScope="turn"/, "轮尾复制必须标记为整轮复制");
});

test("CopyRowAction 走剪贴板 helper，且处理写入失败（不留 unhandled rejection）", () => {
  const source = readSource("src/v4/ConversationRowView.tsx");
  const handler = source.slice(
    source.indexOf("const CopyRowAction = memo("),
    source.indexOf("type UserInputEditHandler"),
  );
  assert.match(handler, /operation: \(\) => writeTextToClipboard\(text\)/);
  assert.equal(
    /navigator\.clipboard[.?]/.test(handler),
    false,
    "CopyRowAction 不应再直接依赖 navigator.clipboard",
  );
  // .then(onFulfilled, onRejected)：失败分支必须存在。
  assert.match(handler, /\(error: unknown\) => \{[\s\S]*?logger\.warn\(/);
});

test("Web 顶栏的侧栏切换按钮不宣传快捷键（手机上无法按）", () => {
  const source = readSource("src/DesktopTopOverlay.tsx");
  const start = source.indexOf("{!isDesktop && (");
  assert.notEqual(start, -1, "Web 分支的侧栏切换按钮应存在");
  const end = source.indexOf(")}", start);
  const webBranch = source.slice(start, end);
  assert.match(webBranch, /testId="web-top-toggle-sidebar"/);
  assert.equal(/shortcut=/.test(webBranch), false, "Web 分支不得传 shortcut");
});

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      files.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(name)) {
      files.push(full);
    }
  }
  return files;
}

test("document.execCommand 只允许出现在 src/lib/clipboardText.ts", () => {
  const offenders = collectSourceFiles(join(packageRoot, "src"))
    .filter((file) => /\bexecCommand\s*\(/.test(readFileSync(file, "utf8")))
    .map((file) => relative(packageRoot, file).split("\\").join("/"));
  assert.deepEqual(offenders, ["src/lib/clipboardText.ts"]);
});
