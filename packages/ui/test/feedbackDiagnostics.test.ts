import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_FEEDBACK_REPOSITORY_URL,
  buildFeedbackBody,
  buildFeedbackDiagnosticEntries,
  buildFeedbackIssueTitle,
  buildFeedbackPrefilledUrl,
  parseFeedbackChannelKind,
  parseFeedbackDiagnosticFields,
} from "../src/feedback/feedbackDiagnostics.js";

/**
 * 「反馈与诊断」预填链路的回归测试。
 *
 * 重点防两类回归：
 * 1. **脱敏**：deviceMid / hostname 等设备身份绝不能进入预填正文（这是对外可见的内容）；
 * 2. **URL 拼接**：GitLab 这类「占位符 + 自定义参数名」的模板不能被追加重复参数。
 *
 * 运行方式（CE 无统一 test script，沿用既有 *.test.ts 的 node:test 约定）：
 *   cd packages/ui && node --import tsx --test test/feedbackDiagnostics.test.ts
 */

/** 含故意注入的哨兵值：一旦进入预填内容就说明脱敏被破坏。 */
const DEVICE_SNAPSHOT = {
  appVersion: "3.14.0",
  buildCommitId: "872ad96",
  buildTime: "2026-09-21T00:00:00Z",
  nodeVersion: "v24.14.0",
  electronVersion: "38.0.0",
  osType: "Darwin",
  osPlatform: "darwin",
  osRelease: "24.6.0",
  osVersion: "24.6.0",
  osArch: "arm64",
  deviceMid: "SENTINEL-DEVICE-MID",
  hostname: "sentinel-host",
};

const FORBIDDEN_TOKENS = [
  "SENTINEL-DEVICE-MID",
  "sentinel-host",
  "deviceMid",
  "hostname",
  "user_id",
  "username",
];

test("诊断信息只包含版本与平台，绝不泄漏设备身份", () => {
  const entries = buildFeedbackDiagnosticEntries(
    { description: "崩溃了" },
    { device: DEVICE_SNAPSHOT },
  );
  const serialized = JSON.stringify(entries);

  for (const token of FORBIDDEN_TOKENS) {
    assert.equal(serialized.includes(token), false, `诊断信息泄漏了禁止字段: ${token}`);
  }

  const app = entries.find((entry) => entry.id === "app");
  assert.ok(app, "应包含 app 字段");
  assert.ok(app.value.includes("3.14.0"), "app 字段应含版本号");
  assert.ok(app.value.includes("872ad96"), "app 字段应含构建 ID");

  const runtime = entries.find((entry) => entry.id === "runtime");
  assert.ok(runtime, "应包含 runtime 字段");
  assert.ok(runtime.value.includes("macOS"), "runtime 应含可读平台名");
  assert.ok(runtime.value.includes("arm64"), "runtime 应含架构");
  assert.ok(runtime.value.includes("Node v24.14.0"), "runtime 应含 Node 版本");
});

test("平台标识转可读名称，未知值原样保留而不是猜测", () => {
  assert.ok(
    buildFeedbackDiagnosticEntries({}, { device: { osPlatform: "win32" } })[1]?.value.includes(
      "Windows",
    ),
  );
  assert.ok(
    buildFeedbackDiagnosticEntries({}, { device: { osPlatform: "linux" } })[1]?.value.includes(
      "Linux",
    ),
  );
  assert.ok(
    buildFeedbackDiagnosticEntries({}, { device: { osPlatform: "plan9" } })[1]?.value.includes(
      "plan9",
    ),
  );
});

test("默认 GitHub 渠道生成 issues/new 预填链接", () => {
  const url = buildFeedbackPrefilledUrl({
    target: { channel: "github" },
    title: "崩溃了",
    body: "诊断",
    locale: "zh-CN",
  });
  assert.ok(url, "应生成链接");
  assert.ok(url.startsWith(`${DEFAULT_FEEDBACK_REPOSITORY_URL}/issues/new?`), url);
  assert.ok(url.includes("title="), "应带 title 参数");
  assert.ok(url.includes("body="), "应带 body 参数");
});

test("渠道关闭或自定义地址非法时返回 null，不产出半成品链接", () => {
  const cases = [
    { channel: "off" as const },
    { channel: "custom" as const, customUrlTemplate: "" },
    { channel: "custom" as const, customUrlTemplate: "   " },
    { channel: "custom" as const, customUrlTemplate: "not a url" },
    // 安全边界：非 http(s) scheme 必须 fail-closed。这些 URL 都能通过 new URL() 解析，
    // 若放行会在用户点击时把脚本 / 本地文件交给系统打开。
    { channel: "custom" as const, customUrlTemplate: "javascript:alert(1)" },
    { channel: "custom" as const, customUrlTemplate: "data:text/html,<script>x</script>" },
    { channel: "custom" as const, customUrlTemplate: "file:///etc/passwd" },
    { channel: "custom" as const, customUrlTemplate: "vbscript:msgbox(1)" },
  ];
  for (const target of cases) {
    assert.equal(
      buildFeedbackPrefilledUrl({ target, title: "t", body: "b", locale: "zh-CN" }),
      null,
      `${JSON.stringify(target)} 应返回 null`,
    );
  }
});

test("自定义模板带占位符时只替换，不追加重复的 title/body 参数", () => {
  // GitLab 用 issue[title] / issue[description]；追加裸 title/body 会被站点忽略，
  // 这里锁死「有占位符 → 只替换」的行为，防止回归。
  const url = buildFeedbackPrefilledUrl({
    target: {
      channel: "custom",
      customUrlTemplate:
        "https://gitlab.com/x/y/-/issues/new?issue[title]={title}&issue[description]={body}",
    },
    title: "崩溃了",
    body: "诊断",
    locale: "zh-CN",
  });
  assert.ok(url, "应生成链接");
  // URL.toString() 对 query 中的 [ ] 保留字面量，不做 %5B 转义。
  assert.ok(url.includes("issue[title]="), `应保留模板参数名: ${url}`);
  assert.equal(url.includes("&title="), false, "不应追加裸 title 参数");
  assert.equal(url.includes("&body="), false, "不应追加裸 body 参数");
});

test("自定义模板不带占位符时追加 title/body 查询参数", () => {
  const url = buildFeedbackPrefilledUrl({
    target: { channel: "custom", customUrlTemplate: "https://gitea.example/new" },
    title: "崩溃了",
    body: "诊断",
    locale: "zh-CN",
  });
  assert.ok(url, "应生成链接");
  assert.ok(url.includes("title="), "应追加 title 参数");
  assert.ok(url.includes("body="), "应追加 body 参数");
});

test("标题只取首行并限长，正文按语言分节", () => {
  assert.equal(buildFeedbackIssueTitle("第一行\n第二行"), "第一行");
  assert.equal(buildFeedbackIssueTitle("   "), "");
  assert.equal(buildFeedbackIssueTitle("x".repeat(200)).length, 80);

  const zh = buildFeedbackBody([{ label: "app", value: "v1" }], { locale: "zh-CN" });
  const en = buildFeedbackBody([{ label: "app", value: "v1" }], { locale: "en-US" });
  assert.ok(zh.includes("诊断信息"), zh);
  assert.ok(en.includes("Diagnostics"), en);
  assert.equal(buildFeedbackBody([], { locale: "zh-CN" }), "");
});

test("持久化脏数据回退默认值，不抛异常", () => {
  assert.equal(parseFeedbackChannelKind(null), "github");
  assert.equal(parseFeedbackChannelKind("nonsense"), "github");
  assert.equal(parseFeedbackChannelKind("off"), "off");
  assert.equal(parseFeedbackChannelKind("custom"), "custom");

  assert.deepEqual(parseFeedbackDiagnosticFields(null), ["app", "runtime", "error", "notes"]);
  assert.deepEqual(parseFeedbackDiagnosticFields("not-an-array"), [
    "app",
    "runtime",
    "error",
    "notes",
  ]);
  // 全不勾选会让诊断段落为空，容易被误读成「已附带环境信息」，回退全选。
  assert.deepEqual(parseFeedbackDiagnosticFields([]), ["app", "runtime", "error", "notes"]);
  assert.deepEqual(parseFeedbackDiagnosticFields(["app", "bogus"]), ["app"]);
});
