import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServerConfig } from "@zcode/shared";
import { createMcpSyncService } from "../src/mcp-sync/mcpSyncService.js";

/**
 * 「用户从设置页保存 MCP server 后，disabledTools 不会被静默丢掉」的往返测试。
 *
 * 为什么必须锁这条链路（Lead 补充要求 A）：写这份配置的路径**不止一条** ——
 * upsert 保存、启用/停用开关、表单往返、Agent DTO 投影、插件归一化、协议 DTO 转换。
 * 任何一条漏掉该键，用户看到的就是「我在设置页关了工具，模型照样调用」，
 * 而且**没有任何报错**。所以断言打在**磁盘上的最终文件**，不是中间对象。
 *
 * 运行：cd packages/services && node --import tsx --test test/mcpDisabledToolsPersistence.test.ts
 */

const CONFIG_RELATIVE_PATH = join(".zcode", "cli", "config.json");

async function withIsolatedHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "zcode-permgran-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  delete process.env.USERPROFILE;
  try {
    await run(home);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    await rm(home, { recursive: true, force: true });
  }
}

async function readServers(home: string): Promise<Record<string, Record<string, unknown>>> {
  const raw = await readFile(join(home, CONFIG_RELATIVE_PATH), "utf8");
  const parsed = JSON.parse(raw) as { mcp?: { servers?: Record<string, Record<string, unknown>> } };
  return parsed.mcp?.servers ?? {};
}

const BASE_CONFIG: McpServerConfig = {
  type: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"],
  disabledTools: ["get_issue", "create_issue"],
  timeoutMs: 30000,
} as McpServerConfig;

test("upsert 保存后 disabledTools 落盘，且 load 读回来仍在", async () => {
  await withIsolatedHome(async (home) => {
    const service = createMcpSyncService();
    await service.saveMcpToUserDirectory({
      action: "upsert",
      source: "zcodeagentmcp",
      name: "github",
      config: BASE_CONFIG,
    });

    // ① 磁盘上的最终产物
    const onDisk = await readServers(home);
    assert.deepEqual(onDisk.github?.disabledTools, ["get_issue", "create_issue"]);

    // ② 再读回来的形态（UI 列表 / session/create 都走这一步）
    const loaded = await service.loadMcpFromUserDirectory();
    const github = loaded.servers.find((server) => server.name === "github");
    assert.deepEqual(github?.config.disabledTools, ["get_issue", "create_issue"]);
    assert.equal(github?.enabled, true);
  });
});

test("启用/停用开关只改 enabled，不丢 disabledTools（同对象写入）", async () => {
  await withIsolatedHome(async (home) => {
    const service = createMcpSyncService();
    await service.saveMcpToUserDirectory({
      action: "upsert",
      source: "zcodeagentmcp",
      name: "github",
      config: BASE_CONFIG,
    });
    await service.saveMcpToUserDirectory({
      action: "set-enabled",
      source: "zcodeagentmcp",
      name: "github",
      enabled: false,
    });

    const disabledOnDisk = await readServers(home);
    assert.equal(disabledOnDisk.github?.enabled, false);
    assert.deepEqual(disabledOnDisk.github?.disabledTools, ["get_issue", "create_issue"]);

    await service.saveMcpToUserDirectory({
      action: "set-enabled",
      source: "zcodeagentmcp",
      name: "github",
      enabled: true,
    });
    const enabledOnDisk = await readServers(home);
    // 重新启用是默认态：`enabled` 字段被清掉（既有语义），但 disabledTools 必须还在。
    assert.equal("enabled" in (enabledOnDisk.github ?? {}), false);
    assert.deepEqual(enabledOnDisk.github?.disabledTools, ["get_issue", "create_issue"]);
  });
});

test("保存其它 server 不会影响已有关闭清单（逐 server 独立）", async () => {
  await withIsolatedHome(async (home) => {
    const service = createMcpSyncService();
    await service.saveMcpToUserDirectory({
      action: "upsert",
      source: "zcodeagentmcp",
      name: "github",
      config: BASE_CONFIG,
    });
    await service.saveMcpToUserDirectory({
      action: "upsert",
      source: "zcodeagentmcp",
      name: "gitlab",
      config: { type: "stdio", command: "npx", args: ["-y", "server-gitlab"] } as McpServerConfig,
    });

    const onDisk = await readServers(home);
    assert.deepEqual(onDisk.github?.disabledTools, ["get_issue", "create_issue"]);
    assert.equal(onDisk.gitlab?.disabledTools, undefined);
  });
});

test("删除 server 后不留孤儿条目", async () => {
  await withIsolatedHome(async (home) => {
    const service = createMcpSyncService();
    await service.saveMcpToUserDirectory({
      action: "upsert",
      source: "zcodeagentmcp",
      name: "github",
      config: BASE_CONFIG,
    });
    await service.saveMcpToUserDirectory({
      action: "delete",
      source: "zcodeagentmcp",
      name: "github",
    });
    const onDisk = await readServers(home);
    assert.equal(onDisk.github, undefined);
  });
});
