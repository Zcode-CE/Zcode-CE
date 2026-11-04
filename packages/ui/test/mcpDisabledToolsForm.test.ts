import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { convertToZCodeAgentMcpServer } from "@zcode/shared";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { buildWorkspaceMcpTrustDecision } from "../src/settings/mcpWorkspaceTrust.js";
import {
  EMPTY_FORM,
  formToConfig,
  jsonDraftToForm,
  parseDisabledToolsText,
  serverToForm,
  type FormState,
} from "@/settings/mcpSettingsShared.js";

/**
 * 「设置页保存不会丢 disabledTools」的表单往返测试（Lead 补充要求 A）。
 *
 * 为什么必须有这一层：`formToConfig` 是**字段白名单**导出，`convertToZCodeAgentMcpServer`
 * 也是白名单投影。用户配好工具启停后，只要在设置页点一次「保存」（哪怕只改超时），
 * 漏了一处就会把 `disabledTools` 整键抹掉 —— 静默、无告警、且用户很难察觉。
 *
 * 运行：cd packages/ui && node --import tsx --test test/mcpDisabledToolsForm.test.ts
 */

const here = dirname(fileURLToPath(import.meta.url));

function server(config: Record<string, unknown>) {
  return {
    id: "zcodeagentmcp:github",
    name: "github",
    config,
    enabled: true,
    source: "zcodeagentmcp" as const,
    scope: "user" as const,
  } as never;
}

test("serverToForm → formToConfig 往返保住 disabledTools（stdio）", () => {
  const form = serverToForm(
    server({ type: "stdio", command: "npx", disabledTools: ["get_issue"] }),
  );
  assert.equal(form.disabledTools, "get_issue");
  assert.deepEqual(formToConfig(form).disabledTools, ["get_issue"]);
});

test("serverToForm → formToConfig 往返保住 disabledTools（http）", () => {
  const form = serverToForm(
    server({
      type: "http",
      url: "https://mcp.example.com/mcp",
      disabledTools: ["write", "delete"],
    }),
  );
  assert.equal(form.disabledTools, "write\ndelete");
  assert.deepEqual(formToConfig(form).disabledTools, ["write", "delete"]);
});

test("空文本 ⇒ 不落该字段（不写空数组）", () => {
  const form: FormState = { ...EMPTY_FORM, type: "stdio", name: "x", command: "npx" };
  assert.equal("disabledTools" in formToConfig(form), false);
});

test("多行文本归一化：忽略空行、去重、保序（工具名里的 / 和 . 不被切断）", () => {
  assert.deepEqual(parseDisabledToolsText("a\n\n  b  \na\nc/d\nx.y"), ["a", "b", "c/d", "x.y"]);
  assert.deepEqual(
    formToConfig({ ...EMPTY_FORM, type: "stdio", command: "npx", disabledTools: "a\n\na" })
      .disabledTools,
    ["a"],
  );
});

test("JSON 模式：粘贴的 disabledTools 会带回表单，保存时不丢", () => {
  const draft = JSON.stringify({
    github: { type: "stdio", command: "npx", disabledTools: ["get_issue", "get_repo"] },
  });
  const form = jsonDraftToForm(draft, { ...EMPTY_FORM, type: "stdio", name: "github" });
  assert.equal(form.disabledTools, "get_issue\nget_repo");
  assert.deepEqual(formToConfig(form).disabledTools, ["get_issue", "get_repo"]);
});

test("Agent DTO 投影保住 disabledTools（UI → session/create 的唯一通道）", () => {
  const dto = convertToZCodeAgentMcpServer("github", {
    type: "stdio",
    command: "npx",
    disabledTools: [" get_issue ", "get_issue", "", "get_repo"],
  } as never);
  assert.deepEqual(dto?.disabledTools, ["get_issue", "get_repo"]);
});

test("DTO 投影：非法/空清单不落字段（老配置形态不变）", () => {
  const noKey = convertToZCodeAgentMcpServer("a", { type: "stdio", command: "npx" } as never);
  assert.equal(noKey?.disabledTools, undefined);
  const invalid = convertToZCodeAgentMcpServer("b", {
    type: "stdio",
    command: "npx",
    disabledTools: "get_issue",
  } as never);
  assert.equal(invalid?.disabledTools, undefined);
});

/**
 * 工作区 MCP 信任决定（`workspace/mcp/trust`）。
 *
 * 回归形态：project 作用域的 MCP 声明在信任前不会被 CLI 加载，若设置页既不给入口、
 * 也不把它呈现成「待信任」，用户就永远无法授权——该作用域的 MCP 等于不可用。
 * 这里钉住决定 DTO 的形状（含审核时的 declarationDigest），以及按钮/服务/文案在位。
 */
test("信任决定 DTO：带审核摘要、方向取反、非工作区不产生决定", () => {
  const review = {
    declarationDigest: "a".repeat(64),
    sourcePaths: [".zcode/mcp.json"],
    display: "{}",
    trusted: false,
    configuredEnabled: true,
    transport: "stdio" as const,
  };
  const server = { name: "github", scope: "workspace" as const, workspaceTrust: review };

  assert.deepEqual(
    buildWorkspaceMcpTrustDecision(server, {
      workspacePath: "/repo",
      workspaceIdentity: "ssh://host/repo",
    }),
    {
      workspacePath: "/repo",
      workspaceIdentity: "ssh://host/repo",
      serverName: "github",
      declarationDigest: review.declarationDigest,
      trusted: true,
    },
  );
  // identity 缺席时不写空键（exactOptionalPropertyTypes）。
  assert.deepEqual(buildWorkspaceMcpTrustDecision(server, { workspacePath: "/repo" }), {
    workspacePath: "/repo",
    serverName: "github",
    declarationDigest: review.declarationDigest,
    trusted: true,
  });
  // 已信任 → 决定是「撤销」。
  assert.equal(
    buildWorkspaceMcpTrustDecision(
      { ...server, workspaceTrust: { ...review, trusted: true } },
      { workspacePath: "/repo" },
    )?.trusted,
    false,
  );
  // 用户级配置没有可审核的声明；没有摘要或没有工作区路径都不能提交。
  assert.equal(
    buildWorkspaceMcpTrustDecision(
      { ...server, scope: "user" as never },
      { workspacePath: "/repo" },
    ),
    null,
  );
  assert.equal(
    buildWorkspaceMcpTrustDecision(
      { name: "github", scope: "workspace" },
      { workspacePath: "/repo" },
    ),
    null,
  );
  assert.equal(buildWorkspaceMcpTrustDecision(server, { workspacePath: null }), null);
});

test("信任入口接线：列表按 scope 给按钮，设置页走既有 mcpSyncService 方法", () => {
  const listSource = readFileSync(resolve(here, "../src/settings/McpServerList.tsx"), "utf8");
  const sectionSource = readFileSync(
    resolve(here, "../src/settings/McpSettingsSection.tsx"),
    "utf8",
  );
  const statusListSource = readFileSync(
    resolve(here, "../src/store/mcpStoreStatusList.ts"),
    "utf8",
  );

  // 只有工作区声明才画信任按钮，且按钮只在有 onTrust 通道时出现。
  assert.match(listSource, /server\.scope === "workspace" && onTrust \?/);
  assert.match(listSource, /TID_MCP_WORKSPACE_TRUST_BUTTON/);
  // workspace 声明的 args/URL 不进列表（Host 脱敏摘要才是展示面）。
  assert.match(listSource, /server\.scope === "workspace"\s*\? typeLabel/);
  // 状态不被降级成 unknown——否则列表没有可授权的落点。
  assert.match(statusListSource, /status: "untrusted"/);
  // 设置页经服务既有方法提交，不自己发协议方法。
  assert.match(sectionSource, /services\.mcpSyncService\.setWorkspaceMcpTrust/);
  assert.match(sectionSource, /buildWorkspaceMcpTrustDecision\(/);
});

test("信任与待审核文案双语在位", () => {
  const keys = [
    "settings.mcp.trust.action",
    "settings.mcp.trust.revoke",
    "settings.mcp.trust.title",
    "settings.mcp.trust.revokeTitle",
    "settings.mcp.trust.description",
    "settings.mcp.trust.pending",
    "settings.mcp.trust.trusted",
    "settings.mcp.trust.failed",
    "chat.workspaceMcpPending.label",
    "chat.workspaceMcpPending.message",
    "chat.workspaceMcpPending.review",
    "chat.workspaceMcpPending.dismiss",
  ];
  for (const key of keys) {
    assert.ok(key in zhCN, "zh-CN 缺少 " + key);
    assert.ok(key in enUS, "en-US 缺少 " + key);
  }
});
