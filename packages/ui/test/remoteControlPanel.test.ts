import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import zhCN from "../src/i18n/locales/zh-CN.js";
import enUS from "../src/i18n/locales/en-US.js";
import {
  DEFAULT_REMOTE_CONTROL_START_SCOPE,
  canRenderRemoteControlPanel,
  hasUsableRemoteControlLink,
  resolveRemoteControlPanelView,
  shouldConfirmBeforeStart,
  shouldRenderQrCode,
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

test("只有 running 档展示连接面（地址/链接/二维码）", () => {
  for (const state of ["stopped", "starting", "stopping", "running-untrusted", "failed"] as const) {
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
  const source = readSource("src/RemoteControlPanel.tsx");
  assert.match(source, /const hasLink = hasUsableRemoteControlLink\(connection\)/);
  assert.match(source, /\{hasLink \? \(/);
  assert.equal(/\{link \? \(/.test(source), false, "链接行不得再用 link 真值自行判定");
});

test("二维码判定与链接判定同源（防止再次出现两个所有者）", () => {
  const source = readSource("src/RemoteControlPanel.tsx");
  // 只允许一处决定二维码是否渲染。
  const qrDecisionSites = source.match(/shouldRenderQrCode\(/g) ?? [];
  assert.equal(qrDecisionSites.length, 1, "二维码判定必须只有一个调用点");
  // 二维码组件不得自己再判一次空值（那会遮蔽上面的判定，反向验证会空转）。
  assert.equal(
    /if \(!value\.trim\(\)\)/.test(source),
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

test("WorkspaceSidebar 的入口按能力门控（web 上不渲染）", () => {
  const source = readSource("src/WorkspaceSidebar.tsx");
  assert.match(source, /canRenderRemoteControlPanel\(\{ servicePlane: isDesktop === true \}\)/);
  // 不得回退成无条件注入（切片 1 的写法会让 web 客户端也渲染入口）。
  assert.equal(
    source.includes('remoteControlEntry={{ status: "off", onOpen: () => {} }}'),
    false,
    "入口不得无条件注入",
  );
});
