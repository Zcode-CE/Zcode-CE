import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fileURLToPath } from "node:url";
import zhCN from "../src/i18n/locales/zh-CN.js";
import enUS from "../src/i18n/locales/en-US.js";
import { BotGroupMemberNamesContext } from "../src/v4/BotGroupMemberNamesContext.js";
import {
  pendingTopicPreparations,
  withTopicPreparationMessages,
} from "../src/v4/topicPreparationRenderUnits.js";
import type { ConversationTurnRenderUnit } from "../src/v4/conversationTurnRenderUnitTypes.js";
import type { BotGroupInputSource, BotTopicPreparation } from "@zcode/shared";

/**
 * F8 群/话题「会话面」接线护栏（task-9）。
 *
 * 钉住三件只能靠渲染/结构证明的事：
 * 1. 群来源文案真的渲染成「飞书 · 张三」而不是键名 —— 组件引用的 19 个 bots.group/bots.topic
 *    键是搬组件时最容易漏的一环（i18nKeyCoverage 只覆盖静态字面量，动态模板族
 *    `chat.topicPreparation.${status}` 静态扫不到，这里显式列出）。
 * 2. 准备态投影的判据：已落成 CLI userInput row 的消息不再画第二份，失败材料不残留空白轮次。
 * 3. 接线两端都在场：Provider 装在会话面外层、Timeline 用准备态投影、轮次动作栏/
 *    来源标签各就位。本仓库没有「组件快照测试」传统，接线用结构断言（同
 *    botsDialogWiring.test.ts），不假装渲染整棵 SessionPane（需要 botsService 通道）。
 *
 * 运行：cd packages/ui && node --import tsx --test test/botGroupConversationWiring.test.ts
 */

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

function readSource(relativePath: string): string {
  return readFileSync(join(packageRoot, relativePath), "utf8");
}

const FEISHU_LABEL = zhCN["bots.group.provider.feishu"];
assert.ok(FEISHU_LABEL, "测试前置：zh-CN 必须有 bots.group.provider.feishu");

test("i18n：F8 会话面引用的群/话题键在两份字典里都在位", () => {
  const keys = [
    // 静态引用（BotGroupSourceLabel / BotGroupDeliveryAction）。
    "bots.group.provider.feishu",
    "bots.group.deliveryFailed",
    "bots.group.deliveryUnknown",
    "bots.group.confirmReceived",
    "bots.group.confirmNotReceived",
    "bots.group.resend",
    // 本轮随 F8 一并搬入、由群同步/话题面消费的其余键。
    "bots.group.paused",
    "bots.group.sharedWorkspace",
    "bots.group.syncing",
    "bots.topic.context",
    "bots.topic.correction",
    "bots.topic.coverage",
    "bots.topic.details",
    "bots.topic.gap",
    "bots.topic.historyOff",
    "bots.topic.historyOn",
    "bots.topic.loading",
    "bots.topic.open",
    "bots.topic.unavailable",
    // 轮次状态与准备态状态族（模板拼接，静态扫描覆盖不到）。
    "chat.history.topicInterrupted",
    "chat.topicPreparation.preparing",
    "chat.topicPreparation.waitingStop",
    "chat.topicPreparation.failed",
    "chat.topicPreparation.retry",
  ];
  const missing = keys.filter((key) => !(key in zhCN) || !(key in enUS));
  assert.deepEqual(missing, [], "缺失的键会以键名显示在界面上：" + missing.join(", "));
  assert.equal(keys.filter((key) => key.startsWith("bots.group.")).length, 9);
  assert.equal(keys.filter((key) => key.startsWith("bots.topic.")).length, 10);
});

function groupSource(overrides: Partial<BotGroupInputSource> = {}): BotGroupInputSource {
  return {
    botId: "bot-1",
    provider: "feishu",
    chatId: "chat-1",
    senderId: "ou_abcdef123456",
    senderName: "张三",
    messageId: "om_1",
    ...overrides,
  };
}

test("DOM：群来源渲染成「飞书 · 姓名」，不是键名", async () => {
  const [{ BotGroupSourceLabel }, { ZCodeIntlProvider }] = await Promise.all([
    import("../src/v4/BotGroupSourceLabel.js"),
    import("../src/i18n/IntlProvider.js"),
  ]);
  const render = (source: BotGroupInputSource, names?: Record<string, string>) =>
    renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          BotGroupMemberNamesContext.Provider,
          {
            value: names ? { botId: source.botId, chatId: source.chatId, names } : null,
          },
          createElement(BotGroupSourceLabel, { source }),
        ),
      ),
    );

  // 无成员缓存：用保存时的姓名快照。
  const saved = render(groupSource());
  assert.ok(saved.includes(`${FEISHU_LABEL} · 张三`), "必须渲染渠道 + 姓名：" + saved);
  assert.ok(!saved.includes("bots.group.provider.feishu"), "不得回退成键名");
  assert.ok(saved.includes('data-bot-group-source="true"'), "来源按钮必须带可定位标记");

  // 成员缓存优先：改名后历史消息跟着更新。
  const renamed = render(groupSource(), { ou_abcdef123456: "李四" });
  assert.ok(renamed.includes(`${FEISHU_LABEL} · 李四`), "成员缓存应覆盖保存快照：" + renamed);

  // Lark 渠道不翻译品牌名。
  assert.ok(render(groupSource({ provider: "lark" })).includes("Lark · 张三"));

  // senderName 只是 senderId 的拷贝时（上游 Host 的默认形态）退到 senderId 末 6 位，不把 id 当姓名。
  const idOnly = render(
    groupSource({ senderId: "ou_9f8e7d6c5b4a", senderName: "ou_9f8e7d6c5b4a" }),
  );
  assert.ok(idOnly.includes("· 6c5b4a"), "无姓名时显示 senderId 末 6 位：" + idOnly);
  assert.ok(!idOnly.includes("· ou_9f8e7d6c5b4a"), "不得把整个 senderId 当姓名显示");
});

function preparation(overrides: Partial<BotTopicPreparation> = {}): BotTopicPreparation {
  return {
    messageId: "om_p1",
    senderName: "张三",
    text: "顺手把这个也做了",
    status: "preparing",
    ...overrides,
  };
}

test("投影：已接受的消息不再画准备态，失败材料不残留空白轮次", () => {
  const acceptedRow = {
    rowId: 7,
    turnId: "t1",
    kind: "userInput" as const,
    text: "已接受",
    createdAt: 1,
    createdAtSeq: 0,
    botGroupSource: groupSource({ messageId: "om_p1" }),
  };
  const pending = pendingTopicPreparations(
    [
      preparation(),
      preparation({ messageId: "om_p2" }),
      preparation({ messageId: "om_p3", status: "failed" }),
    ],
    [acceptedRow] as never,
  );
  assert.deepEqual(
    pending.map((item) => item.messageId),
    ["om_p2"],
    "已接受的 om_p1 与失败的 om_p3 都不再作为准备态出现",
  );
});

test("投影：准备态挂到最后一条轮次；没有 CLI 消息时只造本地展示单元", () => {
  const base: ConversationTurnRenderUnit = {
    key: "turn-1",
    turnId: "turn-1",
    visibleUserInputs: [],
    assistantWorkRows: [],
    assistantHistoryRows: [],
    assistantFollowingRows: [],
    assistantTailRows: [],
    browserTurnEndRows: [],
    hookInvocations: [],
    assistantTextRows: [],
    leadingBoundaryRows: [],
    flowItems: [],
    renderRows: [],
    isLastTurn: true,
    isRunning: true,
    assistantHistoryDefaultOpen: false,
    timelineOnly: false,
  };
  const units = withTopicPreparationMessages([base], [], [preparation()]);
  assert.equal(units.length, 1, "准备态不新增 CLI 轮次");
  assert.deepEqual(
    units[0]?.topicPreparations?.map((item) => item.messageId),
    ["om_p1"],
  );
  assert.equal(units[0]?.isRunning, true, "挂接不得改写轮次运行态");

  const created = withTopicPreparationMessages([], [], [preparation()]);
  assert.equal(created.length, 1);
  assert.equal(created[0]?.timelineOnly, true, "空会话只造只读展示单元，不落假任务");
  assert.deepEqual(created[0]?.renderRows, []);

  assert.deepEqual(withTopicPreparationMessages([base], [], []), [base], "无准备态时原样返回");
});

test("接线：会话面 Provider、准备态投影、来源标签、投递动作各就位", () => {
  const sessionPane = readSource("src/v4/SessionPane.tsx");
  assert.ok(
    sessionPane.includes("<BotGroupDeliveryProvider") && sessionPane.includes("taskId={sessionId}"),
    "SessionPane 必须用任务级 Provider 装住会话面（同一任务只订阅一次群状态）",
  );

  const timeline = readSource("src/v4/ConversationTimeline.tsx");
  assert.ok(
    timeline.includes("useBotTopicPreparations()") &&
      timeline.includes("withTopicPreparationMessages("),
    "Timeline 必须把准备态投影进 render units",
  );

  const turnGroup = readSource("src/v4/ConversationTurnGroup.tsx");
  assert.ok(
    turnGroup.includes("<BotTopicPreparation items={unit.topicPreparations}"),
    "轮次末尾必须渲染未接受的准备态",
  );
  assert.ok(
    turnGroup.includes("<ConnectedBotGroupDeliveryAction") &&
      turnGroup.includes("useBotTopicInterruption("),
    "轮次动作区必须接投递回执，并用中断原因区分「已被新消息中断」",
  );
  assert.ok(
    turnGroup.includes("has-[[data-bot-group-delivery]]:opacity-100") ||
      readSource("src/v4/ConversationRowView.tsx").includes(
        "has-[[data-bot-group-delivery]]:opacity-100",
      ),
    "有投递告警时动作栏必须常显（否则只剩悬停才看得见）",
  );

  const rowView = readSource("src/v4/ConversationRowView.tsx");
  assert.ok(
    rowView.includes("source={row.botGroupSource}"),
    "用户输入行必须显示群来源（成员姓名随缓存更新）",
  );
  assert.ok(
    rowView.includes("<ConnectedBotGroupDeliveryAction turnId={turnId}"),
    "动作栏必须挂投递回执动作",
  );

  assert.ok(
    readSource("src/v4/ConversationQueuePanel.tsx").includes("source={item.botGroupSource}"),
    "队列里的待发送群消息也必须能看出是谁在哪个群发的",
  );
});

test("DOM：投递回执只出现在本任务的失败/待确认轮次，文案不是键名", async () => {
  const [{ ConnectedBotGroupDeliveryAction }, { DeliveryContext }, { ZCodeIntlProvider }] =
    await Promise.all([
      import("../src/v4/BotGroupDeliveryAction.js"),
      import("../src/v4/botGroupDeliveryContext.js"),
      import("../src/i18n/IntlProvider.js"),
    ]);
  const delivery = {
    id: "delivery-1",
    taskId: "task-1",
    sourceCommandId: "command-1",
    text: "群结果",
    status: "unknown" as const,
    updatedAt: 1,
  };
  const contextValue = {
    context: {
      botId: "bot-1",
      group: {
        chatId: "chat-1",
        threadId: "thread-1",
        name: "群",
        ownerId: "owner-1",
        enabled: true,
        taskIds: ["task-1"],
        currentOptions: {},
        deliveries: { [delivery.id]: delivery },
      },
      activeTaskId: "task-1",
    },
    provider: undefined,
    busyId: null,
    retry: async () => {},
    reconcile: async () => {},
    retryPreparation: async () => {},
    taskId: "task-1",
  };
  const render = (value: unknown, sourceCommandIds: readonly string[]) =>
    renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          DeliveryContext.Provider,
          { value: value as never },
          createElement(ConnectedBotGroupDeliveryAction, { turnId: "turn-1", sourceCommandIds }),
        ),
      ),
    );

  const html = render(contextValue, ["command-1"]);
  assert.ok(html.includes('data-bot-group-delivery="turn-1"'), "关联到本轮的投递必须给出入口");
  assert.ok(html.includes("飞书待确认"), "待确认状态用真实文案，不是键名：" + html);
  assert.ok(!html.includes("bots.group.deliveryUnknown"), "不得回退成键名");

  // 未关联本轮（sourceCommandIds 不含该命令）⇒ 不渲染，避免轮次上出现无法解释的告警。
  assert.equal(render(contextValue, ["command-2"]), "");
  // 没有群上下文（普通会话）⇒ 整块不渲染。
  assert.equal(render(null, ["command-1"]), "");
});
