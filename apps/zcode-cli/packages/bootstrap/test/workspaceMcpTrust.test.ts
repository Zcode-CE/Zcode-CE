import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ZCodeConfigFileSchema } from "@zcode/adapters/config";
import { protocolMcpServersToRuntimeMcpConfig } from "../src/zcode-protocol/protocol-mcp-config.js";
import { createWorkspaceMcpTrust } from "../src/workspace-mcp-trust/index.js";

/**
 * X23（3.17.2 移植）：工作区 MCP 声明的信任闸门。
 *
 * 为什么必须钉住：改前 bootstrap 里是 `untrustedProjectMcpServers = new Set()` —— project 作用域 MCP
 * 默认全信任并自动连接，等于「仓库里落一个 MCP 配置 = 任意命令执行」。闸门的三条不变量：
 * 1. 未知声明默认拒绝（inspect 显示 trusted:false，allows 返回 false）；
 * 2. decide 落盘后只对同一份声明摘要放行；声明变更（命令/参数/env/cwd 变化）立刻回到未信任；
 * 3. 撤销后拒绝，且存储损坏不会把已有声明误显示成可信。
 *
 * 用真实文件系统（临时目录）而不是 mock：摘要覆盖配置解析后的执行形态，mock 掉解析就测不到
 * 「声明变了摘要就变」这条核心语义。用户配置与信任存储都指到临时目录，不碰 ~/.zcode。
 *
 * 运行：cd apps/zcode-cli/packages/bootstrap && node --import tsx --test test/workspaceMcpTrust.test.ts
 */

const SERVER_NAME = "ws-server";

/** 把信任存储根目录钉到测试自己的临时目录，避免读写真机 ~/.zcode。 */
async function writeUserConfig(userConfigPath: string, storageRoot: string): Promise<void> {
  await writeFile(userConfigPath, JSON.stringify({ storage: { dir: storageRoot } }), "utf8");
}
const DECLARATION = { command: "node", args: ["-e", "process.exit(0)"], type: "stdio" };

async function withWorkspace(run: (ctx: {
  authority: ReturnType<typeof createWorkspaceMcpTrust>;
  declaration: Record<string, unknown>;
  rewriteDeclaration: (next: Record<string, unknown>) => Promise<void>;
}) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "zcode-ws-mcp-trust-"));
  const workspace = join(root, "workspace");
  const userConfigPath = join(root, "user", "config.json");
  const agentsDir = join(workspace, ".agents");
  const declarationPath = join(agentsDir, "mcp.json");
  await mkdir(agentsDir, { recursive: true });
  await mkdir(join(root, "user"), { recursive: true });
  // 信任存储路径由 user config 的 storage.dir 决定；不写这一行就会落到真实 ~/.zcode/security，
  // 测试之间互相污染（还会碰到用户目录）。
  await writeUserConfig(userConfigPath, join(root, "storage"));
  const write = (servers: Record<string, unknown>) =>
    writeFile(declarationPath, JSON.stringify({ mcpServers: servers }), "utf8");
  await write({ [SERVER_NAME]: DECLARATION });
  try {
    // 与模块内部同一条解析路径取配置，保证摘要输入与 discover 完全一致。
    const declaration = ZCodeConfigFileSchema.parse({
      mcp: { servers: { [SERVER_NAME]: DECLARATION } },
    }).mcp!.servers![SERVER_NAME]!;
    await run({
      authority: createWorkspaceMcpTrust({ env: {}, userConfigPath, workingDirectory: workspace }),
      declaration,
      rewriteDeclaration: (next) => write({ [SERVER_NAME]: next }),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("未知声明默认拒绝：inspect 标记未信任，allows 放行与否以摘要为准", async () => {
  await withWorkspace(async ({ authority, declaration }) => {
    const reviews = await authority.inspect();
    const review = reviews[SERVER_NAME];
    assert.ok(review, "工作区声明必须出现在审核列表里");
    assert.equal(review.trusted, false);
    assert.equal(review.configuredEnabled, true);
    assert.equal(review.transport, "stdio");
    assert.match(review.declarationDigest, /^[a-f0-9]{64}$/u);
    assert.equal(await authority.allows(SERVER_NAME, declaration), false);
  });
});

test("decide 授权后 allows 生效；撤销后重新拒绝", async () => {
  await withWorkspace(async ({ authority, declaration }) => {
    const digest = (await authority.inspect())[SERVER_NAME]!.declarationDigest;
    await authority.decide(SERVER_NAME, digest, true);
    assert.equal((await authority.inspect())[SERVER_NAME]!.trusted, true);
    assert.equal(await authority.allows(SERVER_NAME, declaration), true);

    await authority.decide(SERVER_NAME, digest, false);
    assert.equal((await authority.inspect())[SERVER_NAME]!.trusted, false);
    assert.equal(await authority.allows(SERVER_NAME, declaration), false);
  });
});

test("声明变更后旧授权失效：摘要变化即回到未信任", async () => {
  await withWorkspace(async ({ authority, declaration, rewriteDeclaration }) => {
    const before = (await authority.inspect())[SERVER_NAME]!;
    await authority.decide(SERVER_NAME, before.declarationDigest, true);
    assert.equal(await authority.allows(SERVER_NAME, declaration), true);

    // 命令改一个字节：同一 server 名，不同执行形态。
    await rewriteDeclaration({ ...DECLARATION, args: ["-e", "process.exit(1)"] });
    const after = (await authority.inspect())[SERVER_NAME]!;
    assert.notEqual(after.declarationDigest, before.declarationDigest);
    assert.equal(after.trusted, false);
    assert.equal(await authority.allows(SERVER_NAME, declaration), false);
  });
});

test("陈旧摘要的 decide 被拒绝（不能用一个摘要批准另一份声明）", async () => {
  await withWorkspace(async ({ authority, rewriteDeclaration }) => {
    const stale = (await authority.inspect())[SERVER_NAME]!.declarationDigest;
    await rewriteDeclaration({ ...DECLARATION, args: ["-e", "process.exit(2)"] });
    await assert.rejects(
      () => authority.decide(SERVER_NAME, stale, true),
      /workspace_mcp_declaration_changed/,
    );
    assert.equal((await authority.inspect())[SERVER_NAME]!.trusted, false);
  });
});

test("用户级与插件来源不在审核范围（gate 不误伤）", async () => {
  await withWorkspace(async ({ authority, declaration }) => {
    assert.equal(
      await authority.allows(SERVER_NAME, { ...declaration, source: { kind: "user" } }),
      true,
    );
    assert.equal(
      await authority.allows(SERVER_NAME, { ...declaration, source: { kind: "plugin" } }),
      true,
    );
  });
});
/** 最小可用的假 MCP port：只记录真正被调用到的连接动作。 */
function createRecordingMcpPort() {
  const connected: string[] = [];
  const port = {
    async callTool() {
      throw new Error("not used");
    },
    async close() {
      return undefined;
    },
    async connectConfiguredServers(servers: Record<string, unknown>) {
      for (const name of Object.keys(servers)) connected.push(name);
      return { statuses: {}, tools: [] };
    },
    async connectServer(name: string) {
      connected.push(name);
      return { status: "connected", transport: "stdio", toolCount: 1, updatedAt: new Date().toISOString() };
    },
    async disconnectServer() {
      return undefined;
    },
    async listTools() {
      return [];
    },
    async status() {
      return {};
    },
  };
  return { connected, port: port as unknown as import("@zcode/contracts").McpPort };
}

test("guard 在连接准入处拒绝未信任声明：状态可见 untrusted，raw port 一次都没被连接", async () => {
  await withWorkspace(async ({ authority, declaration }) => {
    const raw = createRecordingMcpPort();
    const guarded = authority.guard(raw.port);

    const blocked = await guarded.connectServer(SERVER_NAME, declaration);
    assert.equal(blocked.status, "untrusted");
    assert.equal(blocked.toolCount, 0);
    assert.deepEqual(raw.connected, [], "未信任时不得触碰底层连接");
    assert.equal((await guarded.status())[SERVER_NAME]!.status, "untrusted");
    assert.deepEqual(await guarded.listTools(), [], "未信任的 server 不暴露工具");

    // 授权后同一次 gate 立即放行（内存准入结果复用，不必重建 port）。
    const digest = (await authority.inspect())[SERVER_NAME]!.declarationDigest;
    await authority.decide(SERVER_NAME, digest, true);
    assert.equal((await guarded.connectServer(SERVER_NAME, declaration)).status, "connected");
    assert.deepEqual(raw.connected, [SERVER_NAME]);

    // 撤销后新建连接重新被拒（已建立连接按上游语义不回溯断开）。
    await authority.decide(SERVER_NAME, digest, false);
    assert.equal((await guarded.connectServer(SERVER_NAME, declaration)).status, "untrusted");
    assert.deepEqual(raw.connected, [SERVER_NAME], "撤销后不得再次连接");
  });
});
test("信任存储损坏时默认拒绝：既不显示为可信，也不放行连接", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-ws-mcp-trust-corrupt-"));
  const workspace = join(root, "workspace");
  const userConfigPath = join(root, "user", "config.json");
  const storageRoot = join(root, "storage");
  await mkdir(join(workspace, ".agents"), { recursive: true });
  await mkdir(join(root, "user"), { recursive: true });
  await writeUserConfig(userConfigPath, storageRoot);
  await writeFile(
    join(workspace, ".agents", "mcp.json"),
    JSON.stringify({ mcpServers: { [SERVER_NAME]: DECLARATION } }),
    "utf8",
  );
  const declaration = ZCodeConfigFileSchema.parse({
    mcp: { servers: { [SERVER_NAME]: DECLARATION } },
  }).mcp!.servers![SERVER_NAME]!;
  const authority = createWorkspaceMcpTrust({ env: {}, userConfigPath, workingDirectory: workspace });
  try {
    const digest = (await authority.inspect())[SERVER_NAME]!.declarationDigest;
    await authority.decide(SERVER_NAME, digest, true);
    assert.equal(await authority.allows(SERVER_NAME, declaration), true);

    // 写坏同一份存储：读不出来的记录不能被当成「已授权」。
    const storePath = join(storageRoot, "security", "workspace-mcp-trust-v1.json");
    await writeFile(storePath, "{ not json", "utf8");
    const reviews = await authority.inspect();
    assert.equal(reviews[SERVER_NAME]?.trusted, false);
    assert.equal(await authority.allows(SERVER_NAME, declaration), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
/** 构造一条 session/create 的 MCP DTO（协议 schema 的形状）。 */
function protocolServer(overrides: Record<string, unknown>) {
  return {
    name: SERVER_NAME,
    command: "node",
    args: ["-e", "process.exit(0)"],
    env: [],
    ...overrides,
  };
}

test("F15：DTO 的 scope/cwd 映射成 runtime 的 source.kind 与 cwd", () => {
  const mapped = protocolMcpServersToRuntimeMcpConfig([
    protocolServer({ scope: "workspace", cwd: "/tmp/somewhere" }),
    { name: "user-http", type: "http", url: "https://example.com/mcp", headers: [], scope: "user" },
  ])!;
  assert.equal(mapped.servers[SERVER_NAME]!.source?.kind, "workspace");
  assert.equal(
    (mapped.servers[SERVER_NAME] as { cwd?: string }).cwd,
    "/tmp/somewhere",
    "stdio 的 cwd 必须随 DTO 还原，否则审核摘要与实际执行 cwd 不一致",
  );
  assert.equal(mapped.servers["user-http"]!.source?.kind, "user");
  // 缺省 scope：不带 source，gate 对同名工作区声明保持 fail-closed。
  const noScope = protocolMcpServersToRuntimeMcpConfig([protocolServer({})])!;
  assert.equal(noScope.servers[SERVER_NAME]!.source, undefined);
});

test("F15：session 注入的 server 不再被误判为工作区声明", async () => {
  await withWorkspace(async ({ authority }) => {
    // 逐个场景单独映射：mapping 按 server 名建索引，同数组里同名会互相覆盖。
    const mapOne = (overrides: Record<string, unknown>) =>
      protocolMcpServersToRuntimeMcpConfig([protocolServer(overrides)])!.servers[SERVER_NAME]!;

    // user 来源不在审核范围：即便同名于工作区声明也直接放行（这就是修复前会误拒的那条）。
    assert.equal(await authority.allows(SERVER_NAME, mapOne({ scope: "user" })), true);

    // workspace 来源仍要过闸门：未授权时拒绝。
    assert.equal(await authority.allows(SERVER_NAME, mapOne({ scope: "workspace" })), false);

    // 缺省 scope：不能证明是用户意图，保持 fail-closed。
    assert.equal(await authority.allows(SERVER_NAME, mapOne({})), false);
  });
});
