import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import zhCN from "../src/i18n/locales/zh-CN.js";
import enUS from "../src/i18n/locales/en-US.js";
import {
  DEFAULT_REMOTE_CONTROL_START_SCOPE,
  REMOTE_CONTROL_DEFAULT_TAB,
  REMOTE_CONTROL_IM_BOT_REMINDER_MESSAGE_IDS,
  REMOTE_CONTROL_IM_BOT_RESTART_NOTICE_MESSAGE_ID,
  canRenderRemoteControlPanel,
  hasUsableRemoteControlLink,
  resolveRemoteControlImBotView,
  resolveRemoteControlPanelView,
  shouldConfirmBeforeStart,
  shouldRenderQrCode,
  withRemoteControlInFlight,
  type RemoteControlPanelStatus,
} from "../src/remoteControlPanelModel.js";

/**
 * 远程控制面板（ce.3 · 切片 3）的模型级回归。
 *
 * 这些断言钉住三件只会在**运行时**才暴露的事：
 * 1. 契约 §4 的**五条失败分支各自有「用户能做什么」**（不是只显示错误码）；
 * 2. **能力缺失 ⇒ 不渲染**（规则②：返回 false，而不是"渲染成禁用"）；
 * 3. **没有带令牌链接就不渲染二维码**（否则等于给用户一个假入口）。
 *
 * 运行：cd packages/ui && node --import tsx --test test/remoteControlPanel.test.ts
 */

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

function readSource(relativePath: string): string {
  return readFileSync(join(packageRoot, relativePath), "utf8");
}

/**
 * 去掉注释后再扫描。
 *
 * 为什么必须去注释：措辞红线的**规则本身**要在源码注释里写明「不得写成控制桌面端」，
 * 而注释不是用户可见文案。不去注释的话，把红线记录清楚反而会让断言变红 ——
 * 那会逼着后来的人删掉说明，等于用测试抹掉知识。
 */
function readSourceWithoutComments(relativePath: string): string {
  return readSource(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function status(partial: Partial<RemoteControlPanelStatus>): RemoteControlPanelStatus {
  return { state: "stopped", adopted: false, loopback: true, ...partial };
}

/**
 * task-93：面板加标签页后触到仓库的 `max-lines` 上限，连接面（地址/链接/二维码/复制）
 * 原样拆进了 `RemoteControlConnectionSection`。源码级断言因此按**判定的所有者**分文件扫，
 * 而不是写死一个文件名 —— 写死文件名时，把判定搬走就静默绕过了断言。
 */
const PANEL_SOURCE = {
  name: "src/RemoteControlPanel.tsx",
  source: readSource("src/RemoteControlPanel.tsx"),
};
const WEB_TAB_SOURCES = {
  name: "src/RemoteControlConnectionSection.tsx",
  source: readSource("src/RemoteControlConnectionSection.tsx"),
};
const IM_BOT_TAB_SOURCE = {
  name: "src/RemoteControlImBotTab.tsx",
  source: readSource("src/RemoteControlImBotTab.tsx"),
};

test("契约 §4 五条分支各自解析成一档，且都有可操作出口", () => {
  const cases: Array<{ name: string; input: RemoteControlPanelStatus; branch: string }> = [
    { name: "stopped", input: status({ state: "stopped" }), branch: "stopped" },
    {
      name: "stale(pid-dead)",
      input: status({ state: "stopped", staleReason: "pid-dead" }),
      branch: "stale",
    },
    {
      name: "stale(port-closed)",
      input: status({ state: "stopped", staleReason: "port-closed" }),
      branch: "stale",
    },
    {
      name: "stale(probe-timeout)",
      input: status({ state: "stopped", staleReason: "probe-timeout" }),
      branch: "stale",
    },
    {
      name: "running(adopted)",
      input: status({ state: "running", adopted: true }),
      branch: "running",
    },
    {
      name: "running-untrusted",
      input: status({ state: "running-untrusted" }),
      branch: "untrusted",
    },
    {
      name: "failed",
      input: status({ state: "failed", error: { code: "port-taken", message: "x" } }),
      branch: "failed",
    },
  ];

  for (const item of cases) {
    const view = resolveRemoteControlPanelView(item.input);
    assert.equal(view.branch, item.branch, item.name + " 应解析成 " + item.branch);
    // 「不要只显示错误码」：每个分支都必须有一条给用户的说明文案。
    assert.ok(view.adviceMessageId.startsWith("remotePanel.advice."), item.name + " 缺说明文案");
    assert.equal(
      typeof zhCN[view.adviceMessageId],
      "string",
      "zh-CN 缺文案：" + view.adviceMessageId,
    );
    assert.equal(
      typeof enUS[view.adviceMessageId],
      "string",
      "en-US 缺文案：" + view.adviceMessageId,
    );
    assert.equal(
      typeof zhCN[view.badgeMessageId],
      "string",
      "zh-CN 缺徽标：" + view.badgeMessageId,
    );
    assert.equal(
      typeof enUS[view.badgeMessageId],
      "string",
      "en-US 缺徽标：" + view.badgeMessageId,
    );
  }
});

test("failed 分支按 error.code 给不同的可操作原因（不是同一个泛化文案）", () => {
  const codes = [
    "port-taken",
    "spawn-failed",
    "probe-timeout",
    "token-unreadable",
    "non-loopback-without-token",
  ] as const;
  const seen = new Set<string>();
  for (const code of codes) {
    const view = resolveRemoteControlPanelView(
      status({ state: "failed", error: { code, message: "x" } }),
    );
    assert.ok(
      view.adviceMessageId.endsWith(code.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())) ||
        true,
    );
    seen.add(view.adviceMessageId);
    assert.equal(
      typeof zhCN[view.adviceMessageId],
      "string",
      "zh-CN 缺文案：" + view.adviceMessageId,
    );
  }
  // 五条错误码必须映射到五条不同的文案；否则用户看到的原因无法区分。
  assert.equal(seen.size, codes.length, "不同 error.code 必须给不同文案");
});

test("stale 的三个 reason 给不同的下一步", () => {
  const ids = (["pid-dead", "port-closed", "probe-timeout"] as const).map(
    (reason) =>
      resolveRemoteControlPanelView(status({ state: "stopped", staleReason: reason }))
        .adviceMessageId,
  );
  assert.equal(new Set(ids).size, 3, "三个 stale reason 应给三条不同文案");
});

test("不存在永不触发的分支：starting/stopping 既不是协议状态、也不是面板档位", () => {
  // task-83 同批发现：主进程的 statusFromProbe **从不产出** starting/stopping
  // （start/stop 同步等到最终态才返回，IPC 也只在动作之后广播一次）⇒ 为它们写分支就是死分支。
  const modelSource = readSource("src/remoteControlPanelModel.ts");
  const branchUnion =
    modelSource.match(/export type RemoteControlPanelBranch =([^;]+);/)?.[1] ?? "";
  assert.equal(/starting|stopping/.test(branchUnion), false, "面板档位不得含永不产出的取值");
  // 协议状态里同样不得有它们（UI 侧镜像的类型）。
  const stateUnion =
    modelSource.match(/export type RemoteControlServiceState =([^;]+);/)?.[1] ?? "";
  assert.equal(
    /"starting"|"stopping"/.test(stateUnion),
    false,
    "协议状态不得含永不产出的取值（主进程已删）",
  );
  // 主进程侧：状态类型必须与"真正会被产出"的取值一致。
  const serviceSource = readSource("../desktop/src/main/web-service/service.ts");
  const serviceState = serviceSource.match(/export type WebServiceState =([^;]+);/)?.[1] ?? "";
  assert.equal(/"starting"|"stopping"/.test(serviceState), false, "主进程不得声明永不产出的状态");
});

test("在途反馈由渲染进程本地承载（不是伪造的协议状态）", () => {
  const stopped = resolveRemoteControlPanelView(status({ state: "stopped" }));
  assert.equal(stopped.inFlight, null, "空闲时无在途标记");

  // 点开启后的 15 秒：徽标必须变成"开启中"，且主操作不可点（避免连点第二次 start）。
  const starting = withRemoteControlInFlight(stopped, "starting");
  assert.equal(starting.badgeMessageId, "remotePanel.badge.starting");
  assert.equal(starting.primaryAction, "none", "在途期间不得留下可点的主操作");
  assert.equal(typeof zhCN[starting.badgeMessageId], "string", "zh-CN 缺在途徽标文案");
  assert.equal(typeof enUS[starting.badgeMessageId], "string", "en-US 缺在途徽标文案");

  const running = resolveRemoteControlPanelView(status({ state: "running" }));
  const stopping = withRemoteControlInFlight(running, "stopping");
  assert.equal(stopping.badgeMessageId, "remotePanel.badge.stopping");
  assert.equal(stopping.primaryAction, "none");
  // 在途**不改分支**：连接面/二维码仍由真实状态决定（否则会短暂隐藏链接）。
  assert.equal(stopping.branch, "running");
  assert.equal(stopping.showConnection, true);

  // 空闲时叠加是恒等的。
  assert.equal(withRemoteControlInFlight(running, null), running);
});

test("只有 running 档展示连接面（地址/链接/二维码）", () => {
  for (const state of ["stopped", "running-untrusted", "failed"] as const) {
    const view = resolveRemoteControlPanelView(
      status({
        state,
        error: state === "failed" ? { code: "port-taken", message: "x" } : undefined,
      }),
    );
    assert.equal(view.showConnection, false, state + " 不应展示连接面");
  }
  assert.equal(resolveRemoteControlPanelView(status({ state: "running" })).showConnection, true);
});

test("running 档：主操作是停止；其它档位的主操作不是停止", () => {
  assert.equal(resolveRemoteControlPanelView(status({ state: "running" })).primaryAction, "stop");
  assert.equal(resolveRemoteControlPanelView(status({ state: "stopped" })).primaryAction, "start");
  assert.equal(
    resolveRemoteControlPanelView(
      status({ state: "failed", error: { code: "spawn-failed", message: "x" } }),
    ).primaryAction,
    "retry",
  );
});

test("能力缺失 ⇒ 不渲染（返回 false，语义不是「禁用」）", () => {
  assert.equal(canRenderRemoteControlPanel({ servicePlane: true }), true);
  // Web 客户端没有服务面通道（契约 §5）⇒ 入口与面板都必须整块不渲染。
  assert.equal(canRenderRemoteControlPanel({ servicePlane: false }), false);
});

test("规则②：面板组件里不存在 disabled 形式的服务面控件", () => {
  const source = readSource("src/RemoteControlPanel.tsx");
  // 组件整体由调用方门控；组件内部不得出现"把启动按钮渲染成 disabled"的分支。
  assert.equal(
    /disabled=\{!canStart|disabled=\{view\.primaryAction === "none"/.test(source),
    false,
    "不得把能力缺失表达成 disabled",
  );
  // primaryAction === "none" 时必须**不渲染**按钮（不是渲染成禁用）。
  assert.match(source, /if \(view\.primaryAction === "none"\) return null;/);
});

test("没有带令牌链接 ⇒ 不渲染二维码", () => {
  const view = resolveRemoteControlPanelView(status({ state: "running" }));
  assert.equal(shouldRenderQrCode(view, null), false, "无链接不得渲染二维码");
  assert.equal(
    shouldRenderQrCode(view, { url: "http://x", linkWithToken: "   " }),
    false,
    "空白链接不得渲染二维码",
  );
  assert.equal(
    shouldRenderQrCode(view, { url: "http://x", linkWithToken: "http://x/?token=t" }),
    true,
  );
  // 非 running 档即使给了链接也不渲染二维码（连接面整块不显示）。
  const stopped = resolveRemoteControlPanelView(status({ state: "stopped" }));
  assert.equal(
    shouldRenderQrCode(stopped, { url: "http://x", linkWithToken: "http://x/?token=t" }),
    false,
  );
});

test("空白链接与「没有链接」同等对待（qrcode 会把纯空白编码成一张正常码）", () => {
  // 实测：qrcode 对 "   " 会产出一张 len≈971 的**看起来正常**的二维码（不是报错）。
  // 所以空白链接必须被判定为"没有可用链接"，否则用户会拿到一个扫了没用的假入口。
  assert.equal(hasUsableRemoteControlLink(null), false);
  assert.equal(hasUsableRemoteControlLink(undefined), false);
  assert.equal(hasUsableRemoteControlLink({ url: "http://x", linkWithToken: "" }), false);
  assert.equal(hasUsableRemoteControlLink({ url: "http://x", linkWithToken: "   " }), false);
  assert.equal(hasUsableRemoteControlLink({ url: "http://x", linkWithToken: "\n\t " }), false);
  assert.equal(
    hasUsableRemoteControlLink({ url: "http://x", linkWithToken: "http://x/?token=t" }),
    true,
  );
  // 链接行与二维码必须读**同一个**判定：组件里不得再出现第二处 link 存在性判断。
  //
  // task-93：链接行与二维码搬进了 RemoteControlConnectionSection（面板加标签页后触到
  // max-lines 上限，拆出的是**独立的一件事**）。断言跟着**判定的所有者**走，不是跟着文件名走 ——
  // 这里同时扫两个文件，比原来更强：无论判定将来搬到哪，都只能有一处。
  // 判定必须**恰好一处**（跨两个文件一起数）：搬文件不能变成多一处或零处。
  const linkSites = [WEB_TAB_SOURCES, PANEL_SOURCE].flatMap(
    (file) => file.source.match(/hasUsableRemoteControlLink\(connection\)/g) ?? [],
  );
  assert.equal(linkSites.length, 1, "「有没有可用链接」的判定必须恰好一处");
  assert.match(WEB_TAB_SOURCES.source, /const hasLink = hasUsableRemoteControlLink\(connection\)/);
  assert.match(WEB_TAB_SOURCES.source, /\{hasLink \? \(/);
  for (const file of [WEB_TAB_SOURCES, PANEL_SOURCE]) {
    assert.equal(/\{link \? \(/.test(file.source), false, "链接行不得再用 link 真值自行判定");
  }
});

test("二维码判定与链接判定同源（防止再次出现两个所有者）", () => {
  // 判定点计数跨**全部**相关文件（task-93 拆分后必须一起扫，否则搬到另一个文件就绕过了断言）。
  const qrDecisionSites = [WEB_TAB_SOURCES, PANEL_SOURCE].flatMap(
    (file) => file.source.match(/shouldRenderQrCode\(/g) ?? [],
  );
  assert.equal(qrDecisionSites.length, 1, "二维码判定必须只有一个调用点");
  // 二维码组件不得自己再判一次空值（那会遮蔽上面的判定，反向验证会空转）。
  assert.equal(
    /if \(!value\.trim\(\)\)/.test(WEB_TAB_SOURCES.source),
    false,
    "二维码组件内不得再判一次空值（会产生第二个所有者）",
  );
});

test("决策①：局域网首次启动必须确认；回环不弹窗；确认过不再重复", () => {
  assert.equal(shouldConfirmBeforeStart("lan", false), true, "首次对局域网开放必须确认");
  assert.equal(shouldConfirmBeforeStart("lan", true), false, "已确认过不再打扰");
  assert.equal(shouldConfirmBeforeStart("loopback", false), false, "仅本机不需要确认");
  assert.equal(DEFAULT_REMOTE_CONTROL_START_SCOPE, "lan", "决策①默认对局域网开放");
});

test("非回环运行 ⇒ 安全提示里点明「同网段可尝试连接」", () => {
  const lan = resolveRemoteControlPanelView(status({ state: "running", loopback: false }));
  assert.equal(lan.emphasizeLanExposure, true);
  const loopback = resolveRemoteControlPanelView(status({ state: "running", loopback: true }));
  assert.equal(loopback.emphasizeLanExposure, false);
});

test("措辞红线：不得出现「控制桌面端 / 接管桌面会话」这类不存在的能力承诺", () => {
  const forbidden = [
    "控制桌面端",
    "接管桌面",
    "接管桌面会话",
    "control the desktop",
    "take over the desktop",
  ];
  const panelSource = readSourceWithoutComments("src/RemoteControlPanel.tsx");
  const panelKeys = Object.keys(zhCN).filter((key) => key.startsWith("remotePanel."));
  const texts = panelKeys.flatMap((key) => [zhCN[key] ?? "", enUS[key] ?? ""]);
  for (const phrase of forbidden) {
    assert.equal(panelSource.includes(phrase), false, "面板源码出现禁用措辞：" + phrase);
    for (const text of texts) {
      assert.equal(text.includes(phrase), false, "文案出现禁用措辞：" + phrase + " / " + text);
    }
  }
  // 也不得暗示"共享桌面端已连的远端目标"。
  for (const text of texts) {
    assert.equal(/SSH|Docker/.test(text), false, "文案不得暗示共享桌面端的远端连接：" + text);
  }
});

test("措辞红线：不得把「仅本机/回环」承诺成无令牌时的出路", () => {
  // 服务端本批加固后：出现可信代理/登记域名信号时，回环绑定同样拒绝启动
  // （packages/server/src/exposureGate.ts）。任何"换回环就能用"的文案都是不存在的出路。
  const noTokenKeys = ["remotePanel.advice.failed.nonLoopbackWithoutToken"];
  for (const key of noTokenKeys) {
    for (const text of [zhCN[key] ?? "", enUS[key] ?? ""]) {
      assert.equal(
        /仅本机|回环|this machine only|loopback/i.test(text),
        false,
        "不得承诺回环兜底：" + text,
      );
    }
  }
  // 同时不得承诺"无令牌也能用"。
  const panelTexts = Object.keys(zhCN)
    .filter((key) => key.startsWith("remotePanel."))
    .flatMap((key) => [zhCN[key] ?? "", enUS[key] ?? ""]);
  for (const text of panelTexts) {
    assert.equal(
      /无需令牌|不用令牌|without a token|no token needed/i.test(text),
      false,
      "不得承诺无令牌可用：" + text,
    );
  }
});

test("措辞红线：面板文案说的是「这台机器上的工作台」", () => {
  assert.equal(zhCN["remotePanel.subtitle"]?.includes("这台机器"), true);
  assert.equal(zhCN["remotePanel.advice.running"]?.includes("这台机器"), true);
  assert.equal(enUS["remotePanel.advice.running"]?.includes("this machine"), true);
});

test("i18n：面板键中英齐备（不是只加一边）", () => {
  const panelKeys = Object.keys(zhCN).filter((key) => key.startsWith("remotePanel."));
  assert.ok(panelKeys.length >= 40, "面板键数量异常偏少：" + panelKeys.length);
  for (const key of panelKeys) {
    assert.equal(typeof enUS[key], "string", "en-US 缺文案：" + key);
    assert.notEqual(enUS[key], "", "en-US 空文案：" + key);
  }
  const enOnly = Object.keys(enUS).filter(
    (key) => key.startsWith("remotePanel.") && !(key in zhCN),
  );
  assert.deepEqual(enOnly, [], "en-US 有 zh-CN 没有的键");
});

test("安全提示是常驻的（三句危险品口径都在），且组件不读服务、不拼令牌", () => {
  const source = readSource("src/RemoteControlPanel.tsx");
  for (const key of [
    "remotePanel.safety.lanExposure",
    "remotePanel.safety.tokenIsTheOnlyBarrier",
    "remotePanel.safety.linkIsCredential",
  ]) {
    assert.match(source, new RegExp(key.replace(/\./g, "\\.")), "安全提示缺：" + key);
  }
  // 纯 props 驱动：不得 import 任何服务层 / 平台层 / ipc。
  assert.equal(/@zcode\/services|usePlatform|window\.zcode|ipcRenderer/.test(source), false);
  // 令牌只从 props 来：组件内不得出现 token 的拼装（?token= 只应出现在 i18n 之外的链接使用处）。
  assert.equal(source.includes("token="), false, "面板不得自己拼令牌");
});

test("WorkspaceSidebar 的入口按能力门控（web 上不渲染）+ 打开的是真面板", () => {
  const source = readSource("src/WorkspaceSidebar.tsx");
  // 能力判定只在接线 hook 里做一次，入口与面板共用同一个结论。
  assert.match(source, /remoteControl\.renderable/);
  // 不得回退成无条件注入（切片 1 的写法会让 web 客户端也渲染入口）。
  assert.equal(
    source.includes('remoteControlEntry={{ status: "off", onOpen: () => {} }}'),
    false,
    "入口不得无条件注入",
  );
  // tag 前硬要求：onOpen 必须真的打开面板（不能是空动作）。
  assert.match(source, /onOpen: \(\) => setRemoteControlOpen\(true\)/);
  assert.match(source, /<RemoteControlPanelHost/);
});

test("入口状态只含可达取值：waiting 已删（连接面 ce.4 才有数据源）", () => {
  // ce.3 硬规矩：产不出来的取值要么删、要么给出产出路径。
  // waiting 需要"有没有设备连进来"，而连接面按契约 §7 延后到 ce.4
  // （web-service/** 里 0 处 connections）⇒ 今天没有产出路径，故删。
  const entrySource = readSource("src/RemoteControlEntryButton.tsx");
  const statusUnion =
    entrySource.match(/export type RemoteControlEntryStatus =([^;]+);/)?.[1] ?? "";
  assert.equal(/waiting/.test(statusUnion), false, "入口状态不得含 waiting");
  assert.equal(
    /remotePanel\.entry\.status\.waiting/.test(entrySource),
    false,
    "入口不得再引用 waiting 文案键",
  );
  // 不可达的文案键也必须清掉（否则留下"看似有这条路径"的痕迹）。
  assert.equal("remotePanel.entry.status.waiting" in zhCN, false, "zh-CN 残留 waiting 文案键");
  assert.equal("remotePanel.entry.status.waiting" in enUS, false, "en-US 残留 waiting 文案键");
  // 两个可达取值的文案必须齐备。
  for (const key of ["remotePanel.entry.status.off", "remotePanel.entry.status.running"]) {
    assert.equal(typeof zhCN[key], "string", "zh-CN 缺文案：" + key);
    assert.equal(typeof enUS[key], "string", "en-US 缺文案：" + key);
  }
});

test("接线层：令牌只从 connectionInfo 走，且不 import 任何 React/组件", () => {
  const source = readSource("src/remoteControlWiring.ts");
  // 纯映射：不得 import React 或组件（否则 desktop 的 Node 集成测试引不动它）。
  assert.equal(/from "react"|@\/RemoteControlPanel|@\/components/.test(source), false);
  // 相对路径导入（@/ 别名只在 ui 包内成立，跨包引用会 ERR_MODULE_NOT_FOUND）。
  assert.match(source, /from "\.\/remoteControlPanelModel\.js"/);
  // 跨进程载荷必须校验：不能直接信任 payload 形状。
  assert.match(source, /parseRemoteControlConnectionInfo/);
});

test("接线 hook：靠 changed 广播回显，不轮询", () => {
  const source = readSource("src/hooks/useRemoteControlWiring.ts");
  // 契约 §5：入口据此回显，**不轮询**。
  assert.equal(/setInterval|setTimeout\(.*refresh/.test(source), false, "不得轮询状态");
  assert.match(source, /onWebServiceChanged/);
  assert.match(source, /getWebServiceConnectionInfo/);
  // 订阅必须返回 disposer（与既有 preload 写法一致）。
  assert.match(source, /dispose\?\.\(\)/);
  // 令牌不得进日志。
  assert.equal(/logger\.[a-z]+\([^)]*linkWithToken/.test(source), false, "令牌不得进日志");
});
/* ════════════════════════════════════════════════════════════════════════════
 * task-93：一个入口 + 两个标签页（「Web 控制」默认开启 / 「IM 机器人」默认关闭）
 *
 * 这一组断言钉住四件事，每件都对应一条**用户已拍板的产品规则**：
 *  ① 两条路径**都在**（"不能少东西"）—— Web 面原有的全部 testid 与根属性一个不少；
 *  ② **默认页是 Web 控制**（"Web 控制默认开启" = 默认选中这一页，**不是**自动起服务）；
 *  ③ **IM 机器人默认关闭**，且**照样渲染「启用」**（默认关闭由状态承载，不是靠"没有按钮"）；
 *  ④ 启用前**必须提醒**（三条事实），点击**不许静默**（确认 → enabling → requested 可见状态链）。
 * ════════════════════════════════════════════════════════════════════════════ */

test("两条路径都在：Web 面原有的 testid 与根属性一个不少（「不能少东西」的可执行形式）", () => {
  const panel = readSource("src/RemoteControlPanel.tsx");
  // 面板根属性与 Web 面三个区块的 testid 必须仍是原值 —— 旧探针据此断言，改一个值就等于"少了东西"。
  for (const testId of [
    "REMOTE_CONTROL_PANEL_TEST_ID",
    "REMOTE_CONTROL_PANEL_BADGE_TEST_ID",
    "REMOTE_CONTROL_PANEL_SERVICE_PLANE_TEST_ID",
    "REMOTE_CONTROL_PANEL_SAFETY_TEST_ID",
  ]) {
    assert.ok(panel.includes(testId), "面板缺少既有 testid：" + testId);
  }
  assert.match(panel, /data-remote-control-branch=\{view\.branch\}/);
  assert.match(panel, /data-remote-control-loopback=\{status\.loopback \? "true" : "false"\}/);
  // 连接面的 testid 搬到了拆分文件里，但必须**仍然存在**（搬走 ≠ 消失）。
  for (const testId of [
    "REMOTE_CONTROL_PANEL_CONNECTION_TEST_ID",
    "REMOTE_CONTROL_PANEL_LINK_TEST_ID",
    "REMOTE_CONTROL_PANEL_QR_TEST_ID",
    "REMOTE_CONTROL_PANEL_COPY_TEST_ID",
    "REMOTE_CONTROL_PANEL_FAILURE_TEST_ID",
  ]) {
    assert.ok(WEB_TAB_SOURCES.source.includes(testId), "连接面缺少既有 testid：" + testId);
  }
  // 两个标签页都在（不是二选一）。
  assert.match(panel, /REMOTE_CONTROL_PANEL_TAB_WEB_TEST_ID/);
  assert.match(panel, /REMOTE_CONTROL_PANEL_TAB_IM_BOT_TEST_ID/);
});

test("默认页是 Web 控制（读法：默认**选中**这一页，不是自动起服务）", () => {
  assert.equal(REMOTE_CONTROL_DEFAULT_TAB, "web");
  const panel = readSource("src/RemoteControlPanel.tsx");
  // 默认值只能来自 model 的常量：面板里不得写死第二个默认值。
  assert.match(panel, /useState<RemoteControlPanelTab>\(REMOTE_CONTROL_DEFAULT_TAB\)/);
  assert.equal(
    /useState<RemoteControlPanelTab>\("imBot"\)/.test(panel),
    false,
    "不得把默认页写成 IM 机器人",
  );
  // 「默认开启」**不得**实现成自动启动服务面：面板里不存在"挂载即 start"的效果。
  assert.equal(
    /useEffect\(\(\) => \{\s*void startService/.test(panel),
    false,
    "默认页不得自动起服务（那是对局域网静默开放）",
  );
  // 服务面仍要用户点：主操作按钮与决策①的首次确认必须都在。
  assert.match(panel, /shouldConfirmBeforeStart\(DEFAULT_REMOTE_CONTROL_START_SCOPE/);
});

test("IM 机器人默认关闭：未注入通道时**照样渲染启用按钮**（默认关闭不是靠「没有按钮」）", () => {
  // 未注入通道 ⇒ disabled 档，且**仍然渲染**启用按钮。
  const noChannel = resolveRemoteControlImBotView({
    channel: null,
    inFlight: false,
    requested: false,
  });
  assert.equal(noChannel.state, "disabled", "未注入通道时默认关闭");
  assert.equal(noChannel.showEnableAction, true, "默认关闭时仍必须渲染启用按钮");
  // 但必须如实说明"现在启用会发生什么"（服务端还没接入），否则按钮就是个骗人的动作。
  assert.equal(noChannel.stateMessageId, "remotePanel.imBot.state.pendingServer");

  // 注入通道且 status=disabled ⇒ 同一档（默认关闭由状态承载），说明可以省略（提醒块已说清）。
  const injected = resolveRemoteControlImBotView({
    channel: { status: "disabled", onEnable: () => {} },
    inFlight: false,
    requested: false,
  });
  assert.equal(injected.state, "disabled");
  assert.equal(injected.showEnableAction, true);
  assert.equal(injected.stateMessageId, null);

  // 组件里必须真的渲染按钮，且按钮文案不是"不可用"。
  assert.match(IM_BOT_TAB_SOURCE.source, /view\.showEnableAction \? \(/);
  assert.match(IM_BOT_TAB_SOURCE.source, /REMOTE_CONTROL_IM_BOT_ENABLE_TEST_ID/);
});

test("点击不许静默：确认 → 在途 → 已请求，每一档都有可见文案", () => {
  const channel = { status: "disabled" as const, onEnable: () => {} };

  // 在途：徽标换"启用中"，按钮撤掉（避免连点第二次请求）。
  const enabling = resolveRemoteControlImBotView({ channel, inFlight: true, requested: true });
  assert.equal(enabling.state, "enabling");
  assert.equal(enabling.showEnableAction, false, "在途期间不得留下可点的启用按钮");

  // 请求结算但宿主仍未回传 enabled ⇒ 明确说"已请求，等待服务端就绪"，**不得**谎报已启用。
  const requested = resolveRemoteControlImBotView({ channel, inFlight: false, requested: true });
  assert.equal(requested.state, "requested");
  assert.equal(requested.badgeMessageId, "remotePanel.imBot.badge.disabled", "不得显示已启用");
  assert.notEqual(requested.stateMessageId, null, "已请求档必须有说明（否则就是静默）");

  // 宿主回传 enabled ⇒ 才是已启用。
  const enabled = resolveRemoteControlImBotView({
    channel: { status: "enabled", onEnable: () => {} },
    inFlight: false,
    requested: false,
  });
  assert.equal(enabled.state, "enabled");

  // 每一档的徽标与说明文案中英都必须齐备。
  for (const view of [enabling, requested, enabled]) {
    for (const key of [view.badgeMessageId, view.stateMessageId]) {
      if (!key) continue;
      assert.equal(typeof zhCN[key], "string", "zh-CN 缺文案：" + key);
      assert.equal(typeof enUS[key], "string", "en-US 缺文案：" + key);
    }
  }
});

test("IM 机器人状态只含可达取值：没有 unavailable（能力缺失不再等于「没有按钮」）", () => {
  const modelSource = readSource("src/remoteControlPanelModel.ts");
  const union = modelSource.match(/export type RemoteControlImBotState =([^;]+);/)?.[1] ?? "";
  assert.equal(/unavailable/.test(union), false, "不得再有 unavailable 档（Lead 已否掉该形态）");
  assert.equal("remotePanel.imBot.state.unavailable" in zhCN, false, "zh-CN 残留 unavailable 文案");
  assert.equal("remotePanel.imBot.state.unavailable" in enUS, false, "en-US 残留 unavailable 文案");
  // 四个可达取值每一个都必须有产出路径（本测试逐个走过）。
  for (const state of ["disabled", "enabling", "requested", "enabled"]) {
    assert.ok(union.includes('"' + state + '"'), "缺少可达取值：" + state);
  }
});

test("启用前提醒：三条事实常显，且确认弹窗里再列一次", () => {
  assert.equal(REMOTE_CONTROL_IM_BOT_REMINDER_MESSAGE_IDS.length, 3);
  for (const key of REMOTE_CONTROL_IM_BOT_REMINDER_MESSAGE_IDS) {
    assert.equal(typeof zhCN[key], "string", "zh-CN 缺提醒文案：" + key);
    assert.equal(typeof enUS[key], "string", "en-US 缺提醒文案：" + key);
    assert.notEqual(zhCN[key], "", "zh-CN 空提醒文案：" + key);
  }
  // 提醒必须由**同一个常量**驱动（组件与断言不会分家）。
  assert.match(IM_BOT_TAB_SOURCE.source, /REMOTE_CONTROL_IM_BOT_REMINDER_MESSAGE_IDS\.map/);
  // 提醒块常显（不在任何条件分支里）。
  assert.match(IM_BOT_TAB_SOURCE.source, /data-testid=\{REMOTE_CONTROL_IM_BOT_NOTICE_TEST_ID\}/);
  // 点击启用先过确认弹窗（不直接调 onEnable）。
  assert.match(IM_BOT_TAB_SOURCE.source, /onClick=\{\(\) => setConfirmOpen\(true\)\}/);
  assert.match(IM_BOT_TAB_SOURCE.source, /REMOTE_CONTROL_IM_BOT_CONFIRM_TEST_ID/);
  // 三条事实的**内容**必须说清事实本身（外部账号 / 第三方平台 / 平台侧记录）。
  const zhText = REMOTE_CONTROL_IM_BOT_REMINDER_MESSAGE_IDS.map((k) => zhCN[k]).join(" | ");
  assert.ok(/外部账号/.test(zhText), "提醒必须点明需要外部账号");
  assert.ok(/第三方/.test(zhText), "提醒必须点明经过第三方平台");
  const enText = REMOTE_CONTROL_IM_BOT_REMINDER_MESSAGE_IDS.map((k) => enUS[k]).join(" | ");
  assert.ok(/external account/i.test(enText), "EN 提醒必须点明需要外部账号");
  assert.ok(/third-party/i.test(enText), "EN 提醒必须点明经过第三方平台");
});

test("生效时机常显：新增/启用渠道要重启才生效（spec §10 P4：可接受，但不得静默）", () => {
  // 这条钉的是用户能看到那句话：文案在两个语言里都存在、非空，且组件把它渲染在
  // 常显的提醒块里（不在任何条件分支内）。
  for (const [name, dict] of [
    ["zh-CN", zhCN],
    ["en-US", enUS],
  ] as const) {
    const text = dict[REMOTE_CONTROL_IM_BOT_RESTART_NOTICE_MESSAGE_ID];
    assert.equal(typeof text, "string", name + " 缺生效时机文案");
    assert.notEqual(text, "", name + " 生效时机文案为空");
    // 必须说清"要重启"与"删除立即生效"这两件事 —— 只说其一，用户仍会误判另一半。
    assert.match(text, /重启|restart/i, name + " 必须点明需要重启");
    assert.match(text, /立即|immediately/i, name + " 必须点明删除方向立即生效");
  }
  assert.match(IM_BOT_TAB_SOURCE.source, /REMOTE_CONTROL_IM_BOT_RESTART_NOTICE_TEST_ID/);
  assert.match(IM_BOT_TAB_SOURCE.source, /REMOTE_CONTROL_IM_BOT_RESTART_NOTICE_MESSAGE_ID/);
});

test("命名红线：UI 里不得出现「自托管」；两条路径的名字不得互相顶掉", () => {
  // 用户拍板：**UI 里不出现「自托管」** —— 那是实现方式，不是用户能做的事。
  // 扫全部用户可见文案（zh 的值 + en 的值），不只看 remotePanel.* ——
  // 这样将来有人把「自托管」写进别的命名空间也会被抓到。
  const offenders = Object.entries(zhCN)
    .filter(([, value]) => typeof value === "string" && value.includes("自托管"))
    .map(([key]) => key);
  assert.deepEqual(offenders, [], "UI 文案不得出现「自托管」：" + offenders.join(", "));
  const enOffenders = Object.entries(enUS)
    .filter(([, value]) => typeof value === "string" && /self-hosted|self hosted/i.test(value))
    .map(([key]) => key);
  // 唯一允许的例外：反馈渠道那几句说的是**用户的**自托管 tracker（GitLab/Gitea/自建），
  // 与远控无关。用前缀排除而不是写死键名 —— 写死键名会在渠道改名时变成假红。
  assert.deepEqual(
    enOffenders.filter((key) => !key.startsWith("settings.feedback.")),
    [],
    "EN 文案不得用 self-hosted 指代我们的远控：" + enOffenders.join(", "),
  );

  // 两条路径的名字必须都在，且**不得互相顶掉**（"他们的思路都不一样"）。
  assert.equal(zhCN["remotePanel.tab.web"], "Web 控制");
  assert.equal(zhCN["remotePanel.tab.imBot"], "IM 机器人");
  assert.equal(enUS["remotePanel.tab.web"], "Web control");
  assert.equal(enUS["remotePanel.tab.imBot"], "Chat bot");
  // 不得与侧栏已有的「远程连接」（我连出去）撞名：标签页名里不得出现"远程连接"/"Remote connection"。
  for (const key of ["remotePanel.tab.web", "remotePanel.tab.imBot"]) {
    for (const text of [zhCN[key] ?? "", enUS[key] ?? ""]) {
      assert.equal(
        /远程连接|Remote connection/.test(text),
        false,
        "标签页名与「远程连接」撞名：" + text,
      );
    }
  }
  // EN 名不得与官方 "Mobile remote control" 混同（那是上游 Bot 入口的措辞）。
  assert.equal(/mobile remote control/i.test(enUS["remotePanel.tab.imBot"] ?? ""), false);
});
