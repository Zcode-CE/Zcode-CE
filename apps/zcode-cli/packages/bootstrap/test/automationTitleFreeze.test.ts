import assert from "node:assert/strict";
import test from "node:test";
import { zcodeProtocolMethods, type ZCodeAutomationProtocol } from "@zcode/shared";
import { createProtocolAutomationPort } from "../src/zcode-protocol/automation-port.js";
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "../src/zcode-protocol/server-types.js";
import type { ZCodeApp } from "../src/app/types.js";
import type { TraceContext } from "@zcode/contracts";

/**
 * T2 单测（zcode-plugins issue #60 / .reverse/102 T2）：CronCreate 标题冻结。
 *
 * 修复前 automation-port 在 CronCreate 成功后无条件 setCustomSessionTitle，
 * 不检查 titleSource——用户手动命名被 automation 标题反复覆盖（实测一天 4 次）。
 * 修复后冻结路径传 expectedTitleSources（default/first_input/generated，
 * 与 core persistGeneratedSessionTitle 的乐观锁同口径），custom 标题被原子跳过。
 *
 * 本测试断言协议边界确实传递期望源；custom 跳过行为在 core 单测
 *（runtimeTaskBranchFencing.test.ts）中按同一假 store 口径验证。
 *
 * 运行：cd apps/zcode-cli/packages/bootstrap && node --import tsx --test test/automationTitleFreeze.test.ts
 */

const AUTOMATION: ZCodeAutomationProtocol = {
  automationId: "automation_1",
  title: "每日构建",
  cronExpr: "0 9 * * *",
  prompt: "跑构建",
  enabled: true,
  lifecycleStatus: "active",
  nextRunAt: 1_800_000_000_000,
  lastRunAt: undefined,
  runCount: 0,
  recurring: true,
};

interface TitleFreezeCall {
  title: string;
  expectedTitleSources?: readonly string[];
}

function makeRecord(options: { titleFreezeCalls: TitleFreezeCall[] }): ZCodeProtocolSessionRecord {
  const app = {
    sessionId: "task-session-1",
    getMode: () => "build",
    runtime: {
      getSessionModelSelection: () => undefined,
    },
    setCustomSessionTitle: async (input: TitleFreezeCall) => {
      options.titleFreezeCalls.push(input);
    },
  } as unknown as ZCodeApp;
  return {
    app,
    memoryEnabled: false,
    nativeSearchEnhancementsEnabled: false,
    modelContextBudgetStrategy: "default",
    createdAt: 0,
    eventStore: {} as never,
    persistence: "persistent",
    protocolEventSequences: new Map(),
    protocolToolInputTransmissions: new Map(),
    stateRevision: 0,
    traceContext: { traceId: "trace_1", spanId: "span_1" } as TraceContext,
    updatedAt: 0,
    workspace: { workspacePath: "/workspace" } as never,
  } as unknown as ZCodeProtocolSessionRecord;
}

function makeContext(): {
  context: ZCodeProtocolAgentServerContext;
  titleFreezeCalls: TitleFreezeCall[];
} {
  const titleFreezeCalls: TitleFreezeCall[] = [];
  const record = makeRecord({ titleFreezeCalls });
  const context = {
    logger: {
      warn: () => {},
    },
    sessions: new Map([["task-session-1", record]]),
    requestClient: async (method: string) => {
      if (method === zcodeProtocolMethods.automationCheckTaskBinding) {
        return { bound: false };
      }
      if (method === zcodeProtocolMethods.automationCreate) {
        return { automation: AUTOMATION };
      }
      throw new Error("unexpected protocol method: " + method);
    },
  } as unknown as ZCodeProtocolAgentServerContext;
  return { context, titleFreezeCalls };
}

test("CronCreate 成功后标题冻结传递 expectedTitleSources（custom 不被覆盖，issue #60）", async () => {
  const { context, titleFreezeCalls } = makeContext();
  const port = createProtocolAutomationPort(context, () => makeRecord({ titleFreezeCalls }));

  const automation = await port.create(
    { title: "每日构建", prompt: "跑构建", cron: "0 9 * * *" },
    { sessionId: "task-session-1" },
  );

  assert.equal(automation.title, "每日构建");
  assert.equal(titleFreezeCalls.length, 1);
  assert.equal(titleFreezeCalls[0]?.title, "每日构建");
  // 与 core persistGeneratedSessionTitle 的 GENERATED_TITLE_EXPECTED_SOURCES 同口径；
  // custom 不在其中 ⇒ 乐观锁跳过（core 单测验证跳过行为本身）。
  assert.deepEqual(titleFreezeCalls[0]?.expectedTitleSources, [
    "default",
    "first_input",
    "generated",
  ]);
});

test("无 createContext 时经 resolveOwnSession 解析归属会话并冻结标题", async () => {
  const { context, titleFreezeCalls } = makeContext();
  const record = makeRecord({ titleFreezeCalls });
  const port = createProtocolAutomationPort(context, () => record);

  await port.create({ title: "带标题任务", prompt: "跑构建", cron: "0 9 * * *" });

  // 冻结的是 automationCreate 返回结果里的标题（协议侧权威），不是工具入参的标题。
  assert.equal(titleFreezeCalls.length, 1);
  assert.equal(titleFreezeCalls[0]?.title, "每日构建");
  assert.deepEqual(titleFreezeCalls[0]?.expectedTitleSources, [
    "default",
    "first_input",
    "generated",
  ]);
});
