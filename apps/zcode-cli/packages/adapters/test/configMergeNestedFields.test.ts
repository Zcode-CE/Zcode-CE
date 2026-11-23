import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigScope } from "@zcode/contracts";
import { createConfig } from "../src/config/config-factory.js";
import { createPrioritizedConfig, mergeConfigs } from "../src/config/config-merger.js";

/**
 * 配置层合并：高优先级层只声明嵌套对象的一部分键时，低优先级层的其余键必须保留。
 *
 * 为什么必须测这一层：Desktop 新建会话总会经 createConfigCliOverrides 传 `permission.mode`
 * （bootstrap/src/zcode-protocol/server-operations.ts 的 createWorkspaceZCodeApp），环境变量层
 * 只传 network/storage 的个别键。若合并把嵌套对象整体替换，用户配置里的 disallowedTools、
 * caCertFile、sessionDbPath 会在所有 Desktop 会话里静默失效 —— 权限收窄和网络证书都受影响，
 * 界面没有任何提示，所以断言要打在合并结果上，而不是「某一层自己解析正确」。
 *
 * 运行：cd apps/zcode-cli/packages/adapters && mise exec node@24.14.0 -- node --import tsx --test test/configMergeNestedFields.test.ts
 */

test("高优先级层只给 permission.mode 时，用户的权限列表仍然生效", () => {
  const merged = mergeConfigs(
    createPrioritizedConfig(
      {
        permission: {
          allowedTools: ["Read"],
          autoApproveHighRisk: true,
          disallowedTools: ["Bash"],
        },
      },
      ConfigScope.User,
    ),
    createPrioritizedConfig({ permission: { mode: "yolo" } }, ConfigScope.Cli),
  );

  assert.equal(merged.permission?.mode, "yolo");
  assert.deepEqual(merged.permission?.disallowedTools, ["Bash"]);
  assert.deepEqual(merged.permission?.allowedTools, ["Read"]);
  assert.equal(merged.permission?.autoApproveHighRisk, true);
});

test("环境变量层只给 network.httpProxy 时，用户的 caCertFile 与网络超时仍然生效", () => {
  const userNetwork = { caCertFile: "/etc/ssl/private-proxy.pem", timeout: 30_000 };
  const merged = mergeConfigs(
    createPrioritizedConfig({ network: userNetwork }, ConfigScope.User),
    createPrioritizedConfig(
      { network: { httpProxy: "http://127.0.0.1:7890" } },
      ConfigScope.Env,
    ),
  );

  assert.equal(merged.network?.httpProxy, "http://127.0.0.1:7890");
  assert.equal(merged.network?.caCertFile, "/etc/ssl/private-proxy.pem");
  assert.equal(merged.network?.timeout, 30_000);
});

test("storage / ui / features / logging 同样按字段合并", () => {
  const merged = mergeConfigs(
    createPrioritizedConfig(
      {
        features: { compact: false, mcp: true },
        logging: { level: "warn" },
        storage: { sessionDbPath: "/data/zcode/db.sqlite" },
        ui: { theme: "dark" },
      },
      ConfigScope.User,
    ),
    createPrioritizedConfig(
      {
        features: { rewind: false },
        logging: { format: "json" },
        storage: { dir: "/data/zcode" },
        ui: { locale: "zh-CN" },
      },
      ConfigScope.Project,
    ),
  );

  assert.deepEqual(merged.features, { compact: false, mcp: true, rewind: false });
  assert.deepEqual(merged.logging, { format: "json", level: "warn" });
  assert.deepEqual(merged.storage, { dir: "/data/zcode", sessionDbPath: "/data/zcode/db.sqlite" });
  assert.deepEqual(merged.ui, { locale: "zh-CN", theme: "dark" });
});

test("用户与项目各自停用的 skill / 命令都保留（不能只剩高优先级层那一个）", () => {
  const merged = mergeConfigs(
    createPrioritizedConfig(
      { skillOverrides: { "/skills/user-a/SKILL.md": { enable: false } } },
      ConfigScope.User,
    ),
    createPrioritizedConfig(
      { skillOverrides: { "/skills/project-b/SKILL.md": { enable: false } } },
      ConfigScope.Project,
    ),
    createPrioritizedConfig(
      { commandOverrides: { "/commands/user-c.md": { enable: false } } },
      ConfigScope.User,
    ),
    createPrioritizedConfig(
      { commandOverrides: { "/commands/project-d.md": { enable: false } } },
      ConfigScope.Project,
    ),
  );

  assert.deepEqual(merged.skillOverrides, {
    "/skills/project-b/SKILL.md": { enable: false },
    "/skills/user-a/SKILL.md": { enable: false },
  });
  assert.deepEqual(merged.commandOverrides, {
    "/commands/project-d.md": { enable: false },
    "/commands/user-c.md": { enable: false },
  });
});

test("mcp.servers 按 server 名分层合并，同名 server 由高优先级层整体替换", () => {
  const merged = mergeConfigs(
    createPrioritizedConfig(
      {
        mcp: {
          servers: {
            shared: { command: "user-cmd", type: "stdio" },
            userOnly: { command: "user-only", type: "stdio" },
          },
        },
      },
      ConfigScope.User,
    ),
    createPrioritizedConfig(
      {
        mcp: {
          servers: {
            projectOnly: { command: "project-only", type: "stdio" },
            shared: { command: "project-cmd", type: "stdio" },
          },
        },
      },
      ConfigScope.Project,
    ),
  );

  assert.deepEqual(Object.keys(merged.mcp?.servers ?? {}).sort(), [
    "projectOnly",
    "shared",
    "userOnly",
  ]);
  assert.equal(merged.mcp?.servers.shared?.command, "project-cmd");
});

test("低优先级层已停用的 skill 不会被高优先级层的空列表清掉", () => {
  const merged = mergeConfigs(
    createPrioritizedConfig(
      { skills: { enabled: false, roots: ["/skills/shared"] } },
      ConfigScope.User,
    ),
    createPrioritizedConfig({ skills: { roots: ["/skills/project"] } }, ConfigScope.Project),
  );

  assert.equal(merged.skills?.enabled, false);
  assert.deepEqual(merged.skills?.roots, ["/skills/project"]);
});

test("真实入口 createConfig：Desktop 只传 permission.mode 时用户配置仍然逐项生效", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-config-merge-"));
  try {
    const userConfigPath = join(dir, "config.json");
    const sessionDbPath = join(dir, "db.sqlite");
    await writeFile(
      userConfigPath,
      JSON.stringify({
        network: { caCertFile: "/etc/ssl/private-proxy.pem" },
        permission: {
          allowedTools: ["Read"],
          autoApproveHighRisk: true,
          disallowedTools: ["Bash"],
        },
        storage: { sessionDbPath },
        ui: { theme: "dark" },
      }),
      "utf8",
    );

    const { config } = createConfig({
      cliOverrides: { permission: { mode: "yolo" } },
      // 隔离宿主环境变量与项目配置，断言只反映 user 层 + cli 层。
      env: {},
      userConfigPath,
      workingDirectory: dir,
    });

    assert.equal(config.permission.mode, "yolo");
    assert.deepEqual(config.permission.disallowedTools, ["Bash"]);
    assert.deepEqual(config.permission.allowedTools, ["Read"]);
    assert.equal(config.permission.autoApproveHighRisk, true);
    assert.equal(config.network.caCertFile, "/etc/ssl/private-proxy.pem");
    assert.equal(config.storage.sessionDbPath, sessionDbPath);
    assert.equal(config.ui.theme, "dark");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
