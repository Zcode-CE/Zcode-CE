import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import zhCN from "../src/i18n/locales/zh-CN.js";
import enUS from "../src/i18n/locales/en-US.js";
import { BOT_REPLY_GRANULARITIES } from "../src/botsUi.js";

/**
 * Bot 管理面（ce.5）接线与 i18n 覆盖的护栏。
 *
 * 钉住三件事：
 * 1. 接线的两端都在场：wiring 产出 imBot 通道（status/onEnable 有真实落点）、
 *    Host 透传 imBot、Sidebar 挂载 BotsDialog 并把 panelOpen 交给轮询节奏。
 *    判据是「同意后即可使用」可验收：onEnable 的落点是打开 BotsDialog（不是空操作）。
 * 2. i18n 双语对等：259 个 bots.* 键在中英两份 locale 里键集完全一致。
 * 3. 不做 BotsDialog 的 SSR DOM 断言：Radix Dialog 内容经 Portal 渲染，
 *    renderToStaticMarkup 下没有 `document` ⇒ 内容不进 DOM（实测输出空串）；
 *    强行断言「标题在 HTML 里」会是空转断言（关闭态也恒绿）。
 *    渲染面纪律（能力缺失 ⇒ 不渲染）由 canRenderRemoteControlImBotTab +
 *    remoteControlPanel.test.ts 的注入态断言覆盖。
 *
 * 运行：cd packages/ui && node --import tsx --test test/botsDialogWiring.test.ts
 */

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

function readSource(relativePath: string): string {
  return readFileSync(join(packageRoot, relativePath), "utf8");
}

function botsKeys(locale: Record<string, string>): string[] {
  return Object.keys(locale)
    .filter((key) => key.startsWith("bots."))
    .sort();
}

test("i18n：两份 locale 的 bots.* 键集完全一致（259 键，无单语缺漏）", () => {
  const zh = botsKeys(zhCN);
  const en = botsKeys(enUS);
  assert.equal(zh.length, 259, "zh-CN 的 bots.* 键数必须是 259");
  assert.equal(en.length, 259, "en-US 的 bots.* 键数必须是 259");
  assert.deepEqual(zh, en, "两份 locale 的键集必须逐键一致");
});

test("i18n：组件引用的每一条消息键都在两份 locale 里（含动态模板族）", () => {
  // 静态键：从组件源码里提取所有 intl.formatMessage({ id: ... }) / t("...") 字面量。
  const sources = [
    "src/BotsDialog.tsx",
    "src/BotsDialog/BotSummaryCard.tsx",
    "src/BotsDialog/ProviderSettingsCard.tsx",
    "src/BotsDialog/WorkspaceAccessCard.tsx",
  ]
    .map((rel) => readSource(rel))
    .join("\n");
  const staticIds = [...sources.matchAll(/(?:id|messageId):\s*"([a-zA-Z0-9.]+)"/g)].map(
    (m) => m[1]!,
  );

  // 动态模板族：botsUi 的 provider 列表 × 渠道文案 / 描述 / 状态。
  const providers = ["weixin", "feishu", "lark", "telegram", "webhook"];
  const dynamicIds: string[] = [];
  for (const provider of providers) {
    dynamicIds.push(`bots.channel.${provider}`);
    dynamicIds.push(`bots.botTokenDescription.${provider}`);
    dynamicIds.push(`bots.newBot.providerDescription.${provider}`);
  }
  for (const domain of ["feishu", "lark"]) {
    dynamicIds.push(`bots.feishuRegistrationScanHint.${domain}`);
  }
  // 组件实际引用的状态族：feishu 的 pending 走 common.loading、success 走独立 toast 键，
  // 故模板族只覆盖 access_denied/expired/error；weixin 的 pending/scanned 有独立文案。
  for (const status of ["access_denied", "expired", "error"]) {
    dynamicIds.push(`bots.feishuRegistration.${status}`);
  }
  for (const status of ["pending", "scanned", "expired", "error"]) {
    dynamicIds.push(`bots.weixinRegistration.${status}`);
  }
  for (const granularity of BOT_REPLY_GRANULARITIES) {
    dynamicIds.push(granularity.labelId);
    dynamicIds.push(granularity.descriptionId);
  }

  const missing = [...new Set([...staticIds, ...dynamicIds])].filter(
    (id) => !(id in zhCN) || !(id in enUS),
  );
  assert.deepEqual(
    missing,
    [],
    "组件引用但 locale 缺失的键：" + missing.join(", ") + "（渲染会出现回退字面量）",
  );
});

test("接线：wiring 组合 useImBotChannel；通道 onEnable 落点是打开 BotsDialog", () => {
  const wiringHook = readSource("src/hooks/useRemoteControlWiring.ts");
  assert.ok(
    wiringHook.includes("imBot: RemoteControlImBotChannel | null"),
    "RemoteControlWiring 必须声明 imBot 字段",
  );
  assert.ok(
    wiringHook.includes("useImBotChannel({"),
    "wiring 必须组合 useImBotChannel（通道构建在独立 hook，不污染 wiring 的「不轮询」契约）",
  );
  assert.ok(
    wiringHook.includes("active: options?.panelOpen ?? false"),
    "轮询节奏必须受 panelOpen 门控（面板关闭时不轮询）",
  );

  const imBotHook = readSource("src/hooks/useImBotChannel.ts");
  assert.ok(
    imBotHook.includes("services?.botsService"),
    "通道必须由 botsService 构建（无 botsService ⇒ null ⇒ 标签页不渲染）",
  );
  assert.ok(
    imBotHook.includes('status: botEnabled ? "enabled" : "disabled"'),
    "status 必须由真实 bot 状态承载（enabledBotsCount）",
  );
  assert.ok(
    imBotHook.includes("setBotsDialogOpen(true)") && imBotHook.includes("onEnable:"),
    "onEnable 的实现必须是打开 BotsDialog（同意动作要有真实落点，不是空操作）",
  );
});

test("接线：Host 透传 imBot、Sidebar 挂载 BotsDialog 并传 panelOpen", () => {
  const host = readSource("src/RemoteControlPanelHost.tsx");
  assert.ok(
    host.includes("imBot={wiring.imBot}"),
    "RemoteControlPanelHost 必须把 wiring.imBot 透传给面板",
  );
  const sidebar = readSource("src/WorkspaceSidebar.tsx");
  assert.ok(
    sidebar.includes("useRemoteControlWiring({ panelOpen: remoteControlOpen })"),
    "Sidebar 必须把面板开闭状态交给 wiring（轮询节奏）",
  );
  assert.ok(
    sidebar.includes("<BotsDialog") && sidebar.includes("remoteControl.botsDialogOpen"),
    "Sidebar 必须挂载 BotsDialog 并用宿主层的开闭状态（不是组件局部——133 报告 B1）",
  );
});
