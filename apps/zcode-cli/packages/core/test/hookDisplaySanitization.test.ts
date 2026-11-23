/**
 * 钩子拦截提示的脱敏（display-metadata.ts）。
 *
 * 约束：拦截原因、stderr/stdout 预览、执行描述都会进持久化投影与客户端提示，
 * 命令里常见的 token / password / secret 不能原样落盘。规则与上游 v3.18.2 的
 * `core/src/hooks/display-metadata.ts` 逐字节一致，本文件是不让它悄悄退化的回归护栏。
 *
 * 运行：cd apps/zcode-cli/packages/core && \
 *   mise exec node@24.14.0 -- node --import tsx --test test/hookDisplaySanitization.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { HookConfig } from "@zcode/contracts";
import {
  createHookExecutionDescriptor,
  sanitizeHookDisplayText,
} from "../src/hooks/display-metadata.js";

const MASK = "••••";

const SECRET_CASES: ReadonlyArray<[string, string]> = [
  ["GITHUB_TOKEN=ghp_secret1 hook.sh", "ghp_secret1"],
  ['{"password":"hunter2"}', "hunter2"],
  ["Authorization: Bearer bearer-token-3", "bearer-token-3"],
  ["postgres://user:pass4@db.internal/app", "pass4"],
  ["deploy --api-key sk-live-5", "sk-live-5"],
];

test("钩子拦截提示：token / password / secret 类取值一律脱敏", () => {
  for (const [raw, secret] of SECRET_CASES) {
    const masked = sanitizeHookDisplayText(raw);
    assert.ok(masked.includes(MASK), `${raw} 应被掩码，实际：${masked}`);
    assert.ok(!masked.includes(secret), `${raw} 泄漏了凭据：${masked}`);
  }
});

test("钩子拦截提示：执行描述里的命令行同样脱敏", () => {
  // process 形态：command + args 拼成展示串；命令行里的凭据不能原样进描述。
  const processHook = {
    args: ["--token", "tok_secret_6"],
    command: "deploy.sh",
    type: "process",
  } as unknown as HookConfig;
  const processDescriptor = createHookExecutionDescriptor(processHook, 1_000);
  assert.ok(processDescriptor.commandDisplay.includes(MASK), processDescriptor.commandDisplay);
  assert.ok(!processDescriptor.commandDisplay.includes("tok_secret_6"), processDescriptor.commandDisplay);

  // command 形态：整条 shell 串同样过掩码。
  const commandHook = {
    command: "deploy.sh --token tok_secret_7",
    type: "command",
  } as unknown as HookConfig;
  const commandDescriptor = createHookExecutionDescriptor(commandHook, 1_000);
  assert.ok(!commandDescriptor.commandDisplay.includes("tok_secret_7"), commandDescriptor.commandDisplay);
});