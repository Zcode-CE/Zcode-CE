import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildFeedbackEntryBody,
  buildFeedbackEntryDiagnostics,
  buildFeedbackEntryUrl,
  resolveFeedbackEntryTitle,
} from "../src/feedback/feedbackEntryPlan.js";
import {
  consumeFeedbackEntryContext,
  setFeedbackEntryContext,
} from "../src/feedback/feedbackEntryContext.js";
import { DEFAULT_FEEDBACK_REPOSITORY_URL } from "../src/feedback/feedbackDiagnostics.js";
import type { FeedbackDiagnosticsPreference } from "../src/feedback/feedbackDiagnosticsPreference.js";

/**
 * 反馈入口接线的回归测试。
 *
 * 背景：8 个既有入口（错误横幅、任务菜单、帮助菜单、远程连接失败页…）原本都直接打开官方工单弹窗，
 * 现在统一改走「反馈与诊断」的渠道配置。这条链路上有两类必须锁死的行为：
 *
 * 1. **fail-closed**：渠道关闭、自定义地址非法（含 javascript: / data: / file:）时，
 *    绝不能把地址交给 platform.openExternal —— 这是 P3 已修复的安全边界，入口侧必须同样遵守；
 * 2. **脱敏**：入口带上来的错误摘要会进入对外可见的预填正文与 **issue 标题**，
 *    deviceMid / hostname 等设备身份、以及 JWT / api_key / password / token 等凭据
 *    绝不能跟着泄漏。
 *
 * 第 2 类里的**凭据哨兵**是 V-3 修复后补的：改造初期只有 description 一条路（构造器内部已脱敏），
 * 新增的 errorSummary 与「标题」路径都直接传原文，实测 4 组载荷全部原样进了最终 URL。
 * 现在统一在 feedbackEntryPlan 收口，这组用例锁死四条路径（errorSummary / title / description /
 * 设置页手输）都不再泄漏。
 *
 * 运行：cd packages/ui && node --import tsx --test test/feedbackEntryWiring.test.ts
 */

/** 与 P3 单测同款的哨兵值：一旦出现在预填内容里就说明脱敏被破坏。 */
const DEVICE_SNAPSHOT = {
  appVersion: "3.14.0",
  buildCommitId: "872ad96",
  buildTime: "2026-09-21T00:00:00Z",
  osPlatform: "darwin",
  osArch: "arm64",
  deviceMid: "SENTINEL-DEVICE-MID",
  hostname: "sentinel-host",
};

const FORBIDDEN_TOKENS = ["SENTINEL-DEVICE-MID", "sentinel-host", "deviceMid", "hostname"];

const ALL_FIELDS: FeedbackDiagnosticsPreference["diagnosticFields"] = [
  "app",
  "runtime",
  "error",
  "notes",
];

function preference(
  patch: Partial<FeedbackDiagnosticsPreference> = {},
): FeedbackDiagnosticsPreference {
  return {
    channel: "github",
    customUrlTemplate: "",
    diagnosticFields: ALL_FIELDS,
    ...patch,
  };
}

/** 测试用最小 formatMessage：直接回显 key，避免依赖 i18n 运行时。 */
const formatMessage = (id: string): string => id;

const LOCALE = "zh-CN" as const;

function buildUrl(
  pref: FeedbackDiagnosticsPreference,
  context: Parameters<typeof buildFeedbackEntryUrl>[0]["context"],
  runtime?: { device: typeof DEVICE_SNAPSHOT },
) {
  return buildFeedbackEntryUrl({
    preference: pref,
    context,
    locale: LOCALE,
    formatMessage,
    ...(runtime ? { runtime } : {}),
  });
}

test("入口默认走 GitHub 预填链接，且错误摘要进入正文", () => {
  const url = buildUrl(preference(), { errorSummary: "连接超时 ECONNRESET" });
  assert.ok(url, "默认渠道应生成链接");
  assert.ok(url.startsWith(`${DEFAULT_FEEDBACK_REPOSITORY_URL}/issues/new?`), url);
  // 错误摘要必须真的被带进 body，否则「接线」只做了一半。
  // 注意：查询参数里的空格会被 URLSearchParams 编码成 "+"（而非 %20），
  // 所以这里用 URL 解码 + "+" 还原成空格后再比对，避免断言被编码细节绊倒。
  const decoded = decodeURIComponent(url).replaceAll("+", " ");
  assert.ok(decoded.includes("连接超时 ECONNRESET"), url);
});

test("渠道关闭时不产出任何可打开地址（fail-closed）", () => {
  assert.equal(buildUrl(preference({ channel: "off" }), { errorSummary: "x" }), null);
});

test("自定义地址非法或为危险 scheme 时一律返回 null，不产出半成品链接", () => {
  const cases = [
    "",
    "   ",
    "not a url",
    // 安全边界：这些 URL 都能通过 new URL() 解析，放行会在用户点击时执行脚本 / 读取本地文件。
    "javascript:alert(1)",
    "data:text/html,<script>x</script>",
    "file:///etc/passwd",
    "vbscript:msgbox(1)",
  ];
  for (const customUrlTemplate of cases) {
    assert.equal(
      buildUrl(preference({ channel: "custom", customUrlTemplate }), { errorSummary: "x" }),
      null,
      `自定义模板 ${JSON.stringify(customUrlTemplate)} 应返回 null`,
    );
  }
});

test("自定义地址合法时生成对应链接", () => {
  const url = buildUrl(
    preference({ channel: "custom", customUrlTemplate: "https://gitea.example/new" }),
    { errorSummary: "崩溃了" },
  );
  assert.ok(url, "合法自定义地址应生成链接");
  assert.ok(url.startsWith("https://gitea.example/new?"), url);
});

/**
 * 凭据哨兵：与 security-reviewer 复查 V-3 时使用的载荷对齐。
 *
 * 每组给出「完整载荷」与「必须消失的秘密子串」——只断言整串不出现是不够的，
 * 脱敏可能把秘密截断成仍可利用的前缀，所以直接断言秘密本身。
 */
const CREDENTIAL_PAYLOADS: ReadonlyArray<{
  name: string;
  payload: string;
  secret: string;
}> = [
  {
    name: "Bearer JWT",
    payload:
      "请求失败 Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    secret: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
  },
  {
    name: "URL query api_key",
    payload: "连接被拒绝 https://api.example.com/v1/chat?api_key=sk-live-51H8xQ2mNp7Rw9Tz",
    secret: "sk-live-51H8xQ2mNp7Rw9Tz",
  },
  {
    name: "password assignment",
    payload: "认证失败 password=hunter2",
    secret: "hunter2",
  },
  {
    name: "JSON token field",
    payload: '解析错误 {"token":"ghp_16C7e42F292c6912E7710c838347Ae178B4a"}',
    secret: "ghp_16C7e42F292c6912E7710c838347Ae178B4a",
  },
];

/** URL 解码并把 "+" 还原成空格，避免断言被编码细节绊倒。 */
function normalizeUrl(url: string | null): string {
  return decodeURIComponent(url ?? "").replaceAll("+", " ");
}

test("凭据绝不进入最终 URL —— errorSummary / title / description 三条入口路径全覆盖", () => {
  // V-3：改造初期 errorSummary 与 title 都直接传原文，4 组载荷全部泄漏。
  // 三条路径分开断言，任何一条回归都会单独失败，而不是被另一条掩盖。
  const paths: ReadonlyArray<{
    name: string;
    context: (payload: string) => Parameters<typeof buildFeedbackEntryUrl>[0]["context"];
  }> = [
    { name: "errorSummary", context: (payload) => ({ errorSummary: payload }) },
    { name: "title", context: (payload) => ({ title: payload, errorSummary: "占位" }) },
    { name: "description", context: (payload) => ({ description: payload }) },
  ];

  for (const { name, context } of paths) {
    for (const { name: payloadName, payload, secret } of CREDENTIAL_PAYLOADS) {
      const url = buildFeedbackEntryUrl({
        preference: preference(),
        context: context(payload),
        locale: LOCALE,
        formatMessage,
      });
      assert.ok(url, `${name}/${payloadName}: 应生成链接`);
      assert.equal(
        normalizeUrl(url).includes(secret),
        false,
        `${name} 路径泄漏了 ${payloadName} 凭据: ${secret}`,
      );
    }
  }
});

test("凭据绝不进入设置页预览 —— 手输描述与诊断列表同样脱敏", () => {
  // 第 4 条路径：用户在设置页手输的问题描述。它不经过任何入口 draft 构造器，
  // 是「收口点放在编排层」才能覆盖到的一条。
  for (const { name, payload, secret } of CREDENTIAL_PAYLOADS) {
    const body = buildFeedbackEntryBody({
      context: { description: payload },
      diagnosticFields: ALL_FIELDS,
      locale: LOCALE,
      formatMessage,
    });
    const title = resolveFeedbackEntryTitle({ description: payload });
    const diagnostics = JSON.stringify(
      buildFeedbackEntryDiagnostics({ context: { description: payload } }),
    );

    assert.equal(body.includes(secret), false, `诊断正文泄漏了 ${name} 凭据`);
    assert.equal(title.includes(secret), false, `标题泄漏了 ${name} 凭据`);
    assert.equal(diagnostics.includes(secret), false, `诊断项列表泄漏了 ${name} 凭据`);
  }
});

test("脱敏是幂等的：已脱敏文本再脱敏一次内容不变", () => {
  // 入口侧部分 draft 构造器（errorFeedbackDraft / taskFeedbackDraft）已经脱敏过一次，
  // 编排层收口后会再脱敏一次。若脱敏不幂等，就会出现双重转义或 [REDACTED] 套娃。
  for (const { payload } of CREDENTIAL_PAYLOADS) {
    const once = buildFeedbackEntryBody({
      context: { description: payload },
      diagnosticFields: ["notes"],
      locale: LOCALE,
      formatMessage,
    });
    const twice = buildFeedbackEntryBody({
      context: { description: once.replace(/^###[^\n]*\n\n/, "").replace(/^- [^:]*: /, "") },
      diagnosticFields: ["notes"],
      locale: LOCALE,
      formatMessage,
    });
    assert.equal(twice, once, "重复脱敏改变了内容，说明脱敏不幂等");
  }
});

test("脱敏不破坏可用信息：版本与平台仍保留", () => {
  // 反向断言：脱敏不能矫枉过正到把排障信息一起抹掉，否则诊断就失去意义。
  const url = buildFeedbackEntryUrl({
    preference: preference(),
    context: { errorSummary: "崩溃了", description: "任务失败" },
    locale: LOCALE,
    formatMessage,
    runtime: { device: DEVICE_SNAPSHOT },
  });
  const decoded = normalizeUrl(url);
  assert.ok(decoded.includes("3.14.0"), "应保留应用版本");
  assert.ok(decoded.includes("macOS"), "应保留可读平台名");
  assert.ok(decoded.includes("崩溃了"), "应保留用户可见错误摘要");
});

test("入口带上来的诊断内容绝不泄漏设备身份", () => {
  const url = buildUrl(
    preference(),
    { errorSummary: "崩溃了", description: "任务失败" },
    { device: DEVICE_SNAPSHOT },
  );
  assert.ok(url, "应生成链接");
  const decoded = decodeURIComponent(url);
  for (const token of FORBIDDEN_TOKENS) {
    assert.equal(decoded.includes(token), false, `预填链接泄漏了禁止字段: ${token}`);
  }
  // 版本与平台属于允许范围，必须保留——否则诊断就没有排障价值了。
  assert.ok(decoded.includes("3.14.0"), "应保留应用版本");
  assert.ok(decoded.includes("macOS"), "应保留可读平台名");
});

test("标题优先级：入口显式 title > 错误摘要首行 > 描述首行", () => {
  assert.equal(
    resolveFeedbackEntryTitle({ title: "显式标题", errorSummary: "错误", description: "描述" }),
    "显式标题",
  );
  // 描述是多段模板正文时，直接拿它的首行当标题会带上「报错摘要：」这类前缀，所以错误摘要优先。
  assert.equal(
    resolveFeedbackEntryTitle({ errorSummary: "错误首行\n错误次行", description: "描述首行" }),
    "错误首行",
  );
  assert.equal(resolveFeedbackEntryTitle({ description: "描述首行\n描述次行" }), "描述首行");
  assert.equal(resolveFeedbackEntryTitle({}), "");
});

test("未勾选的诊断字段不进正文，勾选顺序不改变字段白名单", () => {
  const body = buildFeedbackEntryBody({
    context: { errorSummary: "只有错误", description: "只有描述" },
    diagnosticFields: ["error"],
    locale: LOCALE,
    formatMessage,
  });
  assert.ok(body.includes("只有错误"), body);
  assert.equal(body.includes("只有描述"), false, "未勾选的 notes 字段不应出现");
  // 版本 / 平台同理：只勾 error 时不应被默认带出来。
  assert.equal(body.includes("ZCode"), false, "未勾选的 app 字段不应出现");
});

test("入口上下文取出即清空，不会污染下一次反馈", () => {
  setFeedbackEntryContext({ errorSummary: "第一次的错误" });
  assert.deepEqual(consumeFeedbackEntryContext(), { errorSummary: "第一次的错误" });
  // 关键：第二次消费必须为空。否则用户下次从别处进设置页时还会看到上一次的错误现场。
  assert.equal(consumeFeedbackEntryContext(), null);
});

test("清空入口上下文是幂等的，且显式清空后消费返回 null", () => {
  setFeedbackEntryContext({ errorSummary: "待清空" });
  setFeedbackEntryContext(null);
  assert.equal(consumeFeedbackEntryContext(), null);
  assert.equal(consumeFeedbackEntryContext(), null);
});

/**
 * 源码级结构断言：锁死「既有反馈入口必须走渠道配置」这条接线约束。
 *
 * 纯函数测试只能证明裁决逻辑正确，证明不了「入口真的接上了」——
 * 漏接一个入口的表现为「点了还是开官方弹窗」，而单测全绿。
 * 这里直接读源码做结构检查：这些入口文件不允许再直接使用 feedbackStore 的 openSubmit。
 * 唯一允许的例外是设置页的「官方工单服务」显式入口（B 象限能力，按决策刻意保留）。
 */
const UI_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

const WIRED_ENTRY_FILES = [
  "ChatErrorBanner.tsx",
  "TaskListItem.tsx",
  "App.tsx",
  "WorkspaceHeaderSections.tsx",
  "WorkspaceHelpMenuButton.tsx",
  "lib/helpMenuActions.ts",
  "remote-connection/RemoteConnectionConnectingStep.tsx",
  "v4/SessionSubscriptionErrorPanel.tsx",
  "workspace-grouped-tasks/task-row.tsx",
];

test("既有反馈入口不再直接调用 openSubmit，全部改走 useFeedbackEntryAction", () => {
  for (const relativePath of WIRED_ENTRY_FILES) {
    const source = readFileSync(join(UI_SRC, relativePath), "utf8");
    assert.equal(
      source.includes("state.openSubmit"),
      false,
      `${relativePath} 仍在直接调用 feedbackStore.openSubmit，应改为 useFeedbackEntryAction`,
    );
    assert.ok(source.includes("runFeedbackEntry"), `${relativePath} 未接入 useFeedbackEntryAction`);
  }
});

test("官方工单能力保留：设置分区仍有显式入口，feedbackService 未被删除", () => {
  // 官方反馈属「官方服务 + 用户主动触发」象限，决策是「重构为可配置」而不是删除。
  // 这条断言防止后续有人以「去遥测」为名把它一起删掉。
  const section = readFileSync(join(UI_SRC, "settings/FeedbackDiagnosticsSection.tsx"), "utf8");
  assert.ok(section.includes("state.openSubmit"), "设置分区应保留「官方工单服务」显式入口");
});
