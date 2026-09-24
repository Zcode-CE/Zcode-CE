import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLoopbackExposureRefusal,
  buildProxySignalWithoutTokenWarning,
  collectExposureSignals,
  refusalSignals,
  type ExposureSignal,
} from "../src/exposureGate.js";
import { parseTrustedHosts, buildTrustedHostEntries } from "../src/hostAllowlist.js";
import { parseTrustedProxies } from "../src/authThrottle.js";
import { parseTrustedOrigins } from "../src/webExposureGuard.js";

/**
 * 「回环绑定 + 外部访问信号 ⇒ 也要令牌」的判据（本批加固的核心）。
 *
 * ## 为什么这组断言必须有牙
 *
 * 加固前的绕过路径是**完整可用**的，而且四道闸每一道单独看都"没问题"：
 * ① 非回环才强制令牌（判据只看监听地址）⇒ 绑回环时令牌允许关闭；
 * ② 运维把回环端口放到同机反代/隧道/容器映射之后 ⇒ 请求对端就是回环，令牌那道闸不生效；
 * ③ Host 白名单挡不住（攻击者自己写 `Host: 127.0.0.1` 就在白名单里）；
 * ④ 来源校验对不带 `Origin` 的客户端放行（为 CLI/桌面留的取舍），而 `curl` 恰好不带。
 * ⇒ 一个 curl 就是无需令牌的完全控制权。
 *
 * 因此**否定式**断言（"不该拒绝的组合必须不拒绝"）与肯定式同样重要：判据一旦写宽
 * （例如把"设置了环境变量"当成信号），正常用户的 `--web` 会直接起不来。
 *
 * ## 反向验证（实测过）
 * 把 `assertListenSecurity` 里新增的 `if (signals.length > 0 && !hasUsableSource)` 分支删掉
 * ⇒ `exposureGateHttp.test.ts` 的「回环 + 登记域名 + 无令牌 ⇒ 拒绝启动」与
 * 「真实入口进程：… 起不来」两条立刻变红（本文件的纯函数断言不受影响，因为它测的是判据本身、
 * 不是接线）—— 这正是"判据"与"接线"要分开钉的原因。
 */

// ---------------------------------------------------------------------------
// 一、信号判定（纯函数）
// ---------------------------------------------------------------------------

test("信号：三类各自单独就构成信号，都没有则不是信号", () => {
  assert.deepEqual(
    collectExposureSignals({ trustedProxies: [], configuredTrustedHosts: [], trustedOrigins: [] }),
    [],
    "三个都没有 ⇒ 不是信号（默认部署必须保持可关令牌）",
  );

  const byProxy = collectExposureSignals({
    trustedProxies: parseTrustedProxies("127.0.0.1,10.0.0.0/8"),
  });
  assert.equal(byProxy.length, 1);
  assert.equal(byProxy[0]!.kind, "trusted-proxies");
  assert.deepEqual(byProxy[0]!.entries, ["127.0.0.1", "10.0.0.0/8"], "生效项要能被人核对");

  const byHost = collectExposureSignals({
    configuredTrustedHosts: [{ host: "panel.example", label: "configured" }],
  });
  assert.equal(byHost.length, 1);
  assert.equal(byHost[0]!.kind, "trusted-hosts");
  assert.deepEqual(byHost[0]!.entries, ["panel.example"]);

  const byOrigin = collectExposureSignals({
    trustedOrigins: parseTrustedOrigins("https://ui.example"),
  });
  assert.equal(byOrigin.length, 1);
  assert.equal(byOrigin[0]!.kind, "trusted-origins");
  assert.deepEqual(byOrigin[0]!.entries, ["https://ui.example"]);

  const all = collectExposureSignals({
    trustedProxies: parseTrustedProxies("127.0.0.1"),
    configuredTrustedHosts: [{ host: "panel.example", port: 8443, label: "configured" }],
    trustedOrigins: parseTrustedOrigins("https://ui.example"),
  });
  assert.deepEqual(
    all.map((signal) => signal.kind),
    ["trusted-proxies", "trusted-hosts", "trusted-origins"],
    "三个信号都要报出来（运维才知道该去掉哪一个）",
  );
  assert.deepEqual(all[1]!.entries, ["panel.example:8443"], "带端口的登记项要原样展示");
});

test("信号：**非法值被丢弃后不算信号**（一个写错的域名不该让服务起不来）", () => {
  // 与 parseTrustedProxies / parseTrustedHosts / parseTrustedOrigins 的既有取舍一致：非法项静默丢弃。
  assert.deepEqual(parseTrustedHosts("host:abc"), [], "非法 Host 项被丢弃");
  assert.deepEqual(parseTrustedProxies("not-an-ip"), [], "非法代理项被丢弃");
  assert.deepEqual(parseTrustedOrigins("not a url"), [], "非法来源项被丢弃");
  assert.deepEqual(
    collectExposureSignals({
      trustedProxies: parseTrustedProxies("not-an-ip,,"),
      configuredTrustedHosts: parseTrustedHosts("host:abc,   "),
      trustedOrigins: parseTrustedOrigins("   "),
    }),
    [],
    "解析后 0 条生效项 ⇒ 不是信号（判据读的是生效项，不是环境变量）",
  );
});

test("信号：默认白名单条目（回环/网卡/监听地址）不算信号，只有 label=configured 才算", () => {
  // 这条钉住接线口径：http.ts 用 `label === "configured"` 把"运维登记"与"默认项"分开。
  const entries = buildTrustedHostEntries({
    configuredEntries: [{ host: "panel.example" }],
    listenHost: "127.0.0.1",
    extraLocalAddresses: ["10.9.9.9"],
  });
  assert.deepEqual(
    entries.filter((entry) => entry.label === "configured").map((entry) => entry.host),
    ["panel.example"],
    "默认项（loopback/interface/listen）绝不能进 configured —— 否则默认部署会被误判成有信号",
  );
  assert.deepEqual(
    buildTrustedHostEntries({ listenHost: "127.0.0.1", extraLocalAddresses: [] }).filter(
      (entry) => entry.label === "configured",
    ),
    [],
    "没登记任何域名时 configured 必须为空",
  );
});

test("**只有跨源白名单不算拒绝信号**（它是告警类，不是拒绝类）", () => {
  const signals = collectExposureSignals({
    trustedOrigins: parseTrustedOrigins("https://ui.example"),
  });
  assert.equal(signals.length, 1, "它确实是信号");
  assert.deepEqual(
    refusalSignals(signals),
    [],
    "但它**不参与拒绝**：只登记它是此前能起来的一种部署形态，把配错升级成起不来会打死合法路径",
  );
  // 另外两类必须参与拒绝。
  assert.equal(
    refusalSignals(collectExposureSignals({ trustedProxies: parseTrustedProxies("127.0.0.1") }))
      .length,
    1,
  );
  assert.equal(
    refusalSignals(
      collectExposureSignals({
        configuredTrustedHosts: [{ host: "panel.example", label: "configured" }],
      }),
    ).length,
    1,
  );
});

// ---------------------------------------------------------------------------
// 二、拒绝启动的文案（可操作性）
// ---------------------------------------------------------------------------

test("拒绝文案必须可操作：说清为什么 + 给出两条修法（配令牌 / 去掉登记项）", () => {
  const signals = refusalSignals(
    collectExposureSignals({
      trustedProxies: parseTrustedProxies("127.0.0.1"),
      configuredTrustedHosts: [{ host: "panel.example", label: "configured" }],
    }),
  );
  const message = buildLoopbackExposureRefusal({ host: "127.0.0.1", signals });
  for (const fragment of [
    "拒绝启动",
    "127.0.0.1",
    "ZCODE_SERVER_TRUSTED_PROXIES",
    "ZCODE_SERVER_TRUSTED_HOSTS",
    "panel.example",
    "Host: 127.0.0.1",
    "Origin",
    "curl",
    "ZCODE_SERVER_AUTH_TOKEN",
    "ZCODE_SERVER_AUTH_TOKENS_FILE",
  ]) {
    assert.ok(message.includes(fragment), "拒绝文案缺少关键信息：" + fragment);
  }
  assert.match(message, /1\. 配一个令牌/);
  assert.match(message, /2\. 或去掉上面那些登记项/);
});

// ---------------------------------------------------------------------------
// 三、告警（B）的可达性 —— **穷尽矩阵，不许造一个永不触发的分支**
// ---------------------------------------------------------------------------

/** 造一份信号集合（用真实解析器，避免手搓出实现里不存在的形状）。 */
function signalsOf(kinds: readonly ("proxies" | "hosts" | "origins")[]): ExposureSignal[] {
  return collectExposureSignals({
    ...(kinds.includes("proxies") ? { trustedProxies: parseTrustedProxies("127.0.0.1") } : {}),
    ...(kinds.includes("hosts")
      ? { configuredTrustedHosts: [{ host: "panel.example", label: "configured" }] }
      : {}),
    ...(kinds.includes("origins")
      ? { trustedOrigins: parseTrustedOrigins("https://ui.example") }
      : {}),
  });
}

/**
 * 拒绝判定的**独立复刻**（只用于交叉校验：它必须与 http.ts 里 `assertListenSecurity` 的分支一致）。
 * 写成独立实现是刻意的 —— 如果直接调 assertListenSecurity，就变成"用实现验证实现"。
 */
function wouldRefuse(params: {
  loopback: boolean;
  signals: readonly ExposureSignal[];
  hasUsableToken: boolean;
}): boolean {
  if (params.loopback) {
    return refusalSignals(params.signals).length > 0 && !params.hasUsableToken;
  }
  return !params.hasUsableToken;
}

test("告警可达性矩阵（穷尽 2×3×2）：**被拒绝的组合必须返回 null**，且**必须存在会触发的格子**", () => {
  const kindsList: readonly (readonly ("proxies" | "hosts" | "origins")[])[] = [
    [],
    ["origins"],
    ["hosts"],
    ["proxies"],
    ["origins", "hosts"],
    ["origins", "proxies"],
    ["hosts", "proxies"],
    ["origins", "hosts", "proxies"],
  ];
  const rows: string[] = [];
  let fired = 0;
  for (const loopback of [true, false]) {
    for (const hasToken of [true, false]) {
      for (const kinds of kindsList) {
        const signals = signalsOf(kinds);
        const refused = wouldRefuse({ loopback, signals, hasUsableToken: hasToken });
        const warning = buildProxySignalWithoutTokenWarning({
          host: loopback ? "127.0.0.1" : "0.0.0.0",
          signals,
          tokenSourceEnabled: hasToken,
          loopback,
        });
        const label =
          "loopback=" +
          String(loopback) +
          " token=" +
          String(hasToken) +
          " signals=[" +
          kinds.join(",") +
          "]";
        if (refused) {
          assert.equal(
            warning,
            null,
            label + " 这一档已经被 assertListenSecurity 拒绝启动 ⇒ 告警必须是 null（否则是死分支）",
          );
        }
        if (warning !== null) {
          fired += 1;
          assert.equal(refused, false, label + " 告警与拒绝不得同时发生（两种状态必须互斥）");
          rows.push(label);
        }
      }
    }
  }
  assert.ok(fired > 0, "必须存在至少一格会触发告警 —— 否则 (B) 就是永不触发的死分支");
  // 如实记录**唯一**会触发的形态（这条断言是"我确实想过可达性"的证据，不是装饰）。
  assert.deepEqual(
    rows.sort(),
    ["loopback=true token=false signals=[origins]"],
    "唯一可达的告警形态：回环 + 只有跨源白名单这一条信号 + 没有任何可用令牌。实际：" +
      JSON.stringify(rows),
  );
});

test("告警：正常组合（有令牌 / 无信号）**不得**产生噪音", () => {
  const withProxy = signalsOf(["proxies"]);
  assert.equal(
    buildProxySignalWithoutTokenWarning({
      host: "127.0.0.1",
      signals: withProxy,
      tokenSourceEnabled: true,
      loopback: true,
    }),
    null,
    "有可用令牌 ⇒ 不告警",
  );
  assert.equal(
    buildProxySignalWithoutTokenWarning({
      host: "127.0.0.1",
      signals: [],
      tokenSourceEnabled: false,
      loopback: true,
    }),
    null,
    "没有外部访问信号（纯本机部署）⇒ 不告警（回环下不配令牌是合法形态）",
  );
});

test("告警文案必须写明后果（域名/来源 + 完全控制工作台 + 修法）", () => {
  const message = buildProxySignalWithoutTokenWarning({
    host: "127.0.0.1",
    signals: signalsOf(["origins"]),
    tokenSourceEnabled: false,
    loopback: true,
  });
  assert.ok(message, "这一档必须触发");
  for (const fragment of [
    "暴露面提醒",
    "https://ui.example",
    "完全控制本机工作台",
    "bind=127.0.0.1",
    "token-auth=disabled",
    "非回环",
    "ZCODE_SERVER_AUTH_TOKEN",
    "ZCODE_SERVER_TRUSTED_ORIGINS",
  ]) {
    assert.ok(message!.includes(fragment), "告警缺少关键信息：" + fragment);
  }
});
