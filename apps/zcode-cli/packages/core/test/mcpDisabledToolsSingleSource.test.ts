import assert from "node:assert/strict";
import test from "node:test";
import { MCP_SERVER_MAX_DISABLED_TOOLS, normalizeMcpDisabledTools } from "@zcode/contracts";
import {
  MCP_SERVER_MAX_DISABLED_TOOLS as SHARED_MAX,
  normalizeMcpDisabledTools as normalizeFromShared,
} from "@zcode/shared/mcpDisabledTools";
import { zcodeProtocolMcpServerSchema } from "@zcode/shared";

/**
 * 「`disabledTools` 的上限与归一化只有一份实现」的**回归测试**。
 *
 * 为什么必须有：这条常量曾经在 3 个文件各写一份（shared 的 mcp.ts / zcode-protocol /
 * contracts）、归一化函数有 2 份（contracts 带诊断计数、shared/mcp.ts 内联静默丢弃）。
 * 各写一份同值常量不会报错，只会在有人改一处时**静默漂移**：wire 边界放行 300 条、
 * 配置边界截断到 200 条，用户看到的行为随入口不同而不同。
 *
 * 断言打在「同一性」上（同一个函数对象、同一个常量值），这是唯一能钉住单源的方式：
 * 只断言值相等会漏掉「两份实现恰好同值」的情形。
 *
 * 运行：cd apps/zcode-cli/packages/core && node --import tsx --test test/mcpDisabledToolsSingleSource.test.ts
 */

test("contracts 与 shared 重新导出的是同一个实现（不是两份同值副本）", () => {
  assert.equal(
    normalizeMcpDisabledTools,
    normalizeFromShared,
    "contracts 必须从 @zcode/shared/mcpDisabledTools 重新导出，而不是自带一份实现",
  );
  assert.equal(MCP_SERVER_MAX_DISABLED_TOOLS, SHARED_MAX);
});

test("wire schema 用的是同一个上限（超一条即被拒）", () => {
  const build = (count: number) => ({
    name: "github",
    command: "npx",
    args: [],
    env: [],
    disabledTools: Array.from({ length: count }, (_, index) => `tool_${index}`),
  });
  assert.equal(zcodeProtocolMcpServerSchema.safeParse(build(MCP_SERVER_MAX_DISABLED_TOOLS)).success, true);
  assert.equal(
    zcodeProtocolMcpServerSchema.safeParse(build(MCP_SERVER_MAX_DISABLED_TOOLS + 1)).success,
    false,
  );
});

test("归一化行为只有一套：trim / 去空 / 去重 / 超限截断 + 诊断计数", () => {
  const normalized = normalizeMcpDisabledTools([
    " get_issue ",
    "",
    "get_issue",
    "get_repo",
    42,
  ]);
  assert.deepEqual(normalized.disabledTools, ["get_issue", "get_repo"]);
  assert.equal(normalized.blankCount, 1);
  assert.equal(normalized.droppedEntryCount, 1);
  assert.equal(normalized.invalidShape, false);
  assert.equal(normalized.truncatedCount, 0);

  const tooMany = normalizeMcpDisabledTools(
    Array.from({ length: MCP_SERVER_MAX_DISABLED_TOOLS + 3 }, (_, index) => `t${index}`),
  );
  assert.equal(tooMany.disabledTools.length, MCP_SERVER_MAX_DISABLED_TOOLS);
  assert.equal(tooMany.truncatedCount, 3);
});
