import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  zcodeAutomationBotDeliveryTargetSchema,
  type ZCodeAutomationBotDeliveryTarget,
} from "@zcode/shared";
import { zcodeAutomationCreateParamsSchema } from "@zcode/shared";
import { AutomationRepo } from "../src/session/automationRepo.js";

/**
 * botDeliveryTarget 消费链（ce.5）：从协议面到落库的护栏。
 *
 * 背景（.reverse/98-ce4/IMPL-BOT-DELIVERY-TARGET.md）：wire 层早已就位，但消费端全线缺失
 * ⇒ 静默丢弃不报错。本测试按 spec §5 的 B1/B2/B3 判据钉住三个点：
 * 1. B1 落库：create 带 botDeliveryTarget ⇒ 真实 sqlite 的 bot_delivery_target 列写入，
 *    且 getBotDeliveryTarget 能按 scheduler 终态回推的路径读回（不停在 safeParse 层）。
 * 2. B2 完整性：provider/botId/providerUserId/chatType 四字段逐字保留。
 * 3. B3 反向牙齿：两个 v1 schema 都是 .strict()——删除 botDeliveryTarget 声明会让带值请求
 *    被拒绝（不是剥离）；因此「键被删」时本测试变红而不是静默绿
 *    （zod 剥离教训见 IMPL-BOT-DELIVERY-TARGET.md §4.1）。
 *
 * 运行：cd packages/services && node --import tsx --test test/automationBotDeliveryTarget.test.ts
 */

const packageRoot = new URL("../", import.meta.url);

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, packageRoot), "utf8");
}

const DELIVERY_TARGET: ZCodeAutomationBotDeliveryTarget = {
  provider: "feishu",
  botId: "bot-9f3c",
  providerUserId: "ou_123456",
  chatType: "private",
};

function createBaseParams(overrides: Record<string, unknown> = {}) {
  return {
    title: "bot 回推任务",
    cronExpr: "* * * * *",
    prompt: "每日构建摘要",
    workspacePath: "/home/u/proj",
    recurring: true,
    ...overrides,
  };
}

test("B1+ B2：create 带 botDeliveryTarget ⇒ 落库且 getBotDeliveryTarget 原样读回", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bot-delivery-"));
  const repo = new AutomationRepo(join(dir, "index.sqlite"));
  try {
    const automation = await repo.create(
      {
        ...createBaseParams(),
        botDeliveryTarget: DELIVERY_TARGET,
      },
      { nextRunAt: 1, lifecycleStatus: "active" },
    );
    assert.ok(automation.automationId, "automation 必须创建成功");

    // 直接验证最终消费点：sqlite 行里的 bot_delivery_target 列。
    const db = new DatabaseSync(join(dir, "index.sqlite"));
    try {
      const row = db
        .prepare("SELECT bot_delivery_target AS v FROM automations WHERE automation_id = ?")
        .get(automation.automationId) as { v: string | null };
      assert.ok(row.v, "bot_delivery_target 列必须非空（INSERT 真的写了）");
      const raw = JSON.parse(row.v) as Record<string, unknown>;
      assert.equal(raw.provider, "feishu");
      assert.equal(raw.botId, "bot-9f3c");
      assert.equal(raw.providerUserId, "ou_123456");
      assert.equal(raw.chatType, "private");
    } finally {
      db.close();
    }

    // scheduler 终态回推的读回路径。
    const read = await repo.getBotDeliveryTarget(automation.automationId);
    assert.deepEqual(read, DELIVERY_TARGET, "getBotDeliveryTarget 必须原样返回四字段");
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("B1（无值路径）：不带 botDeliveryTarget ⇒ 列为 NULL，读回 undefined，不报错", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bot-delivery-"));
  const repo = new AutomationRepo(join(dir, "index.sqlite"));
  try {
    const automation = await repo.create(createBaseParams(), { nextRunAt: 1 });
    const read = await repo.getBotDeliveryTarget(automation.automationId);
    assert.equal(read, undefined, "未配置时必须返回 undefined（不是抛错）");
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("脏 JSON 不拖垮 scheduler：getBotDeliveryTarget 按未配置处理", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bot-delivery-"));
  const repo = new AutomationRepo(join(dir, "index.sqlite"));
  try {
    const automation = await repo.create(
      { ...createBaseParams(), botDeliveryTarget: DELIVERY_TARGET },
      { nextRunAt: 1 },
    );
    // 直接写一个损坏值，模拟历史/外部写入。
    const db = new DatabaseSync(join(dir, "index.sqlite"));
    try {
      db.prepare("UPDATE automations SET bot_delivery_target = ? WHERE automation_id = ?").run(
        "{not json",
        automation.automationId,
      );
    } finally {
      db.close();
    }
    const read = await repo.getBotDeliveryTarget(automation.automationId);
    assert.equal(read, undefined, "脏 JSON 必须降级为未配置，不抛错");
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("B3：v1 automationCreate schema 收下 botDeliveryTarget 且保留该键（strict，不是剥离）", () => {
  // v1 schema 只含协议面字段（workspace 由 host 从 session 注入，不在协议面）。
  const protocolParams = {
    cronExpr: "* * * * *",
    prompt: "每日构建摘要",
    botDeliveryTarget: DELIVERY_TARGET,
  };
  const parsed = zcodeAutomationCreateParamsSchema.safeParse(protocolParams);
  assert.ok(parsed.success, "合法 params 必须通过");
  if (parsed.success) {
    assert.deepEqual(
      parsed.data.botDeliveryTarget,
      DELIVERY_TARGET,
      "parse 后 botDeliveryTarget 必须活着（不是被剥离成 undefined）",
    );
  }
  // strict 证明：同 schema 对未知键是拒绝。若有人删掉 botDeliveryTarget 声明，
  // 上面那条带值请求会落进这个分支 ⇒ 上游断言变红（而不是静默通过）。
  const rejected = zcodeAutomationCreateParamsSchema.safeParse(
    createBaseParams({ botDeliveryTarget: DELIVERY_TARGET, surprisesAreRejected: true }),
  );
  assert.equal(rejected.success, false, "strict schema 必须拒绝未知键 ⇒ 声明是 load-bearing");
});

test("zcodeAutomationBotDeliveryTargetSchema 本体校验：四字段缺一不可", () => {
  assert.ok(
    zcodeAutomationBotDeliveryTargetSchema.safeParse(DELIVERY_TARGET).success,
    "合法目标必须通过",
  );
  for (const key of ["provider", "botId", "providerUserId", "chatType"] as const) {
    const partial = { ...DELIVERY_TARGET } as Record<string, unknown>;
    delete partial[key];
    assert.equal(
      zcodeAutomationBotDeliveryTargetSchema.safeParse(partial).success,
      false,
      "缺 " + key + " 必须拒绝",
    );
  }
});

/**
 * 源码级链路护栏（各跳的转发/声明必须在场）。
 *
 * 为什么用源码断言而不跑全链路：adapter 与 protocol server 的端到端装配需要完整 runtime，
 * 而断链的失效模式恰恰是「编译通过、值被静默丢弃」——源码里每一跳的转发语句就是可检查的
 * 最小证据。判据不是「函数存在」，而是「转发语句带着 botDeliveryTarget 字面量出现在正确位置」。
 */
test("源码护栏：消费链每一跳的转发/声明都在场", () => {
  const adapter = readSource("src/zcode-agent/zcodeTaskServiceAdapter.ts");
  assert.ok(
    adapter.includes("botDeliveryTarget?: ZCodeAutomationBotDeliveryTarget;"),
    "sendPromptToAgent 入参必须声明 botDeliveryTarget（#10 :385）",
  );
  assert.ok(
    adapter.includes("botDeliveryTarget: params.botDeliveryTarget,"),
    "adapter 必须转发 botDeliveryTarget（#10 :436/:1934）",
  );

  const agentService = readSource("src/zcode-agent/zcodeAgentService.ts");
  assert.ok(
    agentService.includes('"botDeliveryTarget"'),
    "降级重试白名单必须含 botDeliveryTarget（#9 compat 清单）",
  );
  assert.ok(
    agentService.includes("botDeliveryTarget: parsed.data.botDeliveryTarget,"),
    "CronCreate 必须把 parsed.data.botDeliveryTarget 交给 automationService.create（#8）",
  );

  const agent = readSource("src/zcode-agent/zcodeAgent.ts");
  assert.ok(
    agent.includes("botDeliveryTarget?: ZCodeAutomationBotDeliveryTarget;"),
    "ZCodeAgentSendPromptParamsBase 必须声明该字段（#11）",
  );

  const types = readSource("../shared/src/automation-types.ts");
  assert.ok(
    types.includes("botDeliveryTarget?: ZCodeAutomationBotDeliveryTarget;"),
    "ZCodeAutomationCreateParams 必须声明该字段（#6）",
  );
});
