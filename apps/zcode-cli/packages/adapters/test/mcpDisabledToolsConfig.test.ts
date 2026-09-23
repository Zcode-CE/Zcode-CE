import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "../src/config/config-factory.js";
import { parseConfigFileToRuntimePatchWithDiagnostics } from "../src/config/schema.js";
import { resolvePluginMcpServers } from "../src/plugins/mcp.js";

/**
 * `mcp.servers[<server>].disabledTools`（MCP 工具级启停）在**配置文件解析**这一层的测试。
 *
 * 为什么测这一层：`mcpServerSchema` 是 `.strict()` 的 —— 少声明一个键，用户写它会得到
 * 「整个 server 非法并被跳过」，即「想关一个工具，结果整个 MCP 不可用」。
 * 所以断言必须打在「解析结果 + 诊断」上，而不是 schema 定义上。
 *
 * 运行：cd apps/zcode-cli/packages/adapters && node --import tsx --test test/mcpDisabledToolsConfig.test.ts
 */

function parse(server: Record<string, unknown>) {
  return parseConfigFileToRuntimePatchWithDiagnostics({
    mcp: {
      servers: { github: { type: "stdio", command: "npx", args: ["-y", "server"], ...server } },
    },
  });
}

function disabledToolsOf(result: ReturnType<typeof parse>): unknown {
  return result.config.mcp?.servers?.github?.disabledTools;
}

test("配置里的 disabledTools 原样进入 runtime config", () => {
  const result = parse({ disabledTools: ["get_issue", "list_pull_requests"] });
  assert.deepEqual(disabledToolsOf(result), ["get_issue", "list_pull_requests"]);
  assert.deepEqual(result.diagnostics, []);
});

test("条目归一化：trim、去空、去重，且原顺序不变", () => {
  const result = parse({ disabledTools: [" get_issue ", "", "get_issue", "get_repo"] });
  assert.deepEqual(disabledToolsOf(result), ["get_issue", "get_repo"]);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.path, "mcp.servers.github.disabledTools");
  assert.match(result.diagnostics[0]?.message ?? "", /blank/);
});

test("老配置（没有该键）行为不变：不落字段、不产生诊断", () => {
  const result = parse({});
  assert.equal(disabledToolsOf(result), undefined);
  assert.deepEqual(result.diagnostics, []);
});

test("写错类型不会拖垮整个 server（这是本层最重要的失败语义）", () => {
  const result = parse({ disabledTools: "get_issue" });
  // server 必须还在 —— 否则用户「关一个工具」的笔误会让整个 MCP 不可用。
  assert.equal(result.config.mcp?.servers?.github?.command, "npx");
  // 该字段不生效，而不是「当成一个叫 get_issue 的工具名」。
  assert.equal(disabledToolsOf(result), undefined);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.path, "mcp.servers.github.disabledTools");
  assert.match(result.diagnostics[0]?.message ?? "", /must be an array/);
});

test("非字符串条目被丢弃并告警，合法的兄弟条目照常生效", () => {
  const result = parse({ disabledTools: ["get_issue", 42, null] });
  assert.deepEqual(disabledToolsOf(result), ["get_issue"]);
  assert.equal(result.diagnostics.length, 1);
  assert.match(result.diagnostics[0]?.message ?? "", /non-string/);
});

test("超过上限时截断并告警（不丢 server、不静默）", () => {
  const many = Array.from({ length: 205 }, (_, index) => `tool_${index}`);
  const result = parse({ disabledTools: many });
  assert.equal((disabledToolsOf(result) as string[]).length, 200);
  assert.equal(result.diagnostics.length, 1);
  assert.match(result.diagnostics[0]?.message ?? "", /limit/);
});

test("disabledTools 不影响 server 的既有字段（enabled/command/args 逐字保留）", () => {
  const result = parse({ enabled: false, disabledTools: ["get_issue"] });
  const server = result.config.mcp?.servers?.github;
  assert.equal(server?.enabled, false);
  assert.deepEqual(server?.args, ["-y", "server"]);
  assert.deepEqual(server?.disabledTools, ["get_issue"]);
});

test("真实配置文件 → createConfig 的端到端：disabledTools 出现在 runtime config 上", async () => {
  // 这一条覆盖 `loadFileConfig` + 合并 + schema 校验的完整链路（headless/TUI 走的就是它）。
  // 只测 `parseConfigFileToRuntimePatchWithDiagnostics` 会漏掉「loadFileConfig 走了别的入口」
  // 这类接线问题 —— 而 CLI 真正消费的是 createConfig 的产物。
  const directory = await mkdtemp(join(tmpdir(), "zcode-permgran-config-"));
  const configPath = join(directory, "config.json");
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        mcp: {
          servers: {
            github: {
              type: "stdio",
              command: "npx",
              args: ["-y", "server-github"],
              // 同时含「重复」与「空串」：前者必须静默去重（不是错误），后者必须有告警。
              disabledTools: ["get_issue", " get_issue ", "", "create_issue"],
            },
          },
        },
      }),
    );

    const result = createConfig({
      userConfigPath: configPath,
      skipUserConfig: false,
      env: {},
    });
    const server = result.config.mcp?.servers?.github;
    assert.ok(server, "server must survive config load");
    assert.deepEqual(server.disabledTools, ["get_issue", "create_issue"]);
    // 归一化告警必须能从这里拿到：空串会被丢弃，用户得有途径知道（重复项是静默去重，不告警）。
    assert.equal(result.sources.user.diagnostics.length, 1);
    assert.equal(result.sources.user.diagnostics[0]?.path, "mcp.servers.github.disabledTools");
    assert.match(result.sources.user.diagnostics[0]?.message ?? "", /blank/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("插件 MCP 归一化同样保住该键（第三个会写这份配置的入口）", () => {
  // 插件 server 的解析是**字段白名单投影**：漏一处，用户/插件在 .mcp.json 里写的
  // disabledTools 会在解析阶段消失，而 enabled 已经有显式透传 —— 两者必须同样的待遇。
  const servers = resolvePluginMcpServers({
    dataPath: "/tmp/plugin-data",
    definitions: undefined,
    diagnostics: [],
    env: {},
    loaded: {
      id: "demo@marketplace",
      manifest: {
        name: "demo",
        mcpServers: {
          "demo-server": {
            type: "stdio",
            command: "npx",
            args: ["-y", "demo-server"],
            disabledTools: ["dangerous_write", "dangerous_write", " "],
          },
        },
      },
      manifestPath: "/tmp/demo/plugin.json",
      marketplace: "other",
      rootPath: "/tmp/demo",
      source: "cache",
    } as never,
    options: {},
    workingDirectory: "/tmp",
  });

  const server = servers["plugin:demo:demo-server"];
  assert.ok(server, "namespaced plugin server must be resolved");
  assert.deepEqual(server.disabledTools, ["dangerous_write"]);
});

test("插件 MCP 未声明该键时不落字段（不产生空数组噪声）", () => {
  const servers = resolvePluginMcpServers({
    dataPath: "/tmp/plugin-data",
    definitions: { "demo-server": { type: "stdio", command: "npx" } },
    diagnostics: [],
    env: {},
    loaded: {
      id: "demo@marketplace",
      manifest: { name: "demo" },
      manifestPath: "/tmp/demo/plugin.json",
      marketplace: "other",
      rootPath: "/tmp/demo",
      source: "cache",
    } as never,
    options: {},
    workingDirectory: "/tmp",
  });
  assert.equal(servers["plugin:demo:demo-server"]?.disabledTools, undefined);
});

test("远程（http/sse）形态同样接受该键", () => {
  const result = parseConfigFileToRuntimePatchWithDiagnostics({
    mcp: {
      servers: {
        remote: {
          type: "http",
          url: "https://mcp.example.com/mcp",
          disabledTools: ["dangerous_write"],
        },
      },
    },
  });
  assert.deepEqual(result.config.mcp?.servers?.remote?.disabledTools, ["dangerous_write"]);
  assert.deepEqual(result.diagnostics, []);
});
