import assert from "node:assert/strict";
import test from "node:test";
import type { ModelInputMessage, ModelToolContract } from "@zcode/contracts";
import { TOOL_SEARCH_BETA } from "@zcode/contracts";
import { resolveToolSearchCapability, toolSearchHeaders } from "../src/model/tool-search.js";
import { toAiSdkTools } from "../src/model/tool-transform.js";
import { toAiSdkMessages } from "../src/model/transform.js";

/**
 * 工具搜索在 adapter 边界的三个事实：
 *
 * 1. 能力推导决定 core 敢不敢把 native 交给 provider —— 协议不支持却报 supported，
 *    模型会拿到一个 provider 不认的 deferLoading，症状是「工具静默不生效」；
 * 2. beta 头只在 enabled 时注入，且与原 header 合并去重 —— 关闭态必须与没有本功能时逐字节一致，
 *    否则会改变供应商侧准入与缓存前缀；
 * 3. tool_reference 只对 Anthropic + 开启态编码成 provider 引用块，其余情况明确失败。
 *
 * 运行：cd apps/zcode-cli/packages/adapters && node --import tsx --test test/toolSearch.test.ts
 */

test("能力推导：只有 Anthropic Messages 协议声明 protocolSupported，Coding Plan 才默认开启", () => {
  assert.deepEqual(resolveToolSearchCapability("anthropic-messages", { type: "api-key" }), {
    protocolSupported: true,
    defaultEnabled: false,
  });
  assert.deepEqual(
    resolveToolSearchCapability("anthropic-messages", { type: "zhipu-coding-plan-api-key" }),
    { protocolSupported: true, defaultEnabled: true },
  );
  assert.deepEqual(
    resolveToolSearchCapability("anthropic-messages", {
      type: "zhipu-account",
      mode: "individual-coding-plan",
    }),
    { protocolSupported: true, defaultEnabled: true },
  );
  // start-plan 不是 coding plan：协议支持但不默认开启。
  assert.deepEqual(
    resolveToolSearchCapability("anthropic-messages", { type: "zhipu-account", mode: "start-plan" }),
    { protocolSupported: true, defaultEnabled: false },
  );
  // 其他协议一律不支持，coding plan 也不行。
  assert.deepEqual(
    resolveToolSearchCapability("openai-chat-completions", { type: "zhipu-coding-plan-api-key" }),
    { protocolSupported: false, defaultEnabled: false },
  );
});

test("beta 头：关闭态原样返回，开启态合并去重且大小写不敏感", () => {
  const headers = { "anthropic-version": "2023-06-01" };
  assert.equal(toolSearchHeaders(headers, false), headers);
  assert.equal(toolSearchHeaders(headers, undefined), headers);
  assert.deepEqual(toolSearchHeaders(headers, true), {
    "anthropic-version": "2023-06-01",
    "anthropic-beta": TOOL_SEARCH_BETA,
  });
  // 已存在的 beta 头按下发时的大小写合并，不新增第二个键，且同一 beta 不重复。
  assert.deepEqual(toolSearchHeaders({ "Anthropic-Beta": `other-beta, ${TOOL_SEARCH_BETA}` }, true), {
    "Anthropic-Beta": `other-beta,${TOOL_SEARCH_BETA}`,
  });
});

test("deferLoading 只在开启态落进 provider descriptor", () => {
  const deferred: ModelToolContract = {
    name: "TodoWrite",
    deferLoading: true,
    inputSchema: { type: "object" },
  };
  const enabled = toAiSdkTools([deferred], { providerKind: "anthropic", toolSearchEnabled: true });
  assert.deepEqual(
    (enabled?.TodoWrite as { providerOptions?: unknown } | undefined)?.providerOptions,
    { anthropic: { eagerInputStreaming: false, deferLoading: true } },
  );
  const disabled = toAiSdkTools([deferred], { providerKind: "anthropic" });
  assert.deepEqual(
    (disabled?.TodoWrite as { providerOptions?: unknown } | undefined)?.providerOptions,
    { anthropic: { eagerInputStreaming: false } },
  );
});

function toolReferenceConversation(): ModelInputMessage[] {
  return [
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_1", name: "ToolSearch", input: { query: "select:TodoWrite" } }],
    },
    {
      role: "tool",
      toolCallId: "call_1",
      toolName: "ToolSearch",
      content: [{ type: "tool_reference", toolName: "TodoWrite" }],
    },
  ];
}

test("tool_reference：Anthropic + 开启态编码成 provider 引用块", () => {
  const messages = toAiSdkMessages(toolReferenceConversation(), {
    providerKind: "anthropic",
    toolSearchEnabled: true,
  });
  const toolMessage = messages[1] as {
    content: Array<{
      output: { type: string; value: Array<{ type: string; providerOptions?: unknown }> };
    }>;
  };
  const output = toolMessage.content[0]?.output;
  assert.equal(output?.type, "content");
  assert.equal(output?.value[0]?.type, "custom");
  assert.deepEqual(output?.value[0]?.providerOptions, {
    anthropic: { type: "tool-reference", toolName: "TodoWrite" },
  });
});

test("tool_reference：没有开启态时明确失败，不退化成名字文本", () => {
  assert.throws(
    () => toAiSdkMessages(toolReferenceConversation(), { providerKind: "anthropic" }),
    /Tool references require active Anthropic ToolSearch/,
  );
  assert.throws(
    () =>
      toAiSdkMessages(toolReferenceConversation(), {
        providerKind: "openai",
        toolSearchEnabled: true,
      }),
    /Tool references require active Anthropic ToolSearch/,
  );
});
