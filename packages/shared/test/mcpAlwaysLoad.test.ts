import assert from "node:assert/strict";
import test from "node:test";
import { convertToZCodeAgentMcpServer, type McpServerConfig } from "../src/mcp.js";
import { zcodeProtocolMcpServerSchema } from "../src/zcode-protocol/index.js";

/**
 * 上游 3.16.2 X17：MCP 应用未就绪时调用失败。
 *
 * 修复的是「配置在进入 Agent 前丢字段」：DTO 是逐字段重建的白名单，漏一个键 = 用户配了但没下发；
 * strict protocol schema 漏一个键 = 整个 session/create 被判非法。两处都必须显式。
 * 本测试同时钉住「显式 false 保留」——用 truthy 判断会把 false 吞掉，退化成默认值。
 */

const stdioConfig: McpServerConfig = { command: "npx", args: ["-y", "demo"], env: { A: "1" } };
const httpConfig: McpServerConfig = { type: "http", url: "https://mcp.example/mcp" };

test("判据 1：stdio / http 两条投影都保留 alwaysLoad（含显式 false）", () => {
  for (const config of [stdioConfig, httpConfig]) {
    for (const alwaysLoad of [true, false]) {
      const server = convertToZCodeAgentMcpServer("demo", { ...config, alwaysLoad });
      assert.ok(server, "投影不能返回 null");
      assert.equal(server.alwaysLoad, alwaysLoad, "DTO 必须原样保留 " + alwaysLoad);
      const parsed = zcodeProtocolMcpServerSchema.safeParse(server);
      assert.equal(parsed.success, true, "协议 schema 必须接受该 DTO");
      assert.equal(parsed.success ? parsed.data.alwaysLoad : undefined, alwaysLoad);
    }
  }
});

test("判据 2：缺失或非布尔的 alwaysLoad 不进入 DTO（不伪造默认值）", () => {
  for (const alwaysLoad of [undefined, null, "true", 1]) {
    const server = convertToZCodeAgentMcpServer("demo", {
      ...stdioConfig,
      alwaysLoad,
    } as McpServerConfig);
    assert.ok(server);
    assert.equal(
      Object.hasOwn(server, "alwaysLoad"),
      false,
      "非法值必须省略：" + String(alwaysLoad),
    );
  }
});

test("判据 3：协议 schema 拒绝非布尔的 alwaysLoad", () => {
  const parsed = zcodeProtocolMcpServerSchema.safeParse({
    name: "demo",
    command: "npx",
    args: [],
    env: [],
    alwaysLoad: "yes",
  });
  assert.equal(parsed.success, false);
});
