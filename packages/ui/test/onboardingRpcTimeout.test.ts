import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { withOnboardingRpcTimeout } from "../src/onboarding/withOnboardingRpcTimeout.js";

/**
 * onboarding 记录服务 RPC 的超时兜底（C47）。
 *
 * 钉住三件事：
 * 1. 永不结算的 promise（host 未注册 channel / 链路无响应的真实形态）必须被超时
 *    强制落定，且错误带来源标签——appendRecord 挂住会让保存按钮永远转圈，
 *    dismissOnboarding 挂住则留下永不回收的 promise；
 * 2. 正常路径不得被超时改写（先 resolve 的赢）；
 * 3. 默认 5s 是产品规则（与 appendRecord 原先的内联超时同一数值），不得静默漂移。
 *
 * 判别实验（判据不是源码推理）：dismissOnboarding 的 promise 挂起时，旧实现的
 * fire-and-forget + catch 拿不到任何落定；包一层 race 后 5s 必落定。
 *
 * 运行：cd packages/ui && node --import tsx --test test/onboardingRpcTimeout.test.ts
 */

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

test("永不结算的 promise 在超时后被强制拒绝，且错误信息带来源标签", async () => {
  const neverSettles = new Promise<void>(() => {});
  await assert.rejects(
    () => withOnboardingRpcTimeout(neverSettles, "dismissOnboarding", 20),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /dismissOnboarding timeout/);
      return true;
    },
  );
});

test("正常 resolve 的 promise 先于超时赢（不改写成功路径）", async () => {
  const result = await withOnboardingRpcTimeout(Promise.resolve("saved"), "appendRecord", 5000);
  assert.equal(result, "saved");
});

test("默认超时是 5s（产品规则，不得漂移）", () => {
  const source = readFileSync(
    join(packageRoot, "src/onboarding/withOnboardingRpcTimeout.ts"),
    "utf-8",
  );
  assert.match(source, /timeoutMs = 5000/, "默认超时必须是 5000ms");
});

test("接线护栏：closeOnboarding 的 dismissOnboarding 必须经过超时兜底", () => {
  const source = readFileSync(
    join(packageRoot, "src/onboarding/OccupationOnboarding.tsx"),
    "utf-8",
  );
  const start = source.indexOf("const closeOnboarding = useCallback(");
  assert.notEqual(start, -1, "closeOnboarding 必须仍以 useCallback 形式存在");
  const end = source.indexOf("}, [", start);
  assert.notEqual(end, -1, "closeOnboarding 必须仍有依赖数组");
  const body = source.slice(start, source.indexOf("]);", end) + 3);
  assert.match(
    body,
    /withOnboardingRpcTimeout\(\s*onboardingRecord\.dismissOnboarding\(\)/,
    "dismissOnboarding 的 promise 必须包在超时兜底里（C47）",
  );
  assert.match(body, /\.catch\(/, "超时 / RPC 失败仍必须被捕获并留日志");
});
