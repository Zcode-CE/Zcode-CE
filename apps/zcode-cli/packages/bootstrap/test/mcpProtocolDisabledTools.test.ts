import assert from "node:assert/strict";
import test from "node:test";
import { protocolMcpServersToRuntimeMcpConfig } from "../src/zcode-protocol/protocol-mcp-config.js";

/**
 * ZCode Protocol 的 mcpServers（`session/create` 下发的那批）→ runtime config 的转换测试。
 *
 * 为什么必须锁这一层：**桌面端唯一走的是这条路**。UI 读配置 → `convertToZCodeAgentMcpServer`
 * → host 写进 `session/create` 的 `mcpServers` → 本函数。它是个逐字段重建的白名单转换，
 * 漏一个字段的后果是：设置页显示「已关闭」，agent 侧的工具面却一个都没少 —— 静默失效。
 * （headless/TUI 走另一条：直接读配置文件，由 adapters 的 mcp.servers 解析。）
 *
 * 运行：cd apps/zcode-cli/packages/bootstrap && node --import tsx --test test/mcpProtocolDisabledTools.test.ts
 */

test("stdio DTO 的 disabledTools 进入 runtime servers", () => {
  const result = protocolMcpServersToRuntimeMcpConfig([
    {
      name: "github",
      command: "npx",
      args: ["-y", "server"],
      env: [{ name: "TOKEN", value: "x" }],
      disabledTools: ["get_issue", "create_issue"],
    },
  ]);
  assert.deepEqual(result?.servers.github?.disabledTools, ["get_issue", "create_issue"]);
});

test("http DTO 的 disabledTools 进入 runtime servers", () => {
  const result = protocolMcpServersToRuntimeMcpConfig([
    {
      name: "remote",
      type: "http",
      url: "https://mcp.example.com/mcp",
      headers: [],
      disabledTools: ["write"],
    },
  ]);
  assert.deepEqual(result?.servers.remote?.disabledTools, ["write"]);
});

test("不带该键 ⇒ runtime 里没有这个字段（老配置零迁移）", () => {
  const result = protocolMcpServersToRuntimeMcpConfig([
    { name: "github", command: "npx", args: [], env: [] },
  ]);
  assert.equal("disabledTools" in (result?.servers.github ?? {}), false);
});

test("空清单不落空数组（避免下游把「关 0 个」当成「关过」）", () => {
  const result = protocolMcpServersToRuntimeMcpConfig([
    { name: "github", command: "npx", args: [], env: [], disabledTools: [] },
  ]);
  assert.equal("disabledTools" in (result?.servers.github ?? {}), false);
});

test("中文/空格等会归一化：trim、去空、去重（wire 层不做，转换层兜底）", () => {
  const result = protocolMcpServersToRuntimeMcpConfig([
    {
      name: "github",
      command: "npx",
      args: [],
      env: [],
      disabledTools: [" get_issue ", "get_issue", "get_repo"],
    },
  ]);
  assert.deepEqual(result?.servers.github?.disabledTools, ["get_issue", "get_repo"]);
});

test("未配置任何 server ⇒ undefined（既有语义不变）", () => {
  assert.equal(protocolMcpServersToRuntimeMcpConfig(undefined), undefined);
  assert.equal(protocolMcpServersToRuntimeMcpConfig([]), undefined);
});
