import assert from "node:assert/strict";
import test from "node:test";
import type { Model, ModelToolContract, ToolSearchCandidate } from "@zcode/contracts";
import { LOCAL_TOOL_SEARCH_DESCRIPTION } from "../src/tool/search/description.js";
import {
  buildToolExposure,
  buildToolSearchAnnouncement,
  isDeferredTool,
  resolveToolSearchMode,
} from "../src/tool/search/exposure.js";
import { searchTools } from "../src/tool/search/search.js";
import type { RuntimeMessageEntry } from "../src/agent/message-history.js";

/**
 * 工具搜索（上游 3.16.2 F14）的核心纯逻辑：检索、模式解析、目录曝光与公告。
 *
 * 为什么必须钉住这几条：
 * - mode=off 必须与没有本功能时逐字节一致（工具列表原样、不产出公告）——这是「关掉即无副作用」的全部证据；
 * - native/local 的准入条件分三处（provider 能力、deferred 工具存在、控制工具在场），任一处松动都会让
 *   模型拿到一个「调用必然失败」的工具名，而界面上看不出来；
 * - 检索的 select/keyword/MCP 名字匹配是模型唯一的选择入口，召回错了等价于工具不存在。
 *
 * 运行：cd apps/zcode-cli/packages/core && node --import tsx --test test/toolSearch.test.ts
 */

const READ_TOOL = "Read";
const MCP_GH = "mcp__github__issue_search";
const MCP_SLACK = "mcp__slack__send_message";
const WEB_TOOL = "WebSearch";

function modelOf(input: {
  supportsToolCall?: boolean;
  protocolSupported?: boolean;
  defaultEnabled?: boolean;
}): Model {
  return {
    providerId: "test-provider",
    modelId: "test-model",
    properties: { supportsToolCall: input.supportsToolCall ?? true },
    requestCapabilities:
      input.protocolSupported === undefined
        ? undefined
        : {
            toolSearch: {
              protocolSupported: input.protocolSupported,
              defaultEnabled: input.defaultEnabled ?? false,
            },
          },
  } as unknown as Model;
}

const contract = (name: string): ModelToolContract => ({
  name,
  inputSchema: { type: "object" },
});

const deferredRegistry = {
  get: (name: string) =>
    name === MCP_GH
      ? ({
          metadata: {
            name,
            shouldDefer: true,
            readOnly: true,
            destructive: false,
            concurrentSafe: true,
            sideEffectScope: "none",
            riskLevel: "low",
            needsApproval: false,
          },
        } as never)
      : undefined,
};

const NO_REGISTRY = { get: () => undefined } as never;

const discoveredEntry: RuntimeMessageEntry = {
  kind: "message",
  message: {
    role: "tool",
    toolCallId: "call_1",
    toolName: "ToolSearch",
    content: [{ type: "tool_reference", toolName: MCP_GH }],
  },
  metadata: { source: "real_user" },
};

test("searchTools：select: 按名字选，常驻工具回退命中，未知名返回空", () => {
  const catalog: ToolSearchCandidate[] = [
    { name: READ_TOOL, deferred: false },
    { name: MCP_SLACK, deferred: true, mcp: { serverName: "slack", toolName: "send_message" } },
  ];
  assert.deepEqual(searchTools("select:Read", catalog), [READ_TOOL]);
  assert.deepEqual(searchTools("select:mcp__slack__send_message", catalog), [MCP_SLACK]);
  // MCP 原始工具名（模型只知道裸名）也要能选中。
  assert.deepEqual(searchTools("select:send_message", catalog), [MCP_SLACK]);
  // 多选 + 去重 + 未知名忽略。
  assert.deepEqual(searchTools("select:Read,send_message,Read", catalog), [READ_TOOL, MCP_SLACK]);
  assert.deepEqual(searchTools("select:nope", catalog), []);
});

test("searchTools：关键词按名字/描述/searchHint 召回，+term 为必需项，空查询无结果", () => {
  const catalog: ToolSearchCandidate[] = [
    { name: READ_TOOL, deferred: false },
    {
      name: MCP_GH,
      deferred: true,
      description: "Search issues in a repository",
      mcp: { serverName: "github", toolName: "issue_search" },
    },
    { name: WEB_TOOL, deferred: true, description: "Look things up", searchHint: "internet lookup" },
    { name: MCP_SLACK, deferred: true, mcp: { serverName: "slack", toolName: "send_message" } },
  ];
  // 非 mcp 名字先按大小写边界拆词：WebSearch -> web/search。
  assert.deepEqual(searchTools("web", catalog), [WEB_TOOL]);
  // mcp 名字的两段（serverName / toolName）都参与粗匹配。
  assert.deepEqual(searchTools("github", catalog), [MCP_GH]);
  assert.deepEqual(searchTools("issue", catalog), [MCP_GH]);
  // searchHint 只在关键词分支生效。
  assert.deepEqual(searchTools("internet", catalog), [WEB_TOOL]);
  // +term 必须命中（只对带 + 的词设门槛），普通词只参与计分。
  assert.deepEqual(searchTools("+slack send", catalog), [MCP_SLACK]);
  assert.deepEqual(searchTools("+slack github", catalog), [MCP_SLACK]);
  assert.deepEqual(searchTools("+slack +github", catalog), []);
  // 纯前缀形态走 mcp__ 快路径。
  assert.deepEqual(searchTools("mcp__github__", catalog), [MCP_GH]);
  assert.deepEqual(searchTools("", catalog), []);
  // maxResults 生效：web 与 issue 描述都含 search，只取第一个。
  assert.equal(searchTools("search", catalog, 1).length, 1);
});

test("resolveToolSearchMode：四态与不可用时的明确报错", () => {
  // off 不需要任何 provider 能力。
  assert.equal(resolveToolSearchMode(modelOf({}), "off"), "off");
  assert.equal(resolveToolSearchMode(modelOf({}), undefined), "off");

  // native 需要协议声明；没有就必须报错而不是降级。
  assert.equal(resolveToolSearchMode(modelOf({ protocolSupported: true }), "native"), "native");
  assert.throws(
    () => resolveToolSearchMode(modelOf({ protocolSupported: false }), "native"),
    /requires an Anthropic Messages provider/,
  );

  // auto：provider 默认开启才走 native，否则按工具调用能力退到 local/off。
  assert.equal(
    resolveToolSearchMode(modelOf({ protocolSupported: true, defaultEnabled: true }), "auto"),
    "native",
  );
  assert.equal(
    resolveToolSearchMode(modelOf({ protocolSupported: true, defaultEnabled: false }), "auto"),
    "local",
  );
  assert.equal(
    resolveToolSearchMode(modelOf({ supportsToolCall: false }), "auto"),
    "off",
  );

  // local 需要 provider 支持工具调用；显式请求时失败而不是静默关闭。
  assert.equal(resolveToolSearchMode(modelOf({}), "local"), "local");
  assert.throws(
    () => resolveToolSearchMode(modelOf({ supportsToolCall: false }), "local"),
    /requires a provider that supports tool calls/,
  );
});

test("isDeferredTool：控制入口、provider 原生工具与 alwaysLoad 永不 deferred", () => {
  const metadata = { shouldDefer: true } as never;
  assert.equal(isDeferredTool(contract("TodoWrite"), metadata), true);
  assert.equal(isDeferredTool(contract("ToolSearch"), metadata), false);
  assert.equal(isDeferredTool(contract("DeferredToolCall"), metadata), false);
  assert.equal(
    isDeferredTool({ ...contract("WebSearch"), providerNative: { logicalName: "WebSearch" } } as never, metadata),
    false,
  );
  assert.equal(
    isDeferredTool(contract("TodoWrite"), { shouldDefer: true, alwaysLoad: true } as never),
    false,
  );
  // 没有任何延迟声明时不是 deferred。
  assert.equal(isDeferredTool(contract("Read"), undefined), false);
});

test("buildToolExposure：off 原样返回，native 摘掉未交付的 deferred 并置 deferLoading", () => {
  const tools = [contract("ToolSearch"), contract(MCP_GH), contract(READ_TOOL)];
  const off = buildToolExposure({
    model: modelOf({ protocolSupported: true }),
    mode: "off",
    tools,
    registry: deferredRegistry,
    entries: [],
  });
  assert.equal(off.enabled, false);
  assert.equal(off.context.mode, "off");
  assert.equal(off.reason, "provider_disabled");
  // off 下控制入口本身也不曝光：注册表里有 ToolSearch，模型可见列表里没有。
  assert.deepEqual(
    off.tools.map((tool) => tool.name),
    [MCP_GH, READ_TOOL],
  );
  assert.equal(off.tools[0]!.deferLoading, undefined, "off 不得留下 deferLoading");

  const native = buildToolExposure({
    model: modelOf({ protocolSupported: true }),
    mode: "native",
    tools,
    registry: deferredRegistry,
    entries: [],
  });
  assert.equal(native.enabled, true);
  assert.equal(native.context.mode, "native");
  assert.deepEqual(
    native.tools.map((tool) => tool.name),
    ["ToolSearch", READ_TOOL],
    "未交付的 deferred 工具必须从模型可见列表里摘掉",
  );

  const discovered = buildToolExposure({
    model: modelOf({ protocolSupported: true }),
    mode: "native",
    tools,
    registry: deferredRegistry,
    entries: [discoveredEntry],
  });
  assert.deepEqual(
    discovered.tools.map((tool) => tool.name),
    ["ToolSearch", MCP_GH, READ_TOOL],
    "历史里已交付的 deferred 工具要回到可见列表",
  );
  assert.equal(discovered.tools[1]!.deferLoading, true);
});

test("buildToolExposure：local 保留 DeferredToolCall，替换 ToolSearch 说明", () => {
  const local = buildToolExposure({
    model: modelOf({}),
    mode: "local",
    tools: [contract("ToolSearch"), contract("DeferredToolCall"), contract(MCP_GH)],
    registry: deferredRegistry,
    entries: [],
  });
  assert.equal(local.enabled, true);
  assert.equal(local.context.mode, "local");
  assert.deepEqual(
    local.tools.map((tool) => tool.name),
    ["ToolSearch", "DeferredToolCall"],
  );
  assert.equal(local.tools[0]!.description, LOCAL_TOOL_SEARCH_DESCRIPTION);
});

test("buildToolExposure：缺 deferred / 缺控制工具时关闭并给出原因", () => {
  const noDeferred = buildToolExposure({
    model: modelOf({ protocolSupported: true }),
    mode: "native",
    tools: [contract("ToolSearch"), contract(READ_TOOL)],
    registry: NO_REGISTRY,
    entries: [],
  });
  assert.equal(noDeferred.enabled, false);
  assert.equal(noDeferred.reason, "no_deferred_tools");

  const noControl = buildToolExposure({
    model: modelOf({ protocolSupported: true }),
    mode: "native",
    tools: [contract(MCP_GH), contract(READ_TOOL)],
    registry: deferredRegistry,
    entries: [],
  });
  assert.equal(noControl.enabled, false);
  assert.equal(noControl.reason, "tool_unavailable");

  // local 还要求 DeferredToolCall 在场：只有 ToolSearch 时包装调用根本不存在。
  const noWrapper = buildToolExposure({
    model: modelOf({}),
    mode: "local",
    tools: [contract("ToolSearch"), contract(MCP_GH)],
    registry: deferredRegistry,
    entries: [],
  });
  assert.equal(noWrapper.enabled, false);
  assert.equal(noWrapper.reason, "tool_unavailable");
});

test("buildToolSearchAnnouncement：off 不产出公告，开启时按目录列出新增并与历史对齐", () => {
  const tools = [contract("ToolSearch"), contract(MCP_GH)];
  assert.equal(
    buildToolSearchAnnouncement({
      model: modelOf({ protocolSupported: true }),
      mode: "off",
      tools,
      registry: deferredRegistry,
      entries: [],
    }),
    undefined,
  );

  const announcement = buildToolSearchAnnouncement({
    model: modelOf({ protocolSupported: true }),
    mode: "native",
    tools,
    registry: deferredRegistry,
    entries: [],
  });
  assert.equal(announcement?.metadata?.source, "tool_search_announcement");
  assert.deepEqual(announcement?.metadata?.toolSearchAnnouncement?.addedNames, [MCP_GH]);
  assert.match(announcement?.content ?? "", new RegExp(MCP_GH));
});
