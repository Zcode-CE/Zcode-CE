import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

/**
 * ce.4 连接面的真实 DOM 断言（task-17）。
 *
 * 为什么必须渲染真组件而不是只测纯函数：spec §6.5 决策④ 的判据是
 * "DOM 里存在设备清单与断开、不存在令牌轮换入口" —— 那是关于渲染结果的断言。
 * 纯函数测试只能证明"判定返回了什么"，证明不了"那个区块有没有进 DOM"。
 * 本项目已有先例与同一手法：guidedTerminalDelivery.test.ts:372 用 react-dom/server
 * 渲染真实组件树，断言最终 HTML 里有没有那个按钮。
 *
 * 反向验证（把门控去掉 ⇒ 断言必须变红）的复现方式见文件末尾的注释块。
 *
 * 运行：cd packages/ui && node --import tsx --test test/remoteControlConnectionsDom.test.ts
 */

/** 渲染面板并返回 HTML。provider 与真浏览器里一致（Tooltip + Intl）。 */
async function renderPanel(props: Record<string, unknown>): Promise<string> {
  const [{ RemoteControlPanel }, { ZCodeIntlProvider }, { TooltipProvider }] = await Promise.all([
    import("../src/RemoteControlPanel.js"),
    import("../src/i18n/IntlProvider.js"),
    import("../src/components/ui/tooltip.js"),
  ]);
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(RemoteControlPanel, {
          status: { state: "running", adopted: false, loopback: false },
          connection: {
            url: "http://10.0.0.5:3030",
            linkWithToken: "http://10.0.0.5:3030/?token=t",
          },
          onStart: () => {},
          onStop: () => {},
          showHeader: false,
          ...props,
        } as never),
      ),
    ),
  );
}

const CONNECTIONS = {
  connections: [
    {
      id: "c1",
      address: "192.168.1.20",
      role: "terminal-client" as const,
      userAgent: "Mozilla/5.0 (iPhone)",
      connectedAt: 1_760_000_000_000,
    },
  ],
  revision: 7,
};

test("DOM：桌面面板存在设备清单、断开单个、全部断开", async () => {
  const html = await renderPanel({
    connections: CONNECTIONS,
    onRevokeConnection: () => {},
  });
  assert.ok(html.includes("remote-control-devices"), "设备清单区块必须进 DOM");
  assert.ok(html.includes("remote-control-device-row"), "设备行必须进 DOM");
  assert.ok(html.includes("remote-control-device-revoke-one"), "断开单个必须进 DOM");
  assert.ok(html.includes("remote-control-device-revoke-all"), "全部断开必须进 DOM");
  // 设备行的四个事实都在：地址、角色、连接时间、客户端。
  assert.ok(html.includes("192.168.1.20"), "地址必须在 DOM 里");
  assert.ok(html.includes("浏览器"), "角色必须渲染成用户看得懂的词（不是枚举值）");
  assert.ok(html.includes("Mozilla/5.0 (iPhone)"), "客户端 UA 必须在 DOM 里");
  // 协议枚举值只允许出现在机器可读属性里（DOM 断言要用），不得出现在用户可见文本里。
  // 把标签与属性都剥掉后再看文本层 —— 直接 includes 会把属性也算进来，那是判据口径错了。
  const visibleText = html.replace(/<[^>]*>/g, "");
  assert.equal(
    visibleText.includes("terminal-client"),
    false,
    "不得把协议枚举值渲染成用户可见文本",
  );
  assert.ok(
    html.includes('data-remote-control-device-role="terminal-client"'),
    "角色必须同时有机器可读属性（探针据此断言）",
  );
  // 连接时间按 locale 格式化（不是裸时间戳）。
  assert.equal(html.includes("1760000000000"), false, "连接时间必须格式化后渲染");
});

test("DOM：桌面面板存在令牌轮换入口（决策④：只有桌面才有）", async () => {
  const html = await renderPanel({
    connections: CONNECTIONS,
    onRevokeConnection: () => {},
    onRotateToken: () => {},
  });
  assert.ok(html.includes("remote-control-rotate-token"), "桌面面板必须有令牌轮换入口");
  assert.ok(html.includes("轮换令牌"), "轮换入口的文案必须进 DOM");
});

/* ────────────────────────────────────────────────────────────────────────────
 * 反向验证的核心两条：把能力门控去掉 ⇒ 下面两条断言必须变红。
 *
 * 复现方式（已实测，结果见 .reverse/98-ce4/IMPL-CONNECTIONS-UI.md）：
 *   ① 把 RemoteControlServiceSection.tsx 的 `{onRotateToken ? (` 改成 `{true ? (`
 *      （无视能力、无条件渲染轮换）⇒ 「Web 能力下轮换不存在」变红；
 *   ② 把 RemoteControlDevicesSection.tsx 的 `{onRevoke ? (` 与
 *      `onRevoke && rows.length > 0 ? (` 各改成无条件 ⇒ 「Web 能力下断开不存在」变红。
 * 门控是唯一决定区块在不在 DOM 里的东西，去掉它必须立刻可见。
 * ──────────────────────────────────────────────────────────────────────────── */

test("DOM：Web 能力（无断开/无轮换动作）下，这两个区块不存在（不是 disabled）", async () => {
  // Web 客户端不提供任何连接面动作 ⇒ 面板拿到的两个动作都是 undefined。
  const html = await renderPanel({ connections: CONNECTIONS });
  assert.equal(
    html.includes("remote-control-device-revoke-one"),
    false,
    "Web 面板不得有断开单个（能力缺失 ⇒ 不渲染）",
  );
  assert.equal(html.includes("remote-control-device-revoke-all"), false, "Web 面板不得有全部断开");
  assert.equal(
    html.includes("remote-control-rotate-token"),
    false,
    "Web 面板不得有令牌轮换入口（spec §6.5 决策④）",
  );
  // 「不显示 vs 禁用」：不得以 disabled 形式出现。
  assert.equal(
    /remote-control-(device-revoke|rotate-token)[^>]*disabled/.test(html),
    false,
    "不得渲染成 disabled（那会承诺一个不存在的动作）",
  );
  // 但设备清单本身仍在（连接面在 Web 上照样显示"谁连着"）。
  assert.ok(html.includes("remote-control-devices"), "设备清单在 Web 面板上仍然存在");
  assert.ok(html.includes("192.168.1.20"));
});

test("DOM：读不到（connections=null）时显示如实说明，不显示「暂无设备」", async () => {
  const html = await renderPanel({ connections: null, onRevokeConnection: () => {} });
  assert.ok(html.includes("暂时读不到已连设备"), "读不到必须如实说");
  assert.equal(html.includes("暂无设备"), false, "读不到时不得断言「暂无设备」");
  assert.ok(html.includes('data-remote-control-devices="unknown"'), "读不到的档位必须可断言");
  // 读不到时也不该出现"全部断开"（不知道有几台，断谁都不对）。
  assert.equal(html.includes("remote-control-device-revoke-all"), false);
});

test("DOM：空数组（确实 0 台）时显示「暂无设备」，且不渲染全部断开", async () => {
  const html = await renderPanel({
    connections: { connections: [], revision: 1 },
    onRevokeConnection: () => {},
  });
  assert.ok(html.includes("暂无设备"), "0 台时必须说「暂无设备」");
  assert.equal(html.includes("暂时读不到已连设备"), false);
  assert.ok(html.includes('data-remote-control-devices="empty"'), "空态档位必须可断言");
  // 0 台时渲染"全部断开"是承诺一个无事可做的动作。
  assert.equal(html.includes("remote-control-device-revoke-all"), false, "0 台时不得渲染全部断开");
  assert.equal(html.includes("remote-control-device-row"), false, "0 台时不得有设备行");
});

test("DOM：运行中监听范围锁定，且给出「仅本机」这个可生效的动作", async () => {
  const html = await renderPanel({ onRotateToken: () => {} });
  // 运行中：两个监听范围选项都必须锁定（改了不生效）。
  assert.ok(html.includes('data-remote-control-listen-locked="true"'), "运行中必须锁定监听范围");
  assert.ok(html.includes("remote-control-listen-scope-loopback"), "运行中非回环必须给一键切回环");
  // 端口输入同样锁定。
  assert.match(
    html,
    /id="remote-control-port"[^>]*disabled|disabled[^>]*id="remote-control-port"/,
    "运行中端口输入必须锁定",
  );
});

test("DOM：非运行档不锁定监听范围（下次开启用什么由用户选）", async () => {
  const [{ RemoteControlPanel }, { ZCodeIntlProvider }, { TooltipProvider }] = await Promise.all([
    import("../src/RemoteControlPanel.js"),
    import("../src/i18n/IntlProvider.js"),
    import("../src/components/ui/tooltip.js"),
  ]);
  const html = renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(RemoteControlPanel, {
          status: { state: "stopped", adopted: false, loopback: true },
          onStart: () => {},
          onStop: () => {},
          showHeader: false,
        } as never),
      ),
    ),
  );
  assert.ok(html.includes('data-remote-control-listen-locked="false"'), "未运行时监听范围可选");
  // 未运行 ⇒ 不展示连接面（也就没有设备清单与切回环）。
  assert.equal(html.includes("remote-control-devices"), false, "未运行时连接面不展示");
  assert.equal(html.includes("remote-control-listen-scope-loopback"), false);
});
/* ────────────────────────────────────────────────────────────────────────────
 * 入口的触屏可发现性（spec §3.7 硬要求）与 waiting 状态承载。
 *
 * 判据：无 hover 的窄屏下，不看 tooltip 也能看出"有这个入口 + 当前状态"。
 * 这里从渲染结果验：状态词必须真的进了 DOM（不是只在源码里写了个类名），
 * 且三个状态渲染出的文本互不相同 —— 否则"常显"也只是常显同一个词。
 * ──────────────────────────────────────────────────────────────────────────── */

async function renderEntry(status: string): Promise<string> {
  const [{ RemoteControlEntryButton }, { ZCodeIntlProvider }, { TooltipProvider }] =
    await Promise.all([
      import("../src/RemoteControlEntryButton.js"),
      import("../src/i18n/IntlProvider.js"),
      import("../src/components/ui/tooltip.js"),
    ]);
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(RemoteControlEntryButton, {
          entry: { status, onOpen: () => {} },
        } as never),
      ),
    ),
  );
}

test("DOM：入口在无 hover 设备上常显状态词（不看 tooltip 也能看出状态）", async () => {
  const html = await renderEntry("waiting");
  assert.ok(html.includes("remote-control-entry-status"), "常显状态词必须进 DOM");
  assert.ok(html.includes("等待连接"), "waiting 的状态词必须进 DOM");
  assert.match(html, /class="[^"]*\[@media\(hover:none\)\]:inline[^"]*"/, "必须在无 hover 时显示");
  assert.match(html, /class="hidden [^"]*\[@media\(hover:none\)\]:inline/);
  assert.ok(html.includes('data-remote-control-status="waiting"'), "入口状态必须可机器读");
  assert.ok(html.includes('data-remote-control-status-label="waiting"'));
});

test("DOM：三个入口状态渲染出三个互不相同的状态词（三态不能看起来一样）", async () => {
  const texts: string[] = [];
  for (const status of ["off", "running", "waiting"]) {
    const html = await renderEntry(status);
    const match = html.match(/data-remote-control-status-label="[^"]*"[^>]*>([^<]*)</);
    assert.ok(match, status + " 的状态词没渲染出来");
    texts.push(match[1] ?? "");
  }
  assert.equal(new Set(texts).size, 3, "三个状态的状态词必须互不相同：" + texts.join(" / "));
  assert.deepEqual(texts, ["未开启", "运行中", "等待连接"]);
});
