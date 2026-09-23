import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * 手机窄屏（390/360）布局的接线回归（task-22 阶段 2）。
 *
 * 这些断言钉住的是**只在窄屏才暴露**的接线：类型检查与桌面手测都发现不了它们，
 * 而回归后的表现是「手机上读不全、发不出、点不到」——
 * 例如 main content 重新拿回 `min-w-[320px]` 下限后，390 视口下主内容区右侧
 * 会被外壳的 overflow-hidden 裁掉 129px 且无法滚动到（审计实测）。
 *
 * 运行：cd packages/ui && node --import tsx --test test/mobileNarrowLayout.test.ts
 */

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

function readSource(relativePath: string): string {
  return readFileSync(join(packageRoot, relativePath), "utf8");
}

test("主内容区不再有 320px 最小宽度下限（窄屏会被外壳裁掉拿不回来）", () => {
  const source = readSource("src/app-shell/WorkspaceShellLayout.tsx");
  // 只看代码行：说明性注释里会引用这个类名（历史原因），不该被当成接线断言。
  const codeLines = source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"));
  assert.equal(
    codeLines.some((line) => line.includes("min-w-[320px]")),
    false,
    "min-w-[320px] 会让 390 视口下的主内容区被 overflow-hidden 裁掉且无法滚动到",
  );
  assert.match(source, /"flex min-w-0 flex-1 flex-col"/);
});

test("窄屏首次进入自动收起侧栏（阈值 768 + 只判定一次）", () => {
  const source = readSource("src/app-shell/WorkspaceShellLayout.tsx");
  assert.match(source, /const NARROW_SHELL_AUTO_COLLAPSE_WIDTH_PX = 768;/);
  // 只在本次挂载判定一次：用 ref 而不是按 workspaceKey 记账。
  // （按 key 记账会让「第一次点侧栏开关」被立刻收回 —— 开关看起来点了没反应。）
  assert.match(source, /const narrowAutoCollapseDecidedRef = useRef\(false\);/);
  assert.match(source, /if \(narrowAutoCollapseDecidedRef\.current\) \{\s*return;\s*\}/);
  assert.match(source, /narrowAutoCollapseDecidedRef\.current = true;/);
  assert.equal(
    source.includes("narrowAutoCollapsedWorkspaceKeys"),
    false,
    "不要再用按 workspaceKey 记账的集合判定（会产生「点了没反应」的开关）",
  );
  assert.match(source, /handleToggleSidebar\(\);/);
});

test("窄视口判定用 max-width: 767px，且头部简化只在 web 路径生效", () => {
  const source = readSource("src/app-shell/WorkspaceShellLayout.tsx");
  assert.match(source, /const NARROW_VIEWPORT_MEDIA_QUERY = "\(max-width: 767px\)";/);
  assert.match(source, /simplifyForNarrowRemote=\{!isDesktop && isNarrowViewport\}/);
  // 桌面应用窗口（isDesktop）不得被简化：否则 1280 的桌面对照会出现差异。
  assert.equal(/simplifyForNarrowRemote=\{isNarrowViewport\}/.test(source), false);
});

test("窄屏隐藏顶部浮层的任务前进/后退（为标题腾宽度）", () => {
  const source = readSource("src/app-shell/WorkspaceShellLayout.tsx");
  assert.match(source, /hideTaskNavigationButtons=\{isNarrowViewport\}/);
});

test("触屏上顶部浮层按钮命中区补到 44px，且不改变非触屏路径", () => {
  const source = readSource("src/DesktopTopOverlayActionButton.tsx");
  assert.match(source, /\[@media\(pointer:coarse\)\]:size-11/);
});

test("设置行默认档在窄屏堆叠（否则标签列被压到 46px、中文断成两行）", () => {
  const source = readSource("src/settings/SettingsPageParts.tsx");
  assert.match(source, /"grid-cols-1 sm:grid-cols-\[minmax\(0,1fr\)_192px\]"/);
  // wide 档此前就有窄屏兜底，保持一致。
  assert.match(source, /"grid-cols-1 sm:grid-cols-\[minmax\(0,1fr\)_280px\]"/);
});
