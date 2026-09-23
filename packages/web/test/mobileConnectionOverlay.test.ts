import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * 断线/未授权覆盖层的窄屏与「假装可用」回归（task-22 阶段 2 / ④⑤）。
 *
 * 审计实测（390 宽）：旧实现只有 56px 顶部条 —— 它盖住应用头部按钮（y=14..42）导致点不到，
 * 而其余区域照旧可点却是死交互（用户会以为是自己点错）。这里钉三件事：
 * 1) 覆盖层铺满视口以阻断指针；2) 状态条在窄屏可换行；3) 未授权态仍然不渲染应用内容。
 *
 * 运行：cd packages/web && node --import tsx --test test/mobileConnectionOverlay.test.ts
 */

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

function readSource(relativePath: string): string {
  return readFileSync(join(packageRoot, relativePath), "utf8");
}

test("覆盖层铺满视口（阻断死交互），且保留既有 testid/相位标记", () => {
  const source = readSource("src/ConnectionStatusOverlay.tsx");
  assert.match(source, /data-testid="web-connection-overlay"/);
  assert.match(source, /data-connection-phase=\{phase\}/);
  assert.match(source, /inset: 0,/);
  // 阻断指针：整层固定铺满（半透明底），不是只占顶部的状态条。
  assert.match(source, /position: "fixed",\s*inset: 0,/);
});

test("状态条在窄屏可换行（否则标题与详情并排各占一条缝）", () => {
  const source = readSource("src/ConnectionStatusOverlay.tsx");
  assert.match(source, /flexWrap: "wrap"/);
  assert.match(source, /rowGap: /);
});

test("未授权时不得渲染应用内容（this is the guard that must not regress）", () => {
  const source = readSource("src/WebAppRoot.tsx");
  assert.match(source, /\{session && !unauthorized \? \(/);
  // 未授权相位必须仍然交给覆盖层，不得被折进「正在重连」。
  assert.match(source, /phase=\{unauthorized \? "unauthorized" : connection\.phase\}/);
});

test("授权探测按 attempt 重试（不能一个相位只探一次），且探测有超时上限", () => {
  const root = readSource("src/WebAppRoot.tsx");
  assert.match(root, /createAuthorizationProbeController\(\{/);
  assert.match(
    root,
    /authorizationProbe\.notifyConnectionState\(connection\.phase, connection\.attempt\)/,
  );
  // effect 依赖必须含 connection.attempt：否则「探测落在服务重启窗口」之后不会再探，
  // 页面会永远停在「正在重连」，而服务其实已经在用 401 拒绝它。
  assert.match(root, /\}, \[authorizationProbe, connection\.attempt, connection\.phase\]\);/);
  assert.match(root, /AbortSignal\.timeout\(AUTHORIZATION_PROBE_TIMEOUT_MS\)/);

  const controller = readSource("src/authorizationProbeController.ts");
  assert.match(controller, /if \(lastProbedAttempt !== null && attempt <= lastProbedAttempt\) \{/);
  assert.match(controller, /reset\(\) \{/);
});

test("viewports 声明 interactive-widget=resizes-content（软键盘收缩布局视口）", () => {
  const html = readSource("index.html");
  assert.match(html, /interactive-widget=resizes-content/);
  // 带宽度的 viewport 声明仍在（移动端不得退回默认布局视口）。
  assert.match(html, /width=device-width, initial-scale=1\.0/);
});
