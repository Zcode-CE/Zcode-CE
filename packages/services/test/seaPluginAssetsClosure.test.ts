import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * SEA（单文件可执行）资产闭包测试：官方插件清单 + 内置技能包清单。
 *
 * 打到的最终消费点不是「staging 脚本输出了什么」，而是运行时 seed 门会接受的形态：
 *   - 官方插件：runtime 按 definition.name + definition.version 精确匹配清单条目，
 *     并要求 definition.requiredSeedPaths ⊆ 清单文件（bundled-plugins.ts 的
 *     resolveSeaSeedSource + findMissingOfficialPluginSeedPaths，缺一即整插件拒收）。
 *     所以这里把清单与权威定义（bootstrap/official-plugin-definitions.ts）逐项对齐。
 *   - 内置技能包：runtime 按清单 sha256 逐文件复核后解包到
 *     <cli storage>/bundled-skills/<hash>/（bundled-skills.ts 的
 *     materializeSeaBundledSkillPack），清单里的每个 sha256 必须与真实字节一致。
 *
 * 与 platformVariantAndCuaDriverStaging / devChainAgentPayloads 同族：实跑 staging
 * （含 esbuild 载荷）而非文本断言；未构建的运行时产物（node-repl-host dist）显式
 * 不在本测试范围（收集端 requireRuntime:false，与 build-sea 的 true 入口分开）。
 *
 * 运行：cd packages/services && node --import tsx --test test/seaPluginAssetsClosure.test.ts
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const cliWorkspaceRoot = join(repoRoot, "apps", "zcode-cli");
const cliScriptsRoot = join(cliWorkspaceRoot, "packages", "cli", "scripts");
const bootstrapAppRoot = join(cliWorkspaceRoot, "packages", "bootstrap", "src", "app");

/** 与 devChainAgentPayloads 同款：CI 上 apps/zcode-cli 的 dist 不存在，@zcode/* 按源码解析。 */
const ZCODE_SOURCE_RESOLVER_URL = new URL("./support/zcodeSourceResolver.mjs", import.meta.url)
  .href;

/** 从 bootstrap 源码导出权威定义（版本/必需资产）与内置技能包必需路径。 */
function readBootstrapAuthorities() {
  const probePath = join(tmpdir(), "zcode-sea-authorities-" + randomUUID() + ".mts");
  writeProbe(probePath);
  const stdout = execFileSync(
    process.execPath,
    ["--import", "tsx", "--import", ZCODE_SOURCE_RESOLVER_URL, probePath],
    { cwd: repoRoot, encoding: "utf8" },
  );
  rmSync(probePath, { force: true });
  const parsed = JSON.parse(stdout.trim().split("\n").pop() as string) as {
    bundledSkillRequiredPaths: string[];
    definitions: Record<string, { requiredSeedPaths: string[]; version: string }>;
  };
  return parsed;
}

function writeProbe(probePath: string) {
  const definitionsImport = JSON.stringify(bootstrapAppRoot + "/official-plugin-definitions.ts");
  const bundledSkillsImport = JSON.stringify(bootstrapAppRoot + "/bundled-skills.ts");
  const source = [
    "import { OFFICIAL_PLUGIN_DEFINITIONS } from " + definitionsImport + ";",
    "import { BUNDLED_SKILL_REQUIRED_PATHS } from " + bundledSkillsImport + ";",
    "const definitions = {};",
    "for (const definition of OFFICIAL_PLUGIN_DEFINITIONS) {",
    "  definitions[definition.name] = {",
    "    requiredSeedPaths: [...(definition.requiredSeedPaths ?? [])],",
    "    version: definition.version,",
    "  };",
    "}",
    "console.log(JSON.stringify({ bundledSkillRequiredPaths: [...BUNDLED_SKILL_REQUIRED_PATHS], definitions }));",
  ].join("\n");
  writeFileSync(probePath, source);
}

/** SEA 收集的完整插件名集合（与 official-plugin-definitions 的 CE 官方插件集一致）。 */
const EXPECTED_SEA_PLUGIN_NAMES = [
  "browser-use",
  "computer-use",
  "documents",
  "node-repl-host",
  "pdf",
  "presentations",
  "spreadsheets",
].sort();

const hashOfFile = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** 采集脚本是 .mjs（无类型），按清单形状显式声明，避免回调解构退化为 any。 */
interface SeaAssetFile {
  mode?: number;
  path: string;
  sha256: string;
}
interface SeaBundledSkillCollection {
  assets: Record<string, string>;
  manifest: { files: SeaAssetFile[]; hash: string; version: 1 };
}
interface SeaOfficialPluginCollection {
  manifest: {
    plugins: Array<{
      files: SeaAssetFile[];
      marketplace: string;
      name: string;
      version: string;
    }>;
    hash: string;
    version: 1;
  };
}

test("内置技能包 SEA 清单：必需资产齐、sha256 与真实字节一致、采集脚本与 bootstrap 常量同源", async () => {
  const { collectSeaBundledSkillAssets, bundledSkillPackRequiredPaths } = await import(
    join(cliScriptsRoot, "sea-bundled-skill-assets.mjs")
  );
  const { bundledSkillRequiredPaths } = readBootstrapAuthorities();

  const staging = mkdtempSync(join(tmpdir(), "zcode-sea-bs-closure-"));
  try {
    const { assets, manifest } = (await collectSeaBundledSkillAssets({
      root: cliWorkspaceRoot,
      stagingDirectory: staging,
    })) as SeaBundledSkillCollection;

    // 跨文件同源判据：脚本的双写常量必须与 bootstrap 逐字一致，否则构建期与运行期
    // 校验的是两套资产集（bundled-skills.ts 注释要求闭包测试钉住的那条）。
    assert.deepEqual(
      [...bundledSkillPackRequiredPaths].sort(),
      [...bundledSkillRequiredPaths].sort(),
      "sea 脚本与 bootstrap 的必需路径必须同源",
    );

    const paths = manifest.files.map((file) => file.path);
    for (const requiredPath of bundledSkillRequiredPaths) {
      assert.ok(paths.includes(requiredPath), "清单缺必需资产：" + requiredPath);
    }

    // 逐字节复核：运行时解包按清单 sha256 校验，清单错了只在用户首启才暴露。
    for (const file of manifest.files) {
      const assetKey = "zcode-bundled-skills/" + file.path;
      const sourcePath = assets[assetKey];
      assert.ok(sourcePath, "资产键缺失：" + assetKey);
      assert.equal(file.sha256, hashOfFile(sourcePath), "sha256 与字节不符：" + file.path);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
});

test("官方插件 SEA 闭包：清单条目与权威定义逐项对齐（运行时 seed 门的判据）", async () => {
  const { collectSeaOfficialPluginAssets } = await import(
    join(cliScriptsRoot, "sea-official-plugin-assets.mjs")
  );
  const { prepareSeaPluginNodePayloads } = await import(
    join(cliScriptsRoot, "sea-plugin-node-payloads.mjs")
  );
  const { definitions } = readBootstrapAuthorities();

  // browser-client.mjs 是 browser-use 插件自身 build 的产物（插件 .gitignore 忽略，
  // prepare:agent-bundle/bootstrap 走同一个构建入口产出）。definition 把它列为
  // 必需种子路径，干净检出上未先构建时清单会缺它（CI 就是在这里失败）——
  // build-sea 的真实流程同样先产出该产物再收集，这里与发布同一套 esbuild 选项。
  const browserUsePluginRoot = join(cliWorkspaceRoot, "packages", "browser-use-plugin");
  const { buildBrowserUsePluginBundles } = await import(
    join(browserUsePluginRoot, "scripts", "build.mjs")
  );
  await buildBrowserUsePluginBundles();

  const workRoot = mkdtempSync(join(tmpdir(), "zcode-sea-plugin-closure-"));
  const payloadStaging = join(workRoot, "payloads");
  const pluginStaging = join(workRoot, "official-plugins");
  try {
    // 与 build-sea.mjs 同序：先 stage 带 Node 载荷的副本，再收集。
    const { pluginRoots } = await prepareSeaPluginNodePayloads({
      root: cliWorkspaceRoot,
      stagingDirectory: payloadStaging,
      lookupRoots: [repoRoot, join(repoRoot, "packages", "desktop")],
    });
    // requireRuntime: false —— 运行时产物（node-repl-host dist / browser-use 构建）不在
    // 本闭包测试范围（build-sea 用 true，那一步在真实构建里校验）。
    const { manifest } = (await collectSeaOfficialPluginAssets({
      root: cliWorkspaceRoot,
      stagingDirectory: pluginStaging,
      pluginRoots,
    })) as SeaOfficialPluginCollection;

    assert.deepEqual(
      manifest.plugins.map((plugin) => plugin.name).sort(),
      EXPECTED_SEA_PLUGIN_NAMES,
      "SEA 清单必须覆盖 CE 全部官方插件",
    );

    for (const plugin of manifest.plugins) {
      const definition = definitions[plugin.name];
      assert.ok(definition, "权威定义缺插件：" + plugin.name);
      // 运行时精确匹配判据（bundled-plugins.ts 的 resolveSeaSeedSource）：版本不一致 ⇒ 插件不 seed。
      assert.equal(
        plugin.version,
        definition.version,
        plugin.name + ": SEA 清单版本与 definition 不一致（runtime 会精确匹配失败）",
      );
      const files = new Set(plugin.files.map((file) => file.path));
      // 必需资产判据（findMissingOfficialPluginSeedPaths）：缺一 ⇒ 整插件拒收。
      for (const requiredPath of definition.requiredSeedPaths) {
        assert.ok(
          files.has(requiredPath),
          plugin.name + ": 清单缺 definition 要求的必需资产 " + requiredPath,
        );
      }
    }

    // 载荷落点（写进暂存副本后才由收集器收入）：office 三库 + pdf 两库。
    const officePayloads = [
      "documents-plugin/scripts/office-node/docx.cjs",
      "presentations-plugin/scripts/office-node/pptxgenjs.cjs",
      "spreadsheets-plugin/scripts/office-node/exceljs.cjs",
    ];
    const pdfPayloads = [
      "pdf-plugin/scripts/pdf-node/pdfkit.cjs",
      "pdf-plugin/scripts/pdf-node/fontkit.cjs",
    ];
    for (const relativePath of [...officePayloads, ...pdfPayloads]) {
      const pluginName = relativePath.split("-plugin/")[0];
      const plugin = manifest.plugins.find((item) => item.name === pluginName);
      assert.ok(plugin, relativePath);
      const payloadRelative = relativePath.slice(pluginName.length + "-plugin/".length);
      assert.ok(
        plugin.files.some((file) => file.path === payloadRelative),
        "载荷未进清单：" + relativePath,
      );
      // 载荷必须真的在 staged 副本里（闭包不只在清单层面成立）。
      assert.ok(
        existsSync(join(payloadStaging, "glm", "packages", relativePath)),
        "staged 副本缺载荷：" + relativePath,
      );
    }

    // cua 从源码树收集（无载荷），三件必需资产在清单里即可（上面定义对齐已覆盖）。
    const cua = manifest.plugins.find((plugin) => plugin.name === "computer-use");
    assert.ok(cua, "computer-use 必须进 SEA 清单");
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
});
