import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import zhCN from "../src/i18n/locales/zh-CN.js";
import enUS from "../src/i18n/locales/en-US.js";
import {
  DEFAULT_REMOTE_CONTROL_START_SCOPE,
  parseRemoteControlConnections,
  parseRemoteControlPort,
} from "../src/remoteControlPanelModel.js";
import { resolveRemoteControlConnectionsSource } from "../src/remoteControlConnectionsSource.js";
import { resolveRemoteControlEntryStatus } from "../src/remoteControlWiring.js";

/**
 * ce.4 连接面（task-17）的回归。
 *
 * 与 remoteControlPanel.test.ts 分开的原因：那一份钉的是 ce.3 的切片 1/3/4（入口、面板、
 * 接线），这一份钉的是 ce.4 新增的连接面（已连设备 / 断开 / 令牌轮换 / 端口与监听范围）。
 * 两者判据来源不同（前者是 WebServiceStatus，后者是连接面契约 §6.4），混在一起会让
 * "这条断言在保护哪件事"变得难读。
 *
 * 运行：cd packages/ui && node --import tsx --test test/remoteControlConnections.test.ts
 */

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

function readSource(relativePath: string): string {
  return readFileSync(join(packageRoot, relativePath), "utf8");
}

/** 桌面端的能力面：三个动作都在。 */
const DESKTOP_SOURCE = {
  read: async () => ({ connections: [], revision: 1 }),
  revoke: async () => {},
  rotateToken: async () => {},
};

/** Web 客户端的能力面：三个动作都不在（服务面能力缺失）。 */
const WEB_SOURCE: Record<string, unknown> = {};

/* ────────────────────────────────────────────────────────────────────────────
 * 决策④（spec §6.5）：存在设备清单与断开（单/全）；Web 面板不存在令牌轮换入口。
 * ──────────────────────────────────────────────────────────────────────────── */

test("决策④：Web 面板没有断开与轮换动作；桌面面板两者都有", () => {
  assert.equal(WEB_SOURCE.revoke, undefined, "Web 面板不得有断开动作");
  assert.equal(WEB_SOURCE.rotateToken, undefined, "Web 面板不得有令牌轮换动作（决策④）");
  assert.equal(typeof DESKTOP_SOURCE.revoke, "function");
  assert.equal(typeof DESKTOP_SOURCE.rotateToken, "function");
});

test("规则②的可执行形式：能力缺失 ⇒ 不渲染该区块（DOM 里不存在，不是 disabled）", () => {
  const devices = readSource("src/RemoteControlDevicesSection.tsx");
  const service = readSource("src/RemoteControlServiceSection.tsx");
  // 断开（单/全）只在 onRevoke 存在时渲染。
  assert.match(devices, /onRevoke && rows\.length > 0 \? \(/, "全部断开必须在能力门控内");
  assert.match(devices, /\{onRevoke \? \(/, "断开单个必须在能力门控内");
  // 轮换只在 onRotateToken 存在时渲染 —— 这就是"Web 面板不暴露轮换入口"的实现。
  assert.match(service, /\{onRotateToken \? \(/, "令牌轮换必须在能力门控内");
  // 反向：不得出现"把能力缺失渲染成禁用按钮"的分支。
  for (const [name, source] of [
    ["RemoteControlDevicesSection.tsx", devices],
    ["RemoteControlServiceSection.tsx", service],
  ] as const) {
    assert.equal(
      /disabled=\{!onRevoke\}|disabled=\{!onRotateToken\}|disabled=\{onRevoke === undefined\}/.test(
        source,
      ),
      false,
      name + " 不得把能力缺失表达成 disabled",
    );
  }
  // 面板把三个动作原样透传（不在中间层自己判一次，那会产生第二个所有者）。
  const host = readSource("src/RemoteControlPanelHost.tsx");
  assert.match(host, /onRevokeConnection=\{wiring\.connections\.revoke\}/);
  assert.match(host, /onRotateToken=\{wiring\.connections\.rotateToken\}/);
});

test("能力探测：三个动作分别探测，缺一个不会让整个面板消失（避免 task-84 的静默失效）", async () => {
  const readOnly = resolveRemoteControlConnectionsSource({
    getWebServiceConnections: async () => ({ connections: [], revision: 1 }),
  } as never);
  assert.equal(typeof readOnly.read, "function", "读能力应被探测到");
  assert.equal(readOnly.revoke, undefined, "没提供的写能力不得被凭空补上");
  assert.equal(readOnly.rotateToken, undefined);
  // 关键：缺省能力不得留下 key —— 消费侧若按 key 是否存在判定，会误判成"有能力"。
  assert.equal("revoke" in readOnly, false);
  assert.equal("rotateToken" in readOnly, false);

  // 全空（Web 客户端）⇒ 三个都缺。
  const none = resolveRemoteControlConnectionsSource({} as never);
  assert.equal(none.read, undefined);
  assert.equal(none.revoke, undefined);
  assert.equal(none.rotateToken, undefined);
  // 没有平台对象（公开分享页等无壳层场景）⇒ 同样三个都缺，且不抛错。
  assert.deepEqual(resolveRemoteControlConnectionsSource(null), {});
  assert.deepEqual(resolveRemoteControlConnectionsSource(undefined), {});

  // 探测到的动作必须真的转发到平台对象上（探到却调不动 = 假入口）。
  const calls: unknown[] = [];
  const spy = resolveRemoteControlConnectionsSource({
    revokeWebServiceConnection: async (input: unknown) => {
      calls.push(input);
    },
  } as never);
  await spy.revoke?.({ all: true });
  assert.deepEqual(calls, [{ all: true }], "探测到的动作必须转发到平台对象");
  // 读面同样要转发。
  let readCalls = 0;
  const spyRead = resolveRemoteControlConnectionsSource({
    getWebServiceConnections: async () => {
      readCalls += 1;
      return { connections: [], revision: 1 };
    },
  } as never);
  await spyRead.read?.();
  assert.equal(readCalls, 1);
});

/* ────────────────────────────────────────────────────────────────────────────
 * 读不到（null）与「暂无设备」（空数组）必须分开。
 *
 * 混用的两个后果都是实测过的形态：都当"0 台" ⇒ 入口在一个连不上的服务上宣称
 * 「等待连接」；都当"不知道" ⇒ waiting 永远不可达（死分支，CE3-CHECKLIST §16 规矩 A）。
 * ──────────────────────────────────────────────────────────────────────────── */

test("载荷校验：空数组 = 确定 0 台；畸形载荷 = 读不到（fail-closed）", () => {
  assert.deepEqual(parseRemoteControlConnections({ connections: [], revision: 3 }), {
    connections: [],
    revision: 3,
  });
  for (const bad of [
    null,
    undefined,
    {},
    { connections: [] },
    { revision: 1 },
    { connections: "nope", revision: 1 },
    { connections: [], revision: "1" },
    { connections: [], revision: Number.NaN },
  ]) {
    assert.equal(parseRemoteControlConnections(bad), null, "畸形载荷必须判成读不到");
  }
});

test("单条连接的字段逐个校验：任一条坏 ⇒ 整份当读不到（不半信半疑）", () => {
  const good = {
    id: "c1",
    address: "10.0.0.5",
    role: "trusted-host",
    userAgent: "Mozilla/5.0",
    connectedAt: 1_760_000_000_000,
    workspace: "/ws/a",
  };
  assert.deepEqual(parseRemoteControlConnections({ connections: [good], revision: 1 }), {
    connections: [good],
    revision: 1,
  });
  // workspace 可选：不给也必须通过（它是可选字段，不是缺失即畸形）。
  const { workspace: _omit, ...withoutWorkspace } = good;
  assert.deepEqual(
    parseRemoteControlConnections({ connections: [withoutWorkspace], revision: 1 }),
    { connections: [withoutWorkspace], revision: 1 },
  );
  const badRows: Array<Record<string, unknown>> = [
    { ...good, id: "" },
    { ...good, id: 1 },
    { ...good, address: 1 },
    { ...good, userAgent: 1 },
    { ...good, connectedAt: "2026-09-27" },
    { ...good, connectedAt: Number.POSITIVE_INFINITY },
    { ...good, role: "admin" },
    { ...good, role: 1 },
  ];
  for (const row of badRows) {
    assert.equal(
      parseRemoteControlConnections({ connections: [row], revision: 1 }),
      null,
      "非法行必须让整份判成读不到：" + JSON.stringify(row),
    );
  }
  // 组件侧：读不到时有独立分支，且不得显示「暂无设备」。
  const devices = readSource("src/RemoteControlDevicesSection.tsx");
  assert.match(devices, /if \(connections == null\)/, "读不到必须有独立分支");
  assert.match(devices, /data-remote-control-devices="unknown"/);
  assert.match(devices, /data-remote-control-devices=\{rows\.length === 0 \? "empty" : "listed"\}/);
  assert.match(devices, /t\("remotePanel\.devices\.unknown"\)/);
  assert.match(devices, /t\("remotePanel\.devices\.empty"\)/);
});

test("入口状态：waiting 可达（服务在跑 且 0 台）；读不到时不产出 waiting", () => {
  const base = { adopted: false, loopback: true } as const;
  const empty = { connections: [], revision: 1 };
  const one = {
    connections: [
      {
        id: "c1",
        address: "192.168.1.20",
        role: "terminal-client" as const,
        userAgent: "Mozilla/5.0",
        connectedAt: 1_760_000_000_000,
      },
    ],
    revision: 2,
  };
  // waiting 的产出路径（这是"不留死分支"的可执行形式）。
  assert.equal(resolveRemoteControlEntryStatus({ ...base, state: "running" }, empty), "waiting");
  // 有设备 ⇒ 运行中。
  assert.equal(resolveRemoteControlEntryStatus({ ...base, state: "running" }, one), "running");
  // 读不到 ⇒ 不宣称"没人连着"，也不产出 waiting。
  assert.equal(resolveRemoteControlEntryStatus({ ...base, state: "running" }, null), "running");
  assert.equal(resolveRemoteControlEntryStatus({ ...base, state: "running" }), "running");
  // 服务没在跑 ⇒ off（连接数再小也不产出 waiting）。
  assert.equal(resolveRemoteControlEntryStatus({ ...base, state: "stopped" }, empty), "off");
  assert.equal(resolveRemoteControlEntryStatus({ ...base, state: "stopped" }, one), "off");
  assert.equal(
    resolveRemoteControlEntryStatus(
      { ...base, state: "failed", error: { code: "port-taken", message: "x" } },
      empty,
    ),
    "off",
  );
  assert.equal(
    resolveRemoteControlEntryStatus({ ...base, state: "running-untrusted" }, empty),
    "off",
  );
  // 接线层必须把 connections 传进入口判定（不传 ⇒ waiting 永远不可达）。
  const wiring = readSource("src/remoteControlWiring.ts");
  assert.match(wiring, /resolveRemoteControlEntryStatus\(input\.status, connections\)/);
});

/* ────────────────────────────────────────────────────────────────────────────
 * spec §3.7 触屏可发现性（硬要求）。
 *
 * 判据：无 hover 的窄屏下，不看 tooltip 也能看出"有这个入口 + 当前状态"。
 * 实现是入口内一个 hover:none 下才显示的常显状态词；下面钉住它的三件事：
 * ① 用了既有的 [@media(hover:none)] 模式；② 文本就是当前状态词；③ 三个状态都有文案。
 * ──────────────────────────────────────────────────────────────────────────── */

test("触屏可发现性：入口在无 hover 设备上常显状态词（spec §3.7 硬要求）", () => {
  const entry = readSource("src/RemoteControlEntryButton.tsx");
  // ① 常显状态词必须带 hover:none 变体（本仓既有模式，先例见 ToolCallBlocks/ToolSummaryRow.tsx:216）。
  assert.match(entry, /\[@media\(hover:none\)\]:inline/, "状态词必须在无 hover 时显示");
  // 且默认隐藏（桌面保持紧凑），否则会在桌面也占位。
  assert.match(entry, /className="hidden [^"]*\[@media\(hover:none\)\]:inline"/);
  // ② 它渲染的就是当前状态文案（不是写死的字）。
  assert.match(entry, /data-remote-control-status-label=\{entry\.status\}/);
  assert.match(entry, /\{statusLabel\}/);
  // ③ 三个状态各自有中英文案，且互不相同（三个状态看起来一样就等于没状态）。
  const keys = [
    "remotePanel.entry.status.off",
    "remotePanel.entry.status.running",
    "remotePanel.entry.status.waiting",
  ];
  const zhTexts = keys.map((key) => zhCN[key]);
  const enTexts = keys.map((key) => enUS[key]);
  for (const key of keys) {
    assert.equal(typeof zhCN[key], "string", "zh-CN 缺文案：" + key);
    assert.equal(typeof enUS[key], "string", "en-US 缺文案：" + key);
  }
  assert.equal(new Set(zhTexts).size, 3, "三个状态的中文文案必须互不相同");
  assert.equal(new Set(enTexts).size, 3, "三个状态的英文文案必须互不相同");
  // 状态点也要能区分三态（色盲用户之外，形状/颜色至少不能三态同色）。
  const dotClasses =
    entry.match(
      /bg-foreground-subtlest|bg-\[var\(--color-success\)\]|bg-\[var\(--color-warning\)\]/g,
    ) ?? [];
  assert.equal(new Set(dotClasses).size, 3, "三个状态的状态点颜色必须互不相同");
  // 入口状态取值集合必须与文案表一一对应（新增取值忘了加文案会显示原始 key）。
  for (const value of ["off", "running", "waiting"]) {
    assert.match(entry, new RegExp(value + ': "remotePanel\\.entry\\.status\\.' + value + '"'));
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * 端口与监听范围（spec §3.3）。
 * ──────────────────────────────────────────────────────────────────────────── */

test("端口：留空 = 自动选空闲端口；非法值 ⇒ 拒绝启动（不静默退回自动）", () => {
  assert.equal(parseRemoteControlPort(""), undefined);
  assert.equal(parseRemoteControlPort("   "), undefined);
  assert.equal(parseRemoteControlPort("8080"), 8080);
  assert.equal(parseRemoteControlPort(" 3030 "), 3030);
  assert.equal(parseRemoteControlPort("1"), 1);
  assert.equal(parseRemoteControlPort("65535"), 65535);
  // 非法值 ⇒ null。静默退回"自动选端口"会让用户以为指定生效了，而链接是错的。
  for (const bad of ["0", "65536", "-1", "80.5", "abc", "80a", "0x50", "1e3", "8 0"]) {
    assert.equal(parseRemoteControlPort(bad), null, "非法端口必须判成 null：" + bad);
  }
  // 面板必须真的用这个判定拦下启动（不是只判不拦）。
  const panel = readSource("src/RemoteControlPanel.tsx");
  assert.match(panel, /if \(parsedPort === null\) \{/, "非法端口必须拦下启动");
  assert.match(panel, /setPortInvalid\(true\)/);
  assert.match(panel, /REMOTE_CONTROL_PORT_INVALID_TEST_ID/);
  // 合法时按"有值才传 port"展开（不传 undefined 键，否则服务端会当成显式端口）。
  assert.match(panel, /parsedPort === undefined \? \{\} : \{ port: parsedPort \}/);
});

test("监听范围：默认局域网；运行中锁定；运行中非回环给一键切回环", () => {
  assert.equal(DEFAULT_REMOTE_CONTROL_START_SCOPE, "lan", "决策①默认对局域网开放");
  const service = readSource("src/RemoteControlServiceSection.tsx");
  assert.match(service, /t\("remotePanel\.listen\.loopback"\)/);
  assert.match(service, /t\("remotePanel\.listen\.lan"\)/);
  // 运行中锁定两个选项（改了不生效；允许改就是承诺一个不存在的动作）。
  assert.match(service, /disabled=\{running\}/);
  // 运行中且非回环 ⇒ 一键切回环（spec §3.3 决策①的硬要求）。
  assert.match(service, /running && !loopback && onSwitchToLoopback/);
  // 切回环必须真的"停掉再用回环重开"，不是只改一个不生效的下拉框。
  const panel = readSource("src/RemoteControlPanel.tsx");
  assert.match(panel, /await onStop\(\);/);
  assert.match(panel, /await startService\("loopback"\);/);
});

/* ────────────────────────────────────────────────────────────────────────────
 * 常驻安全提示（spec §3.5 危险品口径）+ 写动作二次确认。
 * ──────────────────────────────────────────────────────────────────────────── */

test("写动作一律二次确认，且复用既有 ConfirmDialogHost（不新造弹窗）", () => {
  const devices = readSource("src/RemoteControlDevicesSection.tsx");
  const service = readSource("src/RemoteControlServiceSection.tsx");
  for (const [name, source] of [
    ["RemoteControlDevicesSection.tsx", devices],
    ["RemoteControlServiceSection.tsx", service],
  ] as const) {
    // 复用全局确认框（useConfirmDialog → ConfirmDialogHost），不自己渲染 Dialog。
    assert.match(source, /useConfirmDialog\(\)/, name + " 必须复用全局确认框");
    assert.equal(
      /from "@\/components\/ui\/dialog\.js"/.test(source),
      false,
      name + " 不得自己新造弹窗（复用既有 Dialog/ConfirmDialog 形态）",
    );
    // 确认取消后不得执行动作（先 await 确认，再动作）。
    assert.match(source, /if \(!confirmed\) return;/);
  }
  // 确认文案三组都在（中英齐备）。
  for (const key of [
    "remotePanel.confirm.stop.title",
    "remotePanel.confirm.rotateToken.title",
    "remotePanel.confirm.revokeOne.title",
    "remotePanel.confirm.revokeAll.title",
    "remotePanel.confirm.rotateToken.body",
  ]) {
    assert.equal(typeof zhCN[key], "string", "zh-CN 缺文案：" + key);
    assert.equal(typeof enUS[key], "string", "en-US 缺文案：" + key);
  }
  // 轮换必须说清后果（所有人需重连）—— 只说"已轮换"会让用户以为别人无感。
  assert.match(zhCN["remotePanel.confirm.rotateToken.body"] ?? "", /重新连接/);
  assert.match(enUS["remotePanel.confirm.rotateToken.body"] ?? "", /reconnect/i);
});

test("连接面 i18n 键中英齐备（spec §6.3 的键表）", () => {
  const required = [
    "remotePanel.devices.title",
    "remotePanel.devices.empty",
    "remotePanel.devices.unknown",
    "remotePanel.devices.revokeOne",
    "remotePanel.devices.revokeAll",
    "remotePanel.devices.column.address",
    "remotePanel.devices.column.role",
    "remotePanel.devices.column.connectedAt",
    "remotePanel.devices.column.userAgent",
    "remotePanel.devices.role.terminalClient",
    "remotePanel.devices.role.trustedHost",
    "remotePanel.action.rotateToken",
    "remotePanel.listen.label",
    "remotePanel.listen.loopback",
    "remotePanel.listen.lan",
    "remotePanel.listen.portAuto",
    "remotePanel.listen.customPort",
    "remotePanel.listen.portInvalid",
    "remotePanel.danger.credentials",
    "remotePanel.danger.sharedToken",
    "remotePanel.danger.noTls",
  ];
  for (const key of required) {
    assert.equal(typeof zhCN[key], "string", "zh-CN 缺文案：" + key);
    assert.notEqual(zhCN[key], "", "zh-CN 空文案：" + key);
    assert.equal(typeof enUS[key], "string", "en-US 缺文案：" + key);
    assert.notEqual(enUS[key], "", "en-US 空文案：" + key);
  }
  // 连接面文案不得出现官方 relay 词（spec §6.5 决策⑧：不搬官方文案与中继形态）。
  const panelTexts = Object.keys(zhCN)
    .filter((key) => key.startsWith("remotePanel."))
    .flatMap((key) => [zhCN[key] ?? "", enUS[key] ?? ""]);
  for (const text of panelTexts) {
    assert.equal(
      /relay|pairing|bindCode|配对码|绑定码/i.test(text),
      false,
      "不得出现中继词：" + text,
    );
  }
});
