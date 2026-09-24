import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * 关闭引导必须落盘的接线护栏（task-108）。
 *
 * 为什么用源码断言而不是渲染树：这条约束的回归后果是纯用户观感，类型检查看不见 ——
 * closeOnboarding 只 setDismissed(true) 改组件 state 时，引导当次会话确实消失，
 * 但记录文件里什么都没有，重启后 shouldOnboard 读不到记录 ⇒ 又弹一次。
 * 这正是 commit 8225921 声称修过（"关闭后重启不重复出现"）、实际未接通的症状：
 * 服务侧的 dismissOnboarding 在本仓库当时零调用点（全仓只有接口声明与实现）。
 *
 * 反向验证：删掉 closeOnboarding 里的 dismissOnboarding 调用 ⇒ 本文件断言变红。
 *
 * 运行：cd packages/ui && node --import tsx --test test/onboardingDismissWiring.test.ts
 */

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const SOURCE = "src/onboarding/OccupationOnboarding.tsx";

function readSource(): string {
  return readFileSync(join(packageRoot, SOURCE), "utf8");
}

/** 取 closeOnboarding 这个 useCallback 的完整源码片段（从声明到依赖数组结束）。 */
function closeOnboardingBody(source: string): string {
  const start = source.indexOf("const closeOnboarding = useCallback(");
  assert.notEqual(start, -1, "closeOnboarding 必须仍以 useCallback 形式存在");
  const end = source.indexOf("}, [", start);
  assert.notEqual(end, -1, "closeOnboarding 必须仍有依赖数组");
  const depsEnd = source.indexOf("]);", end);
  return source.slice(start, depsEnd === -1 ? undefined : depsEnd + 3);
}

test("closeOnboarding 必须调用 dismissOnboarding 把关闭动作落盘", () => {
  const body = closeOnboardingBody(readSource());
  assert.match(
    body,
    /onboardingRecord\.dismissOnboarding\(\)/,
    "关闭引导必须落盘（只改组件 state 会导致重启后又弹）",
  );
});

test("dismissOnboarding 的调用必须有 catch，RPC 失败不得变成未处理拒绝", () => {
  const body = closeOnboardingBody(readSource());
  assert.match(body, /\.catch\(/, "dismissOnboarding 走 RPC，失败必须被捕获并留日志");
});

test("onboardingRecord 为 null 时必须跳过调用（旧测试 double / 未注册 host）", () => {
  const body = closeOnboardingBody(readSource());
  assert.match(body, /if \(onboardingRecord\)/, "服务不可用时不得直接调用");
});

test("依赖数组必须含 onboardingRecord，避免闭包捕获过期的服务实例", () => {
  const body = closeOnboardingBody(readSource());
  const deps = body.slice(body.lastIndexOf("}, ["));
  assert.match(deps, /onboardingRecord/, "onboardingRecord 必须进依赖数组");
});
