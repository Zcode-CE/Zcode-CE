import assert from "node:assert/strict";
import test from "node:test";
import { convertToZCodeAgentMcpServer } from "@zcode/shared";
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
