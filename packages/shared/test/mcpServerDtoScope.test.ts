import assert from "node:assert/strict";
import test from "node:test";
import { convertToZCodeAgentMcpServer, type McpServerConfig } from "../src/mcp.js";
import { zcodeProtocolMcpServerSchema } from "../src/zcode-protocol/index.js";

/**
 * F15：MCP 配置下发 DTO 必须带 `scope`（声明归属）与 stdio 的 `cwd`。
 *
 * 协议 `zcodeProtocolMcpServerSchema` 把 `scope` 的缺省语义定为「Host 没说明」，
 * 工作区同名声明因此按未信任处理 —— 少下发这一个字段，用户在设置页看到的 server
 * 在 session 里就是「未授权」状态，且没有任何报错。cwd 同理：stdio 子进程会退回会话根目录，
 * 依赖相对路径的 MCP 直接起不来。两处都是「配置在进入 Agent 前被逐字段白名单丢掉」的同一类缺陷。
 */

test("scope 与 cwd 原样进 DTO，并且协议 schema 接受", () => {
  const config: McpServerConfig = {
    command: "npx",
    args: ["-y", "demo"],
    cwd: "/work/demo",
    env: { TOKEN: "x" },
  };
  const server = convertToZCodeAgentMcpServer("demo", config, "user");
  assert.ok(server, "stdio 配置必须能投影出 DTO");
  assert.equal(server.scope, "user", "user 级声明的 scope 必须下发");
  assert.equal(server.cwd, "/work/demo", "cwd 必须原样透传");

  // 打到最终消费点：协议解析（strict schema 少声明字段会让整个 session/create 失败）。
  const parsed = zcodeProtocolMcpServerSchema.safeParse(server);
  assert.equal(parsed.success, true, "协议 schema 必须接受带 scope/cwd 的 DTO");
  if (parsed.success) {
    assert.equal(parsed.data.scope, "user");
    assert.equal(parsed.data.cwd, "/work/demo");
  }
});

test("workspace 声明与 http/sse 同样带 scope（http 无 cwd）", () => {
  const workspaceStdio = convertToZCodeAgentMcpServer(
    "demo",
    { command: "npx", args: [] },
    "workspace",
  );
  assert.equal(workspaceStdio?.scope, "workspace");

  const http = convertToZCodeAgentMcpServer(
    "remote",
    { type: "http", url: "https://mcp.example/mcp" },
    "user",
  );
  assert.equal(http?.scope, "user", "http/sse 分支也要带 scope");
  assert.equal("cwd" in (http ?? {}), false, "cwd 只属于 stdio 分支");
  assert.equal(zcodeProtocolMcpServerSchema.safeParse(http).success, true);
});

test("不传 scope 时不写该键：旧调用方行为不变", () => {
  const server = convertToZCodeAgentMcpServer("demo", { command: "npx", args: [] });
  assert.ok(server);
  assert.equal("scope" in server, false, "缺省不能伪造 scope（协议把缺省当作未说明）");
  assert.equal("cwd" in server, false, "没有 cwd 时不得写空值");
  assert.equal(zcodeProtocolMcpServerSchema.safeParse(server).success, true);
});

test("cwd 非字符串时不下发（避免把非法值塞进 strict schema）", () => {
  const server = convertToZCodeAgentMcpServer(
    "demo",
    { command: "npx", args: [], cwd: 42 as unknown as string },
    "user",
  );
  assert.ok(server);
  assert.equal("cwd" in server, false);
});
