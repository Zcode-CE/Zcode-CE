import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * dev 运行链的载荷回归测试（task-74）。
 *
 * 守的是什么：`pnpm dev:desktop` 下 office 三库与 Computer Use 驱动**必须和打包态同能力**。
 * 缺陷形态（AUDIT-2 §2.2 实测）：dev 的 agent 入口是 `cli/dist/zcode.cjs`，seed 的候选基目录
 * 是 `[cli/dist, cli/dist, cwd]` —— 里面**没有** `bundled-agents/<key>/glm`，所以打包链
 * 那两步 stage 对 dev 完全无效，源树里既没有 `scripts/office-node/*.cjs` 也没有
 * `node-repl-host/node_modules/@trycua`。症状：office 技能 require 失败；第一次调 CUA 拿到
 * 与用户报错逐字相同的 `Cannot find package '@trycua/cua-driver'`。
 *
 * 为什么必须打到 **seed 之后**：stage 出文件 ≠ 运行时还在 —— seed 的顶层白名单会静默裁剪
 * （node_modules 只在「插件根直属 + 白名单含它」时保留）。本项目已四次踩过「验证停在中间产物」，
 * 所以这里从 **seed 后的 cache** 出发，而不是只看 staged 树。
 *
 * 运行：cd packages/services && node --import tsx --test test/devChainAgentPayloads.test.ts
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** 与 dev 链同源：载荷必须落在这个目录（= agent 入口所在目录 = seed 候选基目录第一顺位）。 */
const DEV_AGENT_ENTRY_RELATIVE = "apps/zcode-cli/packages/cli/dist/zcode.cjs";

/**
 * 把 `@zcode/*` 解析到**源码**的模块解析钩子，供下面的 seed 子进程 `--import` 装载。
 *
 * 为什么必须有它（CI run 35797390059 的根因）：CI 的 Test 步骤之前只有
 * `pnpm typecheck` = `tsc -b packages/...`，而那个工程列表**不含 apps/zcode-cli**
 * ⇒ `apps/zcode-cli` 下的 dist 在 CI 上**从不存在**（实测：在无产物的树上跑完
 * typecheck，只新增 9 个根 packages 下的 dist，apps/zcode-cli 下一个都没有）。
 * 而 bootstrap 的传递依赖
 * `@zcode/adapters` 的 exports 指向 `./dist/index.js` ⇒ 本用例在 fresh clone 下
 * 必然 `ERR_MODULE_NOT_FOUND`。
 *
 * **本地为什么绿**：本机跑过构建，该 dist 已在磁盘上 —— 典型的「本地验证依赖了本地状态」。
 * 钩子让整条依赖链从源码解析，于是本用例不再需要任何构建前提。详见该文件头注释。
 */
const ZCODE_SOURCE_RESOLVER_URL = new URL("./support/zcodeSourceResolver.mjs", import.meta.url)
  .href;

/**
 * 在子进程里跑**真实 seed**，argv[1] 指向 staged 资产根 —— 逐字复刻 dev 的发现路径。
 *
 * 为什么用子进程而不是改本进程的 argv/cwd：`listEntrypointCandidateBaseDirs()` 读的是
 * `process.argv[1]` / `__dirname` / `process.cwd()` 三个全局量。子进程能精确控制这三者、
 * 且不会把全局状态泄漏给同文件的其他用例。
 */
function seedFromAssetRoot({ assetRoot, storageRoot, workspace }) {
  const probePath = join(workspace, "seed-probe.mts");
  writeFileSync(
    probePath,
    [
      `import { mkdirSync, readdirSync, existsSync } from "node:fs";`,
      `import { join } from "node:path";`,
      `const [assetRoot, storageRoot, workspace] = process.argv.slice(2);`,
      `// 候选基目录第一顺位 = dirname(argv[1])，与 dev 的 zcodeAgentProcessManager 同口径。`,
      `process.argv[1] = join(assetRoot, "zcode.cjs");`,
      `process.chdir(workspace);`,
      `const app = join(${JSON.stringify(repoRoot)}, "apps/zcode-cli/packages/bootstrap/src/app");`,
      `const { resolveOfficialPluginRoots } = await import(join(app, "bundled-plugins.ts"));`,
      `mkdirSync(storageRoot, { recursive: true });`,
      `resolveOfficialPluginRoots({ storageRoot, env: {} });`,
      `const cacheRoot = join(storageRoot, "cache", "zcode-plugins-official");`,
      `const out = {};`,
      `for (const name of readdirSync(cacheRoot)) {`,
      `  const versionDir = join(cacheRoot, name);`,
      `  for (const version of readdirSync(versionDir)) {`,
      `    if (version.includes(".seed-lock") || version.includes(".tmp-") || version.includes(".backup")) continue;`,
      `    const root = join(versionDir, version);`,
      `    out[name + "@" + version] = {`,
      `      hasOfficeNode: existsSync(join(root, "scripts", "office-node")),`,
      `      officeNodeFiles: existsSync(join(root, "scripts", "office-node"))`,
      `        ? readdirSync(join(root, "scripts", "office-node")).sort()`,
      `        : [],`,
      `      pdfNodeFiles: existsSync(join(root, "scripts", "pdf-node"))`,
      `        ? readdirSync(join(root, "scripts", "pdf-node")).sort()`,
      `        : [],`,
      `      hasTrycua: existsSync(join(root, "node_modules", "@trycua")),`,
      `      nodeModulesEntries: existsSync(join(root, "node_modules"))`,
      `        ? readdirSync(join(root, "node_modules")).sort()`,
      `        : [],`,
      `    };`,
      `  }`,
      `}`,
      `console.log(JSON.stringify(out));`,
    ].join("\n"),
  );
  const stdout = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      // 子进程同样要装：bootstrap 的传递依赖 @zcode/* 在 CI 上没有 dist（见上方常量注释）。
      // 排在 tsx 之后：本钩子只做 specifier→源码路径，转译仍由 tsx 承担。
      "--import",
      ZCODE_SOURCE_RESOLVER_URL,
      probePath,
      assetRoot,
      storageRoot,
      workspace,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  return JSON.parse(stdout.trim().split("\n").pop());
}

test("dev staging puts the office bundles and the driver at the agent entry's directory", async () => {
  // 落点本身就是判据：必须是 cli/dist（agent 入口所在目录），而不是 bundled-agents/<key>/glm
  // —— 后者 dev 的候选基目录里根本没有，stage 了也读不到。
  const { resolveDevAgentAssetRoot, listDevPayloadPluginDirNames } =
    await import("../../desktop/scripts/dev-agent-payloads.mjs");
  assert.equal(
    resolveDevAgentAssetRoot({ repoRoot }),
    resolve(repoRoot, DEV_AGENT_ENTRY_RELATIVE, ".."),
  );
  // 清单从载荷模块派生，不是手写的第二份：改了 office 载荷表这里必须跟着变。
  assert.deepEqual(listDevPayloadPluginDirNames(), [
    "documents-plugin",
    "node-repl-host",
    "pdf-plugin",
    "presentations-plugin",
    "spreadsheets-plugin",
  ]);
});

test("dev-staged payloads survive the real seed and reach the runtime cache", async (t) => {
  const { stageDevAgentPayloads } = await import("../../desktop/scripts/dev-agent-payloads.mjs");
  const workRoot = mkdtempSync(join(tmpdir(), "zcode-dev-chain-payloads-"));
  const assetRoot = join(workRoot, "agent-entry");
  const storageRoot = join(workRoot, "storage");
  const workspace = join(workRoot, "workspace");
  rmSync(assetRoot, { recursive: true, force: true });
  execFileSync(process.execPath, [
    "-e",
    `require("node:fs").mkdirSync(${JSON.stringify(workspace)}, { recursive: true })`,
  ]);

  try {
    await stageDevAgentPayloads({ repoRoot, assetRoot, log: () => {} });

    // ── ① staged 树：载荷已落盘
    for (const [plugin, file] of [
      ["documents-plugin", "docx.cjs"],
      ["presentations-plugin", "pptxgenjs.cjs"],
      ["spreadsheets-plugin", "exceljs.cjs"],
    ]) {
      assert.ok(
        existsSync(join(assetRoot, "packages", plugin, "scripts", "office-node", file)),
        `staged 树缺少 ${plugin}/scripts/office-node/${file}`,
      );
    }
    assert.ok(
      existsSync(join(assetRoot, "packages", "node-repl-host", "node_modules", "@trycua")),
      "staged 树缺少 Computer Use 驱动",
    );

    // ── ② 最终消费点：seed 之后还在不在
    const cache = seedFromAssetRoot({ assetRoot, storageRoot, workspace });

    for (const [plugin, file] of [
      ["documents", "docx.cjs"],
      ["presentations", "pptxgenjs.cjs"],
      ["spreadsheets", "exceljs.cjs"],
    ]) {
      const entry = cache[`${plugin}@0.1.7`];
      assert.ok(entry, `seed 后 cache 缺少 ${plugin}@0.1.7`);
      assert.ok(
        entry.officeNodeFiles.includes(file),
        `seed 后 cache 缺少 ${plugin}/scripts/office-node/${file}（stage 出文件 ≠ 运行时还在）`,
      );
    }

    // pdf 载荷同理：pdfkit/fontkit 的 esbuild bundle 必须活到 seed 之后（缺了它，插件会以
    // "已启用但第一次调用就 MODULE_NOT_FOUND" 的形式暴露 —— task-6 实测过这个形态）。
    for (const file of ["pdfkit.cjs", "fontkit.cjs"]) {
      const entry = cache["pdf@0.1.7"];
      assert.ok(entry, "seed 后 cache 缺少 pdf@0.1.7");
      assert.ok(
        entry.pdfNodeFiles.includes(file),
        `seed 后 cache 缺少 pdf/scripts/pdf-node/${file}`,
      );
    }

    // ── ③ 源树 devDeps 不得被 stage 进载荷树
    // dev 链的 node-repl-host 源目录带着 84 MiB 构建期 devDeps（@esbuild/esbuild/typescript）。
    // 它们对运行期零用途；把它们 seed 进用户 cache 是纯浪费（AUDIT-2 §2.3 实测 83.3 MiB）。
    // 落 cli/dist 时 node_modules 由 stageCuaDriverIntoBundledAgents **新建**，所以天然不含它们。
    //
    // 判据落在 **staged 树**而不是只看 cache：staged 树是该不变量的**所有者** —— devDeps 是否
    // 被搬进来完全由 staging 决定，cache 只是它的下游（staged 里没有，cache 里就不可能有）。
    // 放这里还有一个必要理由：CI 不构建 node-repl-host（见 ④ 的前置说明），它的 cache 条目
    // 根本不存在，只断言 cache 会让这条用例在 CI 上永远失败。
    const devDependencyNames = ["@esbuild", "esbuild", "typescript", "undici-types"];
    const stagedHostModules = join(assetRoot, "packages", "node-repl-host", "node_modules");
    const stagedDevDeps = readdirSync(stagedHostModules).filter((name) =>
      devDependencyNames.includes(name),
    );
    assert.deepEqual(
      stagedDevDeps,
      [],
      `源树 devDeps 被 stage 进了载荷树：${stagedDevDeps.join(", ")}`,
    );

    // ── ④ CUA 驱动在 seed 后仍可加载（真正的最终消费点）
    //
    // **前置**：node-repl-host 的运行期 bundle（esbuild 打出的 dist/mcp/server.js）是真正的
    // 构建产物，且是它的 requiredSeedPaths 之一 —— 缺了它，seed 会（正确地）拒绝生成该插件的
    // cache。CI 的 Test 步骤不构建它（pnpm typecheck 的工程列表不含 apps/zcode-cli，实测在
    // 无产物的树上跑完 typecheck，apps/zcode-cli 下一个 dist 都没有），所以这里显式跳过并
    // 说明，而不是把一个**构建前提**伪装成产品断言。本地/打包链跑过构建时下面照常执行。
    const hostBundle = join(repoRoot, "apps/zcode-cli/packages/node-repl-host/dist/mcp/server.js");
    if (!existsSync(hostBundle)) {
      t.diagnostic(
        "node-repl-host bundle 未构建（CI 的 typecheck 不产出 apps/zcode-cli 下的 dist），" +
          "跳过 seed 后的 CUA 驱动加载断言",
      );
      return;
    }

    const host = cache["node-repl-host@0.6.0"];
    assert.ok(host, "seed 后 cache 缺少 node-repl-host@0.6.0");
    // ③ 的主判据在 staged 树；cache 侧再核一次，防「staging 干净但 seed 又把源树 devDeps 拖进来」。
    assert.deepEqual(
      host.nodeModulesEntries.filter((name) => devDependencyNames.includes(name)),
      [],
      "源树 devDeps 被搬进了用户 cache",
    );
    if (!host.hasTrycua) {
      assert.fail("seed 后 cache 缺少 node_modules/@trycua —— dev 下 CUA 会报 Cannot find package");
    }
    const cachedServer = join(
      storageRoot,
      "cache",
      "zcode-plugins-official",
      "node-repl-host",
      "0.6.0",
      "dist",
      "mcp",
      "server.js",
    );
    const module = await import(cachedServer);
    const runtime = module.captureComputerUseRuntimeFromEnvironment({
      ZCODE_CUA_NODE_REPL_HOST: "1",
    });
    assert.ok(
      runtime,
      "从 dev seed 后 cache 必须能构造 CUA runtime（驱动可解析），否则两道防自行装包的护栏会失效",
    );
    const result = await runtime.execute({
      toolName: "list_apps",
      arguments: {},
      context: { sessionId: "s", runtimeScope: "main", workspaceKey: "w" },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    await runtime.dispose();
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
});
