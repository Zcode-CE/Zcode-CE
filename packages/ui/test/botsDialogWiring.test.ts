import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
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

test("i18n：两份 locale 的 bots.* 键集完全一致（无单语缺漏）", () => {
  const zh = botsKeys(zhCN);
  const en = botsKeys(enUS);
  // 不写死键数：它会随功能漂移。钉住的是「双语一致」与「F8 族在位」。
  assert.ok(zh.length > 200, "bots.* 键数异常少，检查字典是否被截断");
  assert.deepEqual(zh, en, "两份 locale 的键集必须逐键一致");
  for (const key of [
    "bots.boundGroups.title",
    "bots.boundGroups.count",
    "bots.privateDelivery.retry",
  ]) {
    assert.ok(key in zhCN && key in enUS, "F8 群/话题与私聊重试的键必须在位：" + key);
  }
});

/** 取一个表达式里的字面量字符串（含三元两支）；只有它们能静态判定。 */
function literalStrings(node: ts.Expression): string[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isConditionalExpression(node)) {
    return [...literalStrings(node.whenTrue), ...literalStrings(node.whenFalse)];
  }
  if (ts.isParenthesizedExpression(node)) return literalStrings(node.expression);
  return [];
}

/**
 * AST 提取组件里的消息 id。
 *
 * 为什么不用正则（2026-10-29 审计 P0-2）：原实现只扫 4 个文件、正则不认三元 id，
 * 13 条群/话题与私聊重试的键因此全漏，测试一直绿而界面显示键名。
 * 这里覆盖 `id`/`messageId` 属性（含三元）与 `t()` 字面量；动态拼接仍不可静态判定。
 */
function extractMessageIds(relPath: string): string[] {
  const file = join(packageRoot, relPath);
  const source = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  function walk(node: ts.Node): void {
    if (ts.isPropertyAssignment(node)) {
      const name =
        ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : null;
      if (name === "id" || name === "messageId") out.push(...literalStrings(node.initializer));
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (["t", "translate"].includes(node.expression.text) && node.arguments[0]) {
        out.push(...literalStrings(node.arguments[0]));
      }
    }
    ts.forEachChild(node, walk);
  }
  walk(sf);
  return out;
}

test("i18n：组件引用的每一条消息键都在两份 locale 里（含动态模板族）", () => {
  // 静态键：扫 BotsDialog 主文件与 BotsDialog/ 下全部子组件（新增组件自动纳入）。
  const botDialogDir = join(packageRoot, "src/BotsDialog");
  const componentFiles = [
    "src/BotsDialog.tsx",
    ...readdirSync(botDialogDir)
      .filter((name) => name.endsWith(".tsx"))
      .map((name) => "src/BotsDialog/" + name),
  ];
  const staticIds = componentFiles.flatMap((rel) => extractMessageIds(rel));

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
