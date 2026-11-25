// 插件敏感选项私有存储（docs/design/v2/plugin-compat.md「Sensitive Option Storage」的 CE 落地）。
//
// 钉住四条语义，任何一条放宽都会让敏感值回到仓库可控的文件里：
// 1. 敏感选项只进与 `plugins/` 同级的私有文件（0600），不进 config.json；
// 2. 私有文件的写入走文件锁 + 原子写（并发写不丢值、不留临时文件与锁目录）；
// 3. 私有文件读不出时按空处理并给出 `plugin_secrets_unreadable` 诊断，不是静默变空；
// 4. 项目层 `plugins.options` 从 merged config 剥离、原值不读回，并在装载时给出可诊断的原因。
//
// 用真实文件系统（临时目录）而不是 mock：这四条全部由「写盘后按真实读取链重新解析」才能证明。
// 插件存储目录固定到临时目录 ⇒ 私有文件落在 <root>/plugin-secrets.json，绝不触碰真实 ~/.zcode。
//
// 运行：cd apps/zcode-cli/packages/bootstrap && mise exec node@24.14.0 -- node --import tsx --test test/plugin-secrets.test.ts
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  createConfig,
  PLUGIN_SECRETS_FILE_NAME,
  readPluginSecretsFileSync,
} from "@zcode/adapters/config";
import {
  configureZCodePlugin,
  resolveZCodePlugins,
  type ResolveZCodePluginsOptions,
} from "../src/plugins.js";

const PLUGIN_NAME = "secret-plugin";
const PLUGIN_ID = `${PLUGIN_NAME}@inline`;
const PRIVATE_FILE_MODE = 0o600;
const FILE_MODE_MASK = 0o777;
const WINDOWS_PLATFORM = "win32";
/** 插件清单里的敏感键：保存时必须离开 config.json。 */
const SENSITIVE_KEYS = ["token", "apiKey", "refreshToken"] as const;

interface Fixture {
  /** 私有文件所在目录（插件存储目录的父目录）。 */
  root: string;
  pluginRoot: string;
  pluginStorageRoot: string;
  secretsPath: string;
  userConfigPath: string;
  workspace: string;
  options(): ResolveZCodePluginsOptions;
}

test("敏感选项只进私有文件：私有文件 0600，config.json 里没有值", async () => {
  await withFixture(async (fixture) => {
    // 只读解析不创建私有文件：读取路径无写副作用（不迁移、不初始化）。
    resolveZCodePlugins(fixture.options());
    assert.equal(existsSync(fixture.secretsPath), false);

    await configureZCodePlugin({
      ...fixture.options(),
      options: { region: "eu", token: "s3cret-user" },
      pluginId: PLUGIN_ID,
    });

    assert.deepEqual(await readJson(fixture.secretsPath), {
      version: 1,
      user: { [PLUGIN_ID]: { token: "s3cret-user" } },
      workspaces: {},
    });
    if (process.platform !== WINDOWS_PLATFORM) {
      const mode = (await stat(fixture.secretsPath)).mode & FILE_MODE_MASK;
      assert.equal(mode, PRIVATE_FILE_MODE, "私有文件必须是 0600");
    }
    const userConfigText = await readFile(fixture.userConfigPath, "utf8");
    assert.ok(!userConfigText.includes("s3cret-user"), "敏感值不能落进 config.json");
    assert.deepEqual(JSON.parse(userConfigText).plugins.options[PLUGIN_ID], { region: "eu" });

    // 读到最终消费点：发现阶段拿到的 configuredOptions 已经包含私有文件里的值。
    const plugin = findPlugin(fixture);
    assert.equal(plugin?.configuredOptions?.token, "s3cret-user");
    assert.equal(plugin?.configuredOptions?.region, "eu");
  });
});

test("私有文件写入走文件锁与原子写：并发写不丢值，且不留临时文件/锁目录", async () => {
  await withFixture(async (fixture) => {
    // 三个键同时写入同一个插件条目：没有文件锁时读改写会互相覆盖，只剩最后一个键。
    await Promise.all(
      SENSITIVE_KEYS.map((key, index) =>
        configureZCodePlugin({
          ...fixture.options(),
          options: { [key]: `value-${index}` },
          pluginId: PLUGIN_ID,
        }),
      ),
    );

    const secrets = await readJson(fixture.secretsPath);
    assert.deepEqual((secrets.user as Record<string, Record<string, string>>)[PLUGIN_ID], {
      apiKey: "value-1",
      refreshToken: "value-2",
      token: "value-0",
    });
    // 原子写：临时文件与锁目录都用后即清；残留会让别的进程误判锁占用或读到半截内容。
    const leftovers = (await readdir(fixture.root)).filter(
      (name) => name.endsWith(".tmp") || name.endsWith(".lock"),
    );
    assert.deepEqual(leftovers, []);
    if (process.platform !== WINDOWS_PLATFORM) {
      const mode = (await stat(fixture.secretsPath)).mode & FILE_MODE_MASK;
      assert.equal(mode, PRIVATE_FILE_MODE, "原子重写后的文件仍是 0600");
    }
    assert.equal(findPlugin(fixture)?.configuredOptions?.apiKey, "value-1");
  });
});

test("私有文件读不出：按空处理并给诊断，备份原文件，下一次保存自愈", async () => {
  await withFixture(async (fixture) => {
    const corrupt = '{"version":1,"user":{"' + PLUGIN_ID + '":{"token":"corrupt-secret"';
    await writeFile(fixture.secretsPath, corrupt, "utf8");

    const read = readPluginSecretsFileSync(fixture.secretsPath);
    assert.equal(read.status, "unreadable");
    assert.equal(read.reason, "corrupt");

    const outcome = resolveZCodePlugins(fixture.options());
    const diagnostic = outcome.diagnostics.find(
      (item) => item.code === "plugin_secrets_unreadable",
    );
    assert.ok(diagnostic, "读不出必须报 plugin_secrets_unreadable，不能静默变空");
    assert.equal(diagnostic.severity, "error");
    assert.ok(!JSON.stringify(outcome.diagnostics).includes("corrupt-secret"), "诊断不能带值");
    // 按空处理：私有值不生效，但不是「没有诊断的空」。
    assert.equal(
      outcome.plugins.find((item) => item.id === PLUGIN_ID)?.configuredOptions?.token,
      undefined,
    );
    const backups = (await readdir(fixture.root)).filter((name) =>
      name.startsWith(`${PLUGIN_SECRETS_FILE_NAME}.corrupt-`),
    );
    assert.equal(backups.length, 1, "损坏文件必须先备份成证据");
    assert.equal(await readFile(join(fixture.root, backups[0] ?? ""), "utf8"), corrupt);
    if (process.platform !== WINDOWS_PLATFORM) {
      const mode = (await stat(join(fixture.root, backups[0] ?? ""))).mode & FILE_MODE_MASK;
      assert.equal(mode, PRIVATE_FILE_MODE, "备份也是 0600");
    }

    await configureZCodePlugin({
      ...fixture.options(),
      options: { token: "fresh-secret" },
      pluginId: PLUGIN_ID,
    });
    assert.deepEqual((await readJson(fixture.secretsPath)).user, {
      [PLUGIN_ID]: { token: "fresh-secret" },
    });
    assert.ok(existsSync(join(fixture.root, backups[0] ?? "")), "备份保留，不随自愈删除");
    const healed = resolveZCodePlugins(fixture.options());
    assert.equal(
      healed.diagnostics.some((item) => item.code === "plugin_secrets_unreadable"),
      false,
    );
  });
});

test("项目层 plugins.options 被剥离：原值不生效、不读回，并给出可诊断原因", async () => {
  await withFixture(async (fixture) => {
    const projectConfigPath = join(fixture.workspace, ".zcode", "config.json");
    const repositoryOptions = {
      pythonPath: "./repository-runner",
      region: "repository-region",
      token: "repository-secret",
    };
    await writeJson(projectConfigPath, {
      plugins: { options: { [PLUGIN_ID]: repositoryOptions } },
    });

    const configResult = createConfig({
      env: {},
      userConfigPath: fixture.userConfigPath,
      workingDirectory: fixture.workspace,
    });
    // 剥离发生在合并层：项目层的值不再进入有效插件选项。
    assert.equal(configResult.config.plugins.options[PLUGIN_ID], undefined);
    const stripDiagnostics = configResult.sources.project.diagnostics.filter(
      (item) => item.code === "config_project_plugin_options_ignored",
    );
    assert.equal(stripDiagnostics.length, 1, "每个项目配置文件只报一次");
    const stripDiagnostic = stripDiagnostics[0];
    assert.ok(stripDiagnostic, "剥离必须留下可诊断的原因，不能静默丢");
    assert.equal(stripDiagnostic.path, "plugins.options");
    assert.equal(stripDiagnostic.filePath, projectConfigPath);
    assert.equal(stripDiagnostic.severity, "warning");

    // 原值不读回：仓库里的 token / pythonPath 既不生效，也不出现在任何诊断里。
    const outcome = resolveZCodePlugins(fixture.options());
    const plugin = outcome.plugins.find((item) => item.id === PLUGIN_ID);
    assert.equal(plugin?.configuredOptions?.token, undefined);
    assert.equal(plugin?.configuredOptions?.pythonPath, undefined);
    assert.ok(!JSON.stringify(outcome).includes("repository-secret"));

    // workspace 选项改由私有文件承载：保存后按 workspace root 隔离并生效。
    await configureZCodePlugin({
      ...fixture.options(),
      options: { region: "saved-workspace" },
      pluginId: PLUGIN_ID,
      scope: "workspace",
    });
    const secrets = await readJson(fixture.secretsPath);
    assert.deepEqual(secrets.workspaces, {
      [fixture.workspace]: { [PLUGIN_ID]: { region: "saved-workspace" } },
    });
    const savedEffective = findPlugin(fixture);
    assert.equal(savedEffective?.configuredOptions?.region, "saved-workspace");
    // 旧的项目层明文值被从文件里清掉（只清不迁），而不是留在仓库文件里继续误导人。
    const projectConfigText = await readFile(projectConfigPath, "utf8");
    assert.ok(!projectConfigText.includes("repository-secret"));
  });
});

/** 走真实读取链（发现阶段）取到插件元数据，避免只断言中间产物。 */
function findPlugin(fixture: Fixture) {
  return resolveZCodePlugins(fixture.options()).plugins.find((item) => item.id === PLUGIN_ID);
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "zcode-plugin-secrets-"));
  const pluginRoot = join(root, "plugin");
  const pluginStorageRoot = join(root, "plugins");
  const userConfigPath = join(root, "user", "config.json");
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeJson(join(pluginRoot, ".zcode-plugin", "plugin.json"), {
    name: PLUGIN_NAME,
    userConfig: {
      apiKey: { sensitive: true, type: "string" },
      refreshToken: { sensitive: true, type: "string" },
      region: { default: "us", type: "string" },
      token: { sensitive: true, type: "string" },
    },
  });
  await writeJson(userConfigPath, { plugins: { dirs: [pluginRoot] } });
  const fixture: Fixture = {
    options: () => ({
      env: {},
      pluginStorageRoot,
      userConfigPath,
      workingDirectory: workspace,
    }),
    pluginRoot,
    pluginStorageRoot,
    root,
    secretsPath: join(root, PLUGIN_SECRETS_FILE_NAME),
    userConfigPath,
    workspace,
  };
  try {
    await run(fixture);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}
