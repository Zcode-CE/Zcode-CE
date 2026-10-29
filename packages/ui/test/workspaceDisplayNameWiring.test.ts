import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * B′ 展示名接线护栏：设置里改了展示名，侧栏必须真的显示它。
 *
 * 这三处任意一处漏改，失效形态都是静默的：设置页保存成功、侧栏还是目录名。
 * 组件依赖整棵会话树，不适合在 node:test 里真渲染，所以断言源码级接线。
 */

const here = dirname(fileURLToPath(import.meta.url));
const itemSource = readFileSync(resolve(here, "../src/WorkspaceSidebarItem.tsx"), "utf8");
const sidebarSource = readFileSync(resolve(here, "../src/WorkspaceSidebar.tsx"), "utf8");
const sortableSource = readFileSync(resolve(here, "../src/SortableWorkspaceSidebar.tsx"), "utf8");

test("侧栏行优先使用展示名，回落 tab.label", () => {
  assert.match(itemSource, /displayNameOverride\?\.trim\(\) \|\| tab\.label/u);
});

test("侧栏从设置读取 workspaceDisplayNames 并传给两种行渲染", () => {
  assert.match(sidebarSource, /useSettings\(/u);
  assert.match(sidebarSource, /workspaceDisplayNames\?\./u);
  const passes = sidebarSource.match(/displayNameOverride=\{/gu)?.length ?? 0;
  assert.ok(passes >= 2, `可拖拽行与注册表行都应传 displayNameOverride，实际 ${passes} 处`);
});

test("可拖拽包装层把展示名透传到行组件", () => {
  assert.match(sortableSource, /displayNameOverride=\{displayNameOverride\}/u);
});
