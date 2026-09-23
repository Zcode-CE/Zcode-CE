import assert from "node:assert/strict";
import test from "node:test";
import type { McpServerConfig, McpToolDescriptor } from "@zcode/contracts";
import { createToolRegistry } from "../src/tool/registry.js";
import { registerMcpTools } from "../src/mcp/index.js";
import { buildDisabledMcpToolsByServer } from "../src/mcp/tool-disabled.js";

/**
 * MCP 工具级启停（`mcp.servers[<server>].disabledTools`）的行为测试。
 *
 * 断言打在**最终消费点**：ToolRegistry 里到底有没有这个工具 —— 它同时决定
 * ①模型能不能看到（`toContracts()`）②直呼会不会命中 `ToolNotFound`
 * （`core/src/tool/executor/call-runner.ts` 的 registry miss 早退）。
 * 产品规则见 `docs/development/tool-policy.md`。
 *
 * 运行：cd apps/zcode-cli/packages/core && node --import tsx --test test/mcpToolEnablement.test.ts
 */

const SERVER = "github";

function descriptor(toolName: string, serverName = SERVER): McpToolDescriptor {
  return {
    serverName,
    toolName,
    name: `mcp__${serverName.replace(/[^a-zA-Z0-9_-]/g, "_")}__${toolName}`,
    inputSchema: { type: "object", properties: {} },
  };
}

/** 只测注册与调度，不需要真的连 MCP；`callTool` 一被调用就说明工具被执行了。 */
function createMcpPortStub() {
  const calls: Array<{ serverName: string; toolName: string }> = [];
  const port = {
    async callTool(request: { serverName: string; toolName: string }) {
      calls.push({ serverName: request.serverName, toolName: request.toolName });
      return { content: [{ type: "text", text: "ok" }] };
    },
  };
  return { calls, port: port as never };
}

/** 把一份「server 配置对象」变成 registerMcpTools 需要的判定清单。 */
function disabledMap(servers: Record<string, McpServerConfig>) {
  return buildDisabledMcpToolsByServer(servers);
}

test("关闭某个工具后它根本不进注册表（provider 工具表也看不到）", () => {
  const registry = createToolRegistry();
  const { port } = createMcpPortStub();
  const result = registerMcpTools(
    registry,
    port,
    [descriptor("get_issue"), descriptor("list_pull_requests")],
    { disabledToolsByServer: disabledMap({ [SERVER]: { disabledTools: ["get_issue"] } }) },
  );

  assert.equal(registry.has("mcp__github__get_issue"), false);
  assert.equal(registry.has("mcp__github__list_pull_requests"), true);
  assert.deepEqual(result.registered, ["mcp__github__list_pull_requests"]);
  assert.deepEqual(result.disabledToolNames, ["get_issue"]);

  const visible = registry.toContracts().map((contract) => contract.name);
  assert.equal(visible.includes("mcp__github__get_issue"), false);
});

test("关闭的工具直呼会失败：handler 不执行（等价 ToolNotFound）", async () => {
  const registry = createToolRegistry();
  const { calls, port } = createMcpPortStub();
  registerMcpTools(registry, port, [descriptor("get_issue")], {
    disabledToolsByServer: disabledMap({ [SERVER]: { disabledTools: ["get_issue"] } }),
  });

  // call-runner 的 registry miss 分支：早于 hook 与权限，直接查表就能判定「不能执行」。
  assert.equal(registry.get("mcp__github__get_issue"), undefined);
  assert.equal(calls.length, 0);
});

test("未被关闭的工具照常可执行（回归）", async () => {
  const registry = createToolRegistry();
  const { calls, port } = createMcpPortStub();
  registerMcpTools(registry, port, [descriptor("get_issue"), descriptor("get_repo")], {
    disabledToolsByServer: disabledMap({ [SERVER]: { disabledTools: ["get_issue"] } }),
  });

  const entry = registry.get("mcp__github__get_repo");
  assert.ok(entry);
  await entry?.handler({}, { traceId: "t", sessionId: "s", workingDirectory: "/tmp" } as never);
  assert.deepEqual(calls, [{ serverName: SERVER, toolName: "get_repo" }]);
});

test("作用域是单个 server：另一个 server 的同名工具不受影响", () => {
  const registry = createToolRegistry();
  const { port } = createMcpPortStub();
  const result = registerMcpTools(
    registry,
    port,
    [descriptor("search", "github"), descriptor("search", "gitlab")],
    { disabledToolsByServer: disabledMap({ github: { disabledTools: ["search"] } }) },
  );

  assert.equal(registry.has("mcp__github__search"), false);
  assert.equal(registry.has("mcp__gitlab__search"), true);
  assert.deepEqual(result.disabledToolNames, ["search"]);
});

test("匹配的是 server 的原始工具名，不是模型可见名（写错名字不会静默生效）", () => {
  const registry = createToolRegistry();
  const { port } = createMcpPortStub();
  // 用户误把模型可见名写进 disabledTools：契约是原始名，所以这个条目**不该**生效。
  registerMcpTools(registry, port, [descriptor("get_issue")], {
    disabledToolsByServer: disabledMap({
      [SERVER]: { disabledTools: ["mcp__github__get_issue"] },
    }),
  });
  assert.equal(registry.has("mcp__github__get_issue"), true);
});

test("工具级关闭优先于 session allowlist（两个收窄取并集）", () => {
  const registry = createToolRegistry();
  const { port } = createMcpPortStub();
  registerMcpTools(registry, port, [descriptor("get_issue")], {
    // allowlist 明确点名要它 —— 但用户已经持久化地关掉了它，注册面必须更权威。
    allowedTools: ["mcp__github__get_issue"],
    disabledToolsByServer: disabledMap({ [SERVER]: { disabledTools: ["get_issue"] } }),
  });
  assert.equal(registry.has("mcp__github__get_issue"), false);
});

test("server 整包关闭时工具级清单不参与（工具本来就不会被列出）", () => {
  // enabled: false 的 server：连接被跳过，快照里就没有它的工具。
  // 这里确认判定清单不会为它凭空产出条目（日志/统计不产生噪声）。
  const map = disabledMap({
    [SERVER]: { enabled: false, disabledTools: ["get_issue"] },
  });
  assert.equal(map.size, 0);
});

test("未配置 disabledTools 时行为完全不变（老配置零迁移）", () => {
  const registry = createToolRegistry();
  const { port } = createMcpPortStub();
  const result = registerMcpTools(
    registry,
    port,
    [descriptor("get_issue"), descriptor("get_repo")],
    {
      disabledToolsByServer: disabledMap({ [SERVER]: {} }),
    },
  );
  assert.deepEqual(result.registered.sort(), ["mcp__github__get_issue", "mcp__github__get_repo"]);
  assert.deepEqual(result.disabledToolNames, []);
});

test("非法条目不会误伤合法条目（归一化在判定之前）", () => {
  const map = disabledMap({
    [SERVER]: { disabledTools: ["  get_issue  ", "", "get_issue", 42 as never] },
  });
  assert.deepEqual([...(map.get(SERVER) ?? [])], ["get_issue"]);
});

test("判定清单按 server 聚合，且只收集非空清单", () => {
  const map = disabledMap({
    github: { disabledTools: ["get_issue", "get_repo"] },
    gitlab: { disabledTools: ["search"] },
    empty: { disabledTools: [] },
    legacy: {},
  });
  assert.deepEqual([...(map.get("github") ?? [])].sort(), ["get_issue", "get_repo"]);
  assert.deepEqual([...(map.get("gitlab") ?? [])], ["search"]);
  // 空清单与未配置都不落条目：避免在日志/统计里制造「这个 server 关了 0 个工具」的噪声。
  assert.equal(map.has("empty"), false);
  assert.equal(map.has("legacy"), false);
});
