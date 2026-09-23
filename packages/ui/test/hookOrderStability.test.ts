import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Hook 顺序稳定性（task-29 回归）。
 *
 * ## 为什么需要这条断言
 * web 客户端**每次加载**都会在控制台抛一条渲染期错误，并把 `OnboardingDialog` 整棵子树交给
 * ScopedErrorBoundary 重建（用户可见：引导弹窗被炸掉后重挂）：
 *
 * ```text
 * TypeError: Cannot read properties of undefined (reading 'length')
 *   at areHookInputsEqual (react-dom …)      ← React 的 areHookInputsEqual 读 undefined.length
 *   at updateCallback → Object.useCallback
 *   at useStore (zustand) → useTabStore → useResolvedRemoteWorkspaceSessionId
 *   at useWorkspaceServices → useZCodeSessionService
 * ```
 *
 * 根因不是 zustand，而是**同一个组件实例在两次渲染间换了 hook 序列**：
 * `useZCodeAgentService / useZCodeSessionService / useZCodeTaskService` 曾写成
 * `workspacePath ? useWorkspaceServices(...) : useServices()` —— 三元两侧是**不同的 hook**
 * （一侧只有 useServices()=useContext，另一侧是 useServices + useTabStore + 两个 zustand store，
 * 8+ 个槽位）。当 workspacePath 由「未解析」变「已解析」，后续槽位错位：React 按 useCallback
 * 取 prevDeps 时拿到的是 `useRef`/`useState` 的 memoizedState，于是读 `undefined.length`。
 *
 * 实测证据（dev 构建，390×844，React 会额外打印 hook 表）：
 * `React has detected a change in the order of Hooks called by OnboardingDialog`，第 8 项分叉
 * `useRef → useContext`（= useSettingsSync 的 runningImportRef 换成了 useTabStore）。
 *
 * ## 这条断言钉什么
 * ① 结构性：`packages/ui/src` 里**任何** React hook 都不得出现在三元/逻辑表达式的分支位置
 *    （这是该缺陷的形态，不是这一处的特例）；
 * ② 精确性：上列三个 hook 必须**无条件**同时调用两个解析入口，防止有人用别的方式把分支写回来。
 *
 * 它不能替代真浏览器证据（prod 构建里 React 不打印 hook 表，只留下崩溃），
 * 真浏览器那条见 `packages/web/test/webLoadConsoleErrors.test.ts`。
 */

const uiSrcRoot = fileURLToPath(new URL("../src/", import.meta.url));

function collectSourceFiles(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, found);
      continue;
    }
    if (/\.tsx?$/.test(name)) found.push(full);
  }
  return found;
}

/** 三元 / `&&` / `||` 之后紧跟 hook 调用。 */
const CONDITIONAL_HOOK_PATTERN = /(?:\?|\|\||&&)\s*(use[A-Z][A-Za-z0-9_]*)\s*\(/g;

test("packages/ui/src 内不得条件化调用 React hook（hook 槽位必须恒定）", () => {
  const violations: string[] = [];
  for (const file of collectSourceFiles(uiSrcRoot)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      // 注释里的示例不算违规。
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      // 可选链 `?.useXxx` 不是 hook 调用分支。
      if (/\?\.\s*use[A-Z]/.test(line)) return;
      for (const match of line.matchAll(CONDITIONAL_HOOK_PATTERN)) {
        violations.push(`${relative(uiSrcRoot, file)}:${index + 1} ${match[1]}() | ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(
    violations,
    [],
    "hook 不得出现在三元/逻辑分支里（会让 hook 槽位在两渲染间错位，表现为 areHookInputsEqual 读 undefined.length）",
  );
});

test("三个服务解析 hook 必须无条件调用两侧解析入口（防止把分支写回来）", () => {
  for (const relativePath of [
    "hooks/useZCodeAgentService.ts",
    "hooks/useZCodeSessionService.ts",
    "hooks/useZCodeTaskService.ts",
  ]) {
    const source = readFileSync(join(uiSrcRoot, relativePath), "utf8");
    assert.ok(
      /const workspaceServices = useWorkspaceServices\s*\(/.test(source),
      relativePath + " 必须无条件调用 useWorkspaceServices（不能放在三元分支里）",
    );
    assert.ok(
      /const contextServices = useServices\(\)/.test(source),
      relativePath + " 必须无条件调用 useServices()（不能放在三元分支里）",
    );
    assert.ok(
      /workspacePath \? workspaceServices : contextServices/.test(source),
      relativePath + " 必须在两者都调用之后按 workspacePath 选择（选择本身不含 hook）",
    );
  }
});
