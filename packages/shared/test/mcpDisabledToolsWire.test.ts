import assert from "node:assert/strict";
import test from "node:test";
import { zcodeProtocolMcpServerSchema } from "@zcode/shared";

/**
 * `disabledTools` 在 **ZCode Protocol wire schema** 上的形状测试。
 *
 * 为什么单独锁这一层：`zcodeProtocolMcpServerSchema` 是 `.strict()` 的，而它是
 * session/create 与 session/resume 的入参校验。少声明该键的后果不是「这个字段被忽略」，
 * 而是**整个 session 创建失败** —— host 只要下发一个带 disabledTools 的 server，
 * 桌面端就起不了会话。这类失败在单元测试之外很难在第一现场发现。
 *
 * 运行：cd packages/shared && node --import tsx --test test/mcpDisabledToolsWire.test.ts
 */

test("stdio server 接受 disabledTools", () => {
  const parsed = zcodeProtocolMcpServerSchema.parse({
    name: "github",
    command: "npx",
    args: ["-y", "server"],
    env: [],
    disabledTools: ["get_issue"],
  });
  assert.deepEqual(parsed.disabledTools, ["get_issue"]);
});

test("http server 接受 disabledTools", () => {
  const parsed = zcodeProtocolMcpServerSchema.parse({
    name: "remote",
    type: "http",
    url: "https://mcp.example.com/mcp",
    headers: [],
    disabledTools: ["write"],
  });
  assert.deepEqual(parsed.disabledTools, ["write"]);
});

test("不带该键仍然合法（老客户端/老配置不受影响）", () => {
  const parsed = zcodeProtocolMcpServerSchema.parse({
    name: "github",
    command: "npx",
    args: [],
    env: [],
  });
  assert.equal(parsed.disabledTools, undefined);
});

test("空串条目被拒（fail loud，而不是静默落一个关不掉任何东西的条目）", () => {
  assert.equal(
    zcodeProtocolMcpServerSchema.safeParse({
      name: "github",
      command: "npx",
      args: [],
      env: [],
      disabledTools: [""],
    }).success,
    false,
  );
});

test("超过上限被拒（wire 边界拒畸形请求，不落一条超长清单）", () => {
  const tooMany = Array.from({ length: 201 }, (_, index) => `tool_${index}`);
  assert.equal(
    zcodeProtocolMcpServerSchema.safeParse({
      name: "github",
      command: "npx",
      args: [],
      env: [],
      disabledTools: tooMany,
    }).success,
    false,
  );
});
