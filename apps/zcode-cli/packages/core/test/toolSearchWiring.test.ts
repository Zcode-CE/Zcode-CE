import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFERRED_TOOL_CALL_NAME,
  TOOL_SEARCH_NAME,
  type Model,
  type ModelToolContract,
} from "@zcode/contracts";
import {
  MessageHistoryImpl,
  type RuntimeMessageEntry,
} from "../src/agent/message-history.js";
import { hydrateCompactDiscovery, hydrateToolSearchContent } from "../src/agent/tool-search-hydration.js";
import { prepareRuntimeProviderRequest } from "../src/runtime/helpers/runtime-provider-request-messages.js";
import { buildRuntimeProviderRequestMessages } from "../src/runtime/helpers/runtime-provider-request-messages.js";
import {
  buildCompactSummaryRequestMessages,
  selectCompactSummaryTools,
} from "../src/runtime/methods/compact-active-helpers.js";
import {
  captureProjectMemoryAgentContext,
  prepareProjectMemoryAgentRequest,
} from "../src/runtime/helpers/project-memory-agent.js";
import { completedToolPartMetadata } from "../src/runtime/methods/tool-part-metadata.js";
import { buildManualCompactBoundary } from "../src/compact/manual.js";
import { resolveDeferredToolCall } from "../src/tool/deferred-call.js";
import { deferredToolCallEntry } from "../src/tool/handlers/deferred-tool-call.js";
import { toolSearchToolEntry } from "../src/tool/handlers/tool-search.js";
import { webFetchToolEntry } from "../src/tool/handlers/webfetch.js";
import { readToolEntry } from "../src/tool/handlers/read.js";
import { ToolRegistryImpl } from "../src/tool/registry.js";
import { buildToolSearchAnnouncement } from "../src/tool/search/exposure.js";
import type { ToolExecutionResult } from "../src/tool/types.js";

/**
 * 工具搜索（上游 3.16.2 F14）wave2：真实请求装配 + 真实准入 + 持久化的接线证据。
 *
 * 与 toolSearch.test.ts（纯模块）互补：这里跑的是接线后的消费点——
 * → prepareRuntimeProviderRequest 产出的 tools/messages（模型真正收到的字节）
 * → ToolSearch 真实 handler + formatModelContent（引用块）
 * → resolveDeferredToolCall 的准入（包装解包 / 拒绝）
 * → completedToolPartMetadata 与冷恢复 hydrate（持久化 metadata 往返）
 * 任何一环只测纯函数，都无法证明「模型看到 deferred 工具被隐藏、搜索后能调用」。
 *
 * 运行：cd apps/zcode-cli/packages/core && node --import tsx --test test/toolSearchWiring.test.ts
 */

const DEFERRED_TOOL = "WebFetch";

function modelOf(protocolSupported = false): Model {
  return {
    providerId: "test-provider",
    modelId: "test-model",
    properties: { supportsToolCall: true },
    requestCapabilities: {
      toolSearch: { protocolSupported, defaultEnabled: protocolSupported },
    },
  } as unknown as Model;
}

// 真实注册目录：常驻 Read、deferred WebFetch、两个控制入口。
function registryOf(): ToolRegistryImpl {
  const registry = new ToolRegistryImpl();
  for (const entry of [readToolEntry, webFetchToolEntry, toolSearchToolEntry, deferredToolCallEntry])
    registry.register(entry);
  return registry;
}

function runtimeOf(mode: "off" | "local" | "native" | "auto") {
  return { config: { toolSearch: { mode } } };
}

function toolsOf(registry: ToolRegistryImpl): ModelToolContract[] {
  return registry.toContracts();
}

function requestOf(input: {
  mode: "off" | "local" | "native" | "auto";
  model: Model;
  entries: readonly RuntimeMessageEntry[];
  registry: ToolRegistryImpl;
}) {
  return prepareRuntimeProviderRequest(runtimeOf(input.mode), {
    model: input.model,
    tools: toolsOf(input.registry),
    registry: input.registry,
    entries: input.entries,
  });
}

const REFERENCE_RESULT: RuntimeMessageEntry = {
  kind: "message",
  message: {
    role: "tool",
    toolCallId: "call_search_1",
    toolName: TOOL_SEARCH_NAME,
    content: [{ type: "tool_reference", toolName: DEFERRED_TOOL }],
  },
  metadata: { source: "real_user" },
};

test("off：请求 tools/messages 与接入前逐字节一致，且不写引用 metadata", () => {
  const registry = registryOf();
  const model = modelOf();
  const history = new MessageHistoryImpl();
  history.init("system");
  history.addUser("请读取文件");
  const entries = history.borrowReadOnlyRuntimeEntries();

  const prepared = requestOf({ mode: "off", model, entries, registry });
  // off 下未启用搜索，两个控制入口不进入请求；其余工具一个不少、也不带 deferLoading。
  const withoutControlTools = toolsOf(registry).filter(
    (tool) => tool.name !== TOOL_SEARCH_NAME && tool.name !== DEFERRED_TOOL_CALL_NAME,
  );
  assert.deepEqual(prepared.request.tools, withoutControlTools);
  assert.equal(prepared.request.toolSearchEnabled, false);
  assert.equal(prepared.toolSearch.enabled, false);
  assert.equal(prepared.toolSearch.mode, "off");
  // 消息投影与「没有本功能时」的唯一渲染路径一致。
  assert.deepEqual(
    prepared.request.messages,
    buildRuntimeProviderRequestMessages(runtimeOf("off"), { model, entries }).messages,
  );
  // off 不产出公告。
  assert.equal(
    buildToolSearchAnnouncement({
      model,
      mode: "off",
      tools: toolsOf(registry),
      registry,
      entries,
    }),
    undefined,
  );
  // 普通字符串结果不进入 modelContent union：老 session 的 metadata 字节不变。
  const metadata = completedToolPartMetadata({
    toolCallId: "c1",
    toolName: "Read",
    success: true,
    output: "ok",
    modelContent: "普通文本结果",
    durationMs: 1,
    startedAt: new Date(0),
    completedAt: new Date(0),
  } as ToolExecutionResult);
  assert.equal("modelContent" in metadata, false);
});

test("local：deferred schema 默认不可见，ToolSearch 按 select: 曝光且结果为引用块", async () => {
  const registry = registryOf();
  const model = modelOf();
  const empty: readonly RuntimeMessageEntry[] = [];

  const first = requestOf({ mode: "local", model, entries: empty, registry });
  const firstNames = first.request.tools.map((tool) => tool.name);
  // 首轮只发常驻工具与两个控制入口；deferred 的 WebFetch schema 不在请求里。
  assert.ok(firstNames.includes("Read"));
  assert.ok(firstNames.includes(TOOL_SEARCH_NAME));
  assert.deepEqual(firstNames.includes(DEFERRED_TOOL), false);
  assert.equal(first.request.toolSearchEnabled, false); // local 不发 provider beta
  // 目录变化公告列出被隐藏的工具名（否则模型不知道有它）。
  const announcement = buildToolSearchAnnouncement({
    model,
    mode: "local",
    tools: toolsOf(registry),
    registry,
    entries: empty,
  });
  assert.ok(announcement && announcement.kind === "attachment");
  assert.match(announcement.content, new RegExp(DEFERRED_TOOL));

  // 真实 handler + 真实曝光上下文：select: 直接选中，formatModelContent 产出引用块。
  const output = (await toolSearchToolEntry.handler?.(
    { query: `select:${DEFERRED_TOOL}` },
    { toolCallId: "call_search_1", toolSearch: first.toolSearch, sessionId: "s" as never },
  )) as { matches: string[]; query: string; total_deferred_tools: number };
  assert.deepEqual(output.matches, [DEFERRED_TOOL]);
  assert.equal(output.total_deferred_tools, 1);
  const maybeContent = toolSearchToolEntry.formatModelContent?.(output);
  const content = Array.isArray(maybeContent) ? maybeContent : [maybeContent];
  assert.deepEqual(content, [{ type: "tool_reference", toolName: DEFERRED_TOOL }]);

  // 搜索成功后：请求 tools 仍不含目标 schema（local 只在结果位置展开定义）。
  const second = requestOf({
    mode: "local",
    model,
    entries: [REFERENCE_RESULT],
    registry,
  });
  assert.equal(
    second.request.tools.some((tool) => tool.name === DEFERRED_TOOL),
    false,
  );
  const toolResult = second.request.messages.find(
    (message) => message.role === "tool" && message.toolName === TOOL_SEARCH_NAME,
  );
  const blocks = Array.isArray(toolResult?.content) ? toolResult.content : [];
  const expanded = blocks.find((block) => block.type === "text");
  assert.ok(expanded && expanded.type === "text");
  // local 在真实结果位置展开完整定义，而不是给一句「已加载」。
  assert.match(expanded.text, /<functions>/);
  assert.match(expanded.text, /"name":"WebFetch"/);
});

test("local：DeferredToolCall 解包成目标调用；未曝光/常驻/未知目标被拒", () => {
  const registry = registryOf();
  const model = modelOf();
  const call = {
    id: "call_wrap_1",
    name: DEFERRED_TOOL_CALL_NAME,
    input: { name: DEFERRED_TOOL, input: { url: "https://example.com" } },
  };

  // 未曝光：本次请求根本没开搜索（无 deferred 工具可搜）⇒ 包装入口不可用，保持包装身份。
  const noDeferredRegistry = new ToolRegistryImpl();
  for (const entry of [readToolEntry, toolSearchToolEntry, deferredToolCallEntry])
    noDeferredRegistry.register(entry);
  const noDeferred = prepareRuntimeProviderRequest(runtimeOf("local"), {
    model,
    tools: toolsOf(noDeferredRegistry),
    registry: noDeferredRegistry,
    entries: [],
  });
  const rejected = resolveDeferredToolCall(call, noDeferred.toolSearch, noDeferredRegistry);
  assert.ok(rejected.error);
  assert.match(rejected.error.message, /not available for this request/);
  assert.deepEqual(rejected.call, call);

  // 已发现：解包成目标身份，并带上包装标记。
  const discovered = requestOf({
    mode: "local",
    model,
    entries: [REFERENCE_RESULT],
    registry,
  });
  const admitted = resolveDeferredToolCall(call, discovered.toolSearch, registry);
  assert.equal(admitted.error, undefined);
  assert.equal(admitted.call.name, DEFERRED_TOOL);
  assert.deepEqual(admitted.call.input, { url: "https://example.com" });
  assert.equal(admitted.call.modelCallWrapper, DEFERRED_TOOL_CALL_NAME);

  // 目标不在本次请求目录里：拒绝并指出具体名字。
  const unknown = resolveDeferredToolCall(
    { id: "call_wrap_4", name: DEFERRED_TOOL_CALL_NAME, input: { name: "Nope", input: {} } },
    discovered.toolSearch,
    registry,
  );
  assert.ok(unknown.error);
  assert.match(unknown.error.message, /Tool not available in this request: Nope/);

  // 未搜索（历史里没有引用块）不是执行禁令：目录允许即可解包，缺 schema 的后果由参数校验承担。
  const notYetSearched = requestOf({ mode: "local", model, entries: [], registry });
  const admittedBeforeSearch = resolveDeferredToolCall(call, notYetSearched.toolSearch, registry);
  assert.equal(admittedBeforeSearch.error, undefined);
  assert.equal(admittedBeforeSearch.call.name, DEFERRED_TOOL);

  // 常驻工具不得经包装转发。
  const resident = resolveDeferredToolCall(
    { id: "call_wrap_2", name: DEFERRED_TOOL_CALL_NAME, input: { name: "Read", input: {} } },
    discovered.toolSearch,
    registry,
  );
  assert.ok(resident.error);
  assert.match(resident.error.message, /only accepts deferred tools/);

  // off 模式下包装入口根本不可用。
  const off = requestOf({ mode: "off", model, entries: [REFERENCE_RESULT], registry });
  const offRejected = resolveDeferredToolCall(call, off.toolSearch, registry);
  assert.ok(offRejected.error);
  assert.match(offRejected.error.message, /not available for this request/);

  // 普通工具调用与包装无关，原样放行。
  const plain = resolveDeferredToolCall(
    { id: "call_plain", name: "Read", input: { file_path: "/tmp/x" } },
    off.toolSearch,
    registry,
  );
  assert.deepEqual(plain, { call: { id: "call_plain", name: "Read", input: { file_path: "/tmp/x" } } });
});

test("native：provider 声明支持时携带 enabled 标记，已发现工具带 deferLoading 且保留引用块", () => {
  const registry = registryOf();
  const model = modelOf(true);
  const prepared = requestOf({
    mode: "native",
    model,
    entries: [REFERENCE_RESULT],
    registry,
  });
  assert.equal(prepared.request.toolSearchEnabled, true);
  assert.equal(prepared.toolSearch.mode, "native");
  // 未发现的 deferred schema 不发送；已发现的带 deferLoading 发送。
  const webFetch = prepared.request.tools.find((tool) => tool.name === DEFERRED_TOOL);
  assert.ok(webFetch);
  assert.equal(webFetch.deferLoading, true);
  // native 不摘引用块：原样交给 provider 展开。
  const toolResult = prepared.request.messages.find(
    (message) => message.role === "tool" && message.toolName === TOOL_SEARCH_NAME,
  );
  assert.deepEqual(toolResult?.content, [{ type: "tool_reference", toolName: DEFERRED_TOOL }]);
});

test("持久化：引用块进 completed part metadata，冷恢复按同一 schema 还原", () => {
  // 成功结果里的引用块必须原样落盘，否则冷恢复后已交付的定义丢失。
  const metadata = completedToolPartMetadata({
    toolCallId: "call_search_1",
    toolName: TOOL_SEARCH_NAME,
    success: true,
    output: { matches: [DEFERRED_TOOL] },
    modelContent: [{ type: "tool_reference", toolName: DEFERRED_TOOL }],
    durationMs: 3,
    startedAt: new Date(0),
    completedAt: new Date(3),
  } as ToolExecutionResult);
  assert.deepEqual(metadata.modelContent, [{ type: "tool_reference", toolName: DEFERRED_TOOL }]);
  assert.deepEqual(hydrateToolSearchContent(metadata.modelContent), [
    { type: "tool_reference", toolName: DEFERRED_TOOL },
  ]);

  // 旧 session 的字符串内容与畸形内容都退回 legacy 路径，不能污染 provider 请求。
  assert.equal(hydrateToolSearchContent("普通文本"), undefined);
  assert.equal(hydrateToolSearchContent([{ type: "tool_reference" }]), undefined);

  // compact 检查点的发现名称同样要能恢复：用真实 writer 产出 payload，再过真实 reader。
  const boundary = buildManualCompactBoundary({
    boundaryId: "boundary_1",
    preCompactDiscoveredTools: [DEFERRED_TOOL],
    preCompactTokenCount: 100,
    summarizedMessageCount: 2,
    summaryMessageId: "msg_summary" as never,
    traceContext: { sessionId: "s", traceId: "trace_1" } as never,
  });
  assert.deepEqual(hydrateCompactDiscovery(boundary), {
    boundaryId: "boundary_1",
    preCompactDiscoveredTools: [DEFERRED_TOOL],
  });
});

test("持久化：包装调用的目标身份与标记在 history 中成对保存", () => {
  const history = new MessageHistoryImpl();
  history.init("system");
  history.addAssistant("", [
    { id: "call_wrap_1", name: DEFERRED_TOOL, input: { url: "https://example.com" }, modelCallWrapper: DEFERRED_TOOL_CALL_NAME },
  ]);
  history.addToolResult(
    "call_wrap_1",
    DEFERRED_TOOL,
    "页面正文",
    true,
    false,
    DEFERRED_TOOL_CALL_NAME,
  );
  const entries = history.borrowReadOnlyRuntimeEntries();
  const assistant = entries.find((entry) => entry.message.role === "assistant");
  const tool = entries.find((entry) => entry.message.role === "tool");
  // 内部历史只保存目标身份 + 包装标记（不重复保存包装 input）。
  assert.equal(assistant?.message.toolCalls?.[0]?.name, DEFERRED_TOOL);
  assert.equal(assistant?.message.toolCalls?.[0]?.modelCallWrapper, DEFERRED_TOOL_CALL_NAME);
  assert.equal(tool?.message.toolName, DEFERRED_TOOL);
  assert.equal(tool?.message.modelCallWrapper, DEFERRED_TOOL_CALL_NAME);

  // 协议出口才还原外层调用：assistant tool_use 用包装名 + {name,input}，结果名也用包装名。
  const { messages } = buildRuntimeProviderRequestMessages(runtimeOf("local"), {
    model: modelOf(),
    entries,
  });
  const renderedAssistant = messages.find((message) => message.role === "assistant");
  assert.equal(renderedAssistant?.toolCalls?.[0]?.name, DEFERRED_TOOL_CALL_NAME);
  assert.deepEqual(renderedAssistant?.toolCalls?.[0]?.input, {
    name: DEFERRED_TOOL,
    input: { url: "https://example.com" },
  });
  const renderedTool = messages.find((message) => message.role === "tool");
  assert.equal(renderedTool?.toolName, DEFERRED_TOOL_CALL_NAME);
  assert.equal(renderedTool?.modelCallWrapper, undefined);
});

// 辅助请求（memory / goal verifier / compact summary）必须与主请求共用同一套曝光决策：
// tools 与历史 tool_reference 投影成对产出，不能各自直接 build。旧装配 = 历史末尾追加 prompt 后渲染。
const AUX_PROMPT = "辅助请求提示";
const MCP_TOOL_NAME = "mcp__demo__query";
const MCP_TOOL = {
  name: MCP_TOOL_NAME,
  description: "demo query",
  inputSchema: { type: "object" },
} as unknown as ModelToolContract;

type RequestRuntimeInput = Parameters<typeof buildRuntimeProviderRequestMessages>[0];

function legacyAuxMessages(
  runtime: RequestRuntimeInput,
  model: Model,
  entries: readonly RuntimeMessageEntry[],
  prompt: string,
) {
  return buildRuntimeProviderRequestMessages(runtime, {
    applyCacheControl: true,
    entries: [...entries, { message: { content: prompt, role: "user" } }],
    model,
  }).messages;
}

function registryWithMcpTool() {
  const registry = registryOf();
  const get = (name: string) =>
    name === MCP_TOOL_NAME
      ? ({
          metadata: { mcpPresentation: { serverName: "demo", toolName: "query" } },
        } as unknown as ReturnType<ToolRegistryImpl["get"]>)
      : registry.get(name);
  return { registry, withMcp: { get } };
}

function captureRuntimeStub(registry: ToolRegistryImpl) {
  return {
    agentTelemetry: { captureCausation: () => undefined },
    config: {},
    getSessionModelSelection: () => undefined,
    getTools: () => toolsOf(registry),
    messageHistory: { borrowReadOnlyRuntimeEntries: () => [] as RuntimeMessageEntry[] },
    readFileState: new Map(),
    workingDirectory: "/workspace",
    workspaceRoot: "/workspace",
  } as unknown as Parameters<typeof captureProjectMemoryAgentContext>[0];
}

test("off：辅助请求的 tools/messages 与改动前逐字节一致", () => {
  const registry = registryOf();
  const model = modelOf();
  const history = new MessageHistoryImpl();
  history.init("system");
  history.addUser("请读取文件");
  const entries = history.borrowReadOnlyRuntimeEntries();
  const withoutControlTools = toolsOf(registry).filter(
    (tool) => tool.name !== TOOL_SEARCH_NAME && tool.name !== DEFERRED_TOOL_CALL_NAME,
  );

  // goal verifier：tools: [] + 显式 prompt。
  const verifier = prepareRuntimeProviderRequest(runtimeOf("off"), {
    model,
    tools: [],
    entries,
    prompt: AUX_PROMPT,
    applyCacheControl: true,
  }).request;
  assert.deepEqual(verifier.messages, legacyAuxMessages(runtimeOf("off"), model, entries, AUX_PROMPT));
  assert.deepEqual(verifier.tools, []);
  assert.equal(verifier.toolSearchEnabled, false);

  // compact summary：工具选择 = 「去掉两个控制入口的完整目录」，请求与旧
  // buildCompactSummaryRequestMessages 同输入同输出（含 cache 标记）。
  const compactTools = selectCompactSummaryTools({
    model,
    mode: "off",
    registry,
    tools: toolsOf(registry),
  });
  assert.deepEqual(
    compactTools.map((tool) => tool.name),
    ["Read", "WebFetch"],
  );
  const compact = prepareRuntimeProviderRequest(runtimeOf("off"), {
    model,
    tools: compactTools,
    registry,
    entries,
    prompt: AUX_PROMPT,
    applyCacheControl: true,
    skipCacheWrite: true,
  }).request;
  assert.deepEqual(
    compact.messages,
    buildCompactSummaryRequestMessages(entries, AUX_PROMPT, { useMidConversationSystem: false }),
  );
  assert.deepEqual(compact.tools, withoutControlTools);
  assert.equal(compact.toolSearchEnabled, false);

  // memory：capture 先摘掉 ToolSearch，prepare 再产出请求；与旧装配等价。
  const captured = captureProjectMemoryAgentContext(captureRuntimeStub(registry), {
    memoryRoot: "/memory",
    model,
    operation: "project_memory_extract",
    traceContext: { sessionId: "s", traceId: "t" } as never,
  });
  assert.equal(captured.tools.some((tool) => tool.name === TOOL_SEARCH_NAME), false);
  assert.ok(captured.tools.some((tool) => tool.name === "Read"));
  const memory = prepareProjectMemoryAgentRequest(captured, AUX_PROMPT);
  // protection 之外的 DeferredToolCall 也由曝光决策摘掉：解析恒为 off，控制入口不得出现在请求里。
  assert.deepEqual(
    memory.tools.map((tool) => tool.name),
    ["Read", "WebFetch"],
  );
  assert.equal(memory.toolSearchEnabled, false);
  assert.deepEqual(
    memory.messages,
    legacyAuxMessages(
      { config: { midConversationSystem: undefined } },
      model,
      captured.providerEntries,
      AUX_PROMPT,
    ),
  );
});

test("local：辅助请求的 tools 与历史引用跟随曝光决策", () => {
  const { registry, withMcp } = registryWithMcpTool();
  const model = modelOf();
  const catalog = [...toolsOf(registry), MCP_TOOL];

  // compact 只保留 Read + 两个控制入口 + MCP 目录；非 MCP 的 deferred 工具不参与摘要。
  assert.deepEqual(
    selectCompactSummaryTools({ model, mode: "local", registry: withMcp, tools: catalog }).map(
      (tool) => tool.name,
    ),
    ["Read", TOOL_SEARCH_NAME, DEFERRED_TOOL_CALL_NAME, MCP_TOOL_NAME],
  );

  const mcpReference: RuntimeMessageEntry = {
    kind: "message",
    message: {
      role: "tool",
      toolCallId: "call_search_mcp",
      toolName: TOOL_SEARCH_NAME,
      content: [{ type: "tool_reference", toolName: MCP_TOOL_NAME }],
    },
    metadata: { source: "real_user" },
  };
  const compact = prepareRuntimeProviderRequest(runtimeOf("local"), {
    model,
    tools: selectCompactSummaryTools({ model, mode: "local", registry: withMcp, tools: catalog }),
    registry: withMcp,
    entries: [mcpReference],
    prompt: AUX_PROMPT,
    applyCacheControl: true,
    skipCacheWrite: true,
  }).request;
  const names = compact.tools.map((tool) => tool.name);
  assert.ok(names.includes(TOOL_SEARCH_NAME));
  assert.ok(names.includes(DEFERRED_TOOL_CALL_NAME));
  // deferred 目标仍不出现在 tools 里：local 只在结果位置展开定义。
  assert.equal(names.includes(MCP_TOOL_NAME), false);
  assert.equal(compact.toolSearchEnabled, false);
  const searched = compact.messages.find((message) => message.role === "tool");
  const blocks = Array.isArray(searched?.content) ? searched.content : [];
  const expanded = blocks.find((block) => block.type === "text");
  assert.ok(expanded && expanded.type === "text");
  assert.match(expanded.text, /<functions>/);
  assert.match(expanded.text, new RegExp(MCP_TOOL_NAME));

  // verifier 没有工具可调用：历史引用必须被投影成 provider 可接受的内容，
  // 不能把 tool_reference 原样发出去（adapter 会直接失败）。
  const verifier = prepareRuntimeProviderRequest(runtimeOf("local"), {
    model,
    tools: [],
    entries: [REFERENCE_RESULT],
    prompt: AUX_PROMPT,
    applyCacheControl: true,
  }).request;
  const serialized = JSON.stringify(verifier.messages);
  assert.equal(serialized.includes("'tool_reference'"), false);
  assert.match(serialized, /Tool references removed/);

  // memory 仍然不允许 ToolSearch：捕获的工具目录摘掉了控制入口，请求因此停在 off。
  const memory = prepareProjectMemoryAgentRequest(
    {
      midConversationSystem: undefined,
      model,
      providerEntries: [REFERENCE_RESULT],
      tools: catalog.filter((tool) => tool.name !== TOOL_SEARCH_NAME),
    } as unknown as Parameters<typeof prepareProjectMemoryAgentRequest>[0],
    AUX_PROMPT,
  );
  assert.equal(memory.tools.some((tool) => tool.name === TOOL_SEARCH_NAME), false);
  assert.equal(memory.toolSearchEnabled, false);
  assert.equal(JSON.stringify(memory.messages).includes("'tool_reference'"), false);
});

test("local：工具数超过 compact 阈值时 summary 请求保持无工具", () => {
  const { registry, withMcp } = registryWithMcpTool();
  const model = modelOf();
  const manyTools = Array.from(
    { length: 101 },
    (_, index) =>
      ({
        name: "Tool" + index,
        description: "",
        inputSchema: { type: "object" },
      }) as unknown as ModelToolContract,
  );
  // 没有控制入口与 deferred 工具时搜索不可启用 ⇒ 回落到普通工具策略 ⇒ 超过 100 个则清空。
  assert.deepEqual(
    selectCompactSummaryTools({ model, mode: "local", registry: withMcp, tools: manyTools }),
    [],
  );
  assert.equal(
    selectCompactSummaryTools({ model, mode: "local", registry: withMcp, tools: manyTools.slice(0, 100) })
      .length,
    100,
  );
  assert.deepEqual(
    selectCompactSummaryTools({ model, mode: "off", registry, tools: manyTools }),
    [],
  );
});

