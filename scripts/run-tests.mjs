#!/usr/bin/env node
/**
 * 仓库测试入口。
 *
 * 背景：CE 被裁剪后没有根 test script，但 packages 下已有测试文件，
 * 需手工拼命令且容易漏跑。本脚本统一入口。
 *
 * 关键约束（实测得出，勿改）：
 * - runner 是 node:test（Node 内置），配 --import tsx 解析 TS。
 * - **必须从各包目录内执行**：ui 包用 tsconfig paths 的 `@/*` 别名，
 *   node 直跑不认，从仓库根跑会 ERR_MODULE_NOT_FOUND。
 * - 不引入任何新依赖（tsx 已是根 devDependency）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/**
 * 含测试的包目录（相对仓库根）。新增测试包时在此登记。
 *
 * 为什么登记制而不是自动发现：各包运行方式不同（有的要 cwd 在包内，有的要 --import tsx），
 * 自动发现容易在 CI 上跑出与环境相关的假失败。
 */
const TEST_PACKAGES = [
  // 危险命令清单的判据测试：**必须在这里登记**，否则 task-73 的 11 条断言
  // （提权 wrapper 参与判定、关闭可逆、放宽只认精确规则）不进 CI。
  "packages/shared",
  // Bash 授权链路的端到端行为测试：危险命令永不生成 :*、默认不投放持久授权、
  // 加严后此前落盘的规则不再放行。这是 task-73 的核心安全断言，同样必须进 CI。
  "apps/zcode-cli/packages/core",
  // TUI 的批准范围可视化：与 GUI 同构，是 task-72 P1 兜底缺口的第二个实例。
  "apps/zcode-cli/packages/tui",
  // MCP 工具级启停的配置解析（mcp.servers[].disabledTools）：mcpServerSchema 是 .strict() 的，
  // 少声明该键会让用户「关一个工具」变成「整个 MCP server 被跳过」。这几条断言必须进 CI。
  "apps/zcode-cli/packages/adapters",
  // 「设置页保存不丢 disabledTools」的往返链：mcp-sync 写盘 + UI 表单/DTO 白名单投影。
  // 这两处漏键都是**静默**的（用户以为关了、模型照样能调），只能靠测试钉住。
  "packages/services",
  "packages/ui",
  // 桌面端唯一的那条链路：protocol mcpServers → runtime config（逐字段白名单重建）。
  // 漏字段的后果是「设置页显示已关闭，agent 侧工具面一个没少」，同样只能靠测试钉住。
  "apps/zcode-cli/packages/bootstrap",
  // replay 结算次序闸（replay-order.ts）的端到端复现：**必须在这里登记**，否则那 3 条断言
  // （首生次序、修复后 resume 完成、修复前以 InputHashMismatch 失败）不进 CI。这条链路的
  // 回归现象是**静默的**——确定性脚本在 resume 后随机失败，只在真实使用里偶发。
  "apps/zcode-cli/packages/dynamic-workflow",
  // office 三插件的校验器测试：**必须在这里登记**，否则 4 条有牙齿的断言
  // （峰值内存受预算约束、命名空间密集 O(N²)、三份逐字节一致、staging 护栏）不进 CI。
  // 审计实测：未登记前 `pnpm test` 只跑 20 个文件，完全覆盖不到这些断言。
  // 注意它们用 .mjs（校验器本身是 Node 脚本），见下面的后缀列表。
  "apps/zcode-cli/packages/documents-plugin",
  // pdf 插件的校验器/生成器契约测试：**必须在这里登记**，否则 11 条有牙齿的断言
  // （页数不符、未嵌入、缺 /ToUnicode、无子集前缀、文本层缺字、bfrange 多码元目标不得错位、
  // 截断与非 PDF 必须结构化失败、参数 rc=2）不进 CI。用 .mjs，见下面的后缀列表。
  "apps/zcode-cli/packages/pdf-plugin",
  // HTTP 入口的监听安全默认值：**必须在这里登记**，否则 5 条安全断言
  // （非回环+无 token 拒绝启动、默认绑回环、非回环+token 放行、token 401/200、
  // cookie 的 Secure 随 https 变化）不进 CI —— 这条链路曾被实测为「绑所有网卡且无鉴权，
  // 未授权即可领 trusted-host ticket」，回归代价是不可见的暴露面。
  "packages/server",
  // 网页远控（M1）的断线自愈与版本配套：**必须在这里登记**，否则 7 条断言
  // （指数退避序列与上限、断线后重新建立连接、失败上限后停止自动重连、用户重试恢复预算、
  // 契约版本不一致或缺失必须显式失败）不进 CI。这条链路的回归现象是「手机锁屏后页面假死」，
  // 只会被真实使用发现，必须靠测试钉住。
  "packages/web",
  // 远程资产基址契约：两个自定义旋钮按字面值（发布根）、官方默认值保留前缀。
  // 漏测的后果是"安装包默认指向一个取不到 manifest 的地址"，用户侧表现为连接失败。
  "packages/desktop",
  // headless 动态工作流开关（--enable-workflow / --no-enable-workflow）的取值与语义：
  // **本仓库默认开启，与官方相反**。默认值被「照抄官方」改成关闭时，headless 的 /workflow
  // 与十个工作流工具会静默消失（无报错、无日志），只能靠测试钉住。含一条打到内置命令展开的断言。
  "apps/zcode-cli/packages/cli",
  // 无头 CLI 发行包的两个入口：tsup 必须把内联 CJS 依赖（yazl/yauzl）保留为 external。
  // 漏测的后果是「bundle 里留下会抛错的动态 require 兜底」⇒ 入口直接执行即崩 —— 而这条
  // 路径正是我们要发 npm/Docker 的用户形态（源码级断言恒跑；bundle/运行级断言在未构建时**显式 skip**）。
  "packages/zcode-server-cli",
];

/** 允许的测试文件后缀：packages 下用 TS（走 tsx），apps 下的脚本测试用 .mjs。 */
const TEST_FILE_SUFFIXES = [".test.ts", ".test.mjs"];

/**
 * 把 `@zcode/*` 从「构建产物 dist/」重定向到「源码 src/」的模块解析钩子（既有文件，勿另造）。
 *
 * 为什么只有 `apps/zcode-cli` 需要它（CI run 35990943160 的根因）：
 * CI 的 Test 步骤之前**只有** `pnpm typecheck`，而根 package.json 的 typecheck 是
 * `tsc -b packages/...` —— 工程列表**不含 apps/zcode-cli** ⇒ 该目录下的 dist 在 CI 上
 * **从不存在**（实测：无产物的树上跑完 typecheck 只新增根 packages 下的 dist）。
 * 而 apps/zcode-cli 的包（contracts / adapters / core / bootstrap …）exports 指向
 * `./dist/index.js` ⇒ 任何 import `@zcode/contracts` 的测试在 fresh clone 下必然
 * `ERR_MODULE_NOT_FOUND`。根 packages/* 不需要它：它们的 dist 由 typecheck 真产出，
 * 保持按 exports 解析（那才是它们的发布形态）。
 *
 * 为什么挂在**进程启动时**（--import）而不是测试文件里 import：
 * ESM 先 link 后 evaluate —— 测试文件顶部的 import 要到 link 阶段之后才执行，
 * 那时同文件的 `@zcode/*` 已经解析失败。实测：在测试文件里静态 import 本钩子，
 * 无 dist 下**仍然红**；只有 --import（或动态 import + 动态 import 被测模块）才生效。
 *
 * 与 packages/services/test/devChainAgentPayloads.test.ts 同源：那处是**子进程**需要它，
 * 这里是**测试进程自身**需要它。见 7f65e92 的注释「子进程同样要装」。
 */
const ZCODE_SOURCE_RESOLVER_URL = pathToFileURL(
  resolve(repoRoot, "packages/services/test/support/zcodeSourceResolver.mjs"),
).href;

/** 该包的测试是否需要「按源码解析 @zcode/*」（即它的 dist 在 CI 上不存在）。 */
function needsZcodeSourceResolver(packageDir) {
  return packageDir.startsWith("apps/zcode-cli/");
}

function collectTests(packageDir) {
  const testDir = join(repoRoot, packageDir, "test");
  if (!existsSync(testDir)) return [];
  return readdirSync(testDir)
    .filter((name) => TEST_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix)))
    .map((name) => join("test", name));
}

let totalTests = 0;
let failedPackages = 0;

for (const packageDir of TEST_PACKAGES) {
  const files = collectTests(packageDir);
  if (files.length === 0) {
    console.log(`[test] ${packageDir}: 无测试文件，跳过`);
    continue;
  }
  console.log(`[test] ${packageDir}: ${files.length} 个测试文件`);
  // cwd 必须是包目录：ui 的 @/* 别名依赖 tsconfig paths，node 直跑不认。
  const nodeArgs = ["--import", "tsx"];
  if (needsZcodeSourceResolver(packageDir)) {
    // 排在 tsx 之后：本钩子只做 specifier→源码路径，转译仍由 tsx 承担。
    nodeArgs.push("--import", ZCODE_SOURCE_RESOLVER_URL);
  }
  nodeArgs.push("--test", ...files);
  const result = spawnSync(process.execPath, nodeArgs, {
    cwd: join(repoRoot, packageDir),
    stdio: "inherit",
  });
  if (result.status !== 0) {
    failedPackages += 1;
  }
  totalTests += files.length;
}

console.log(`[test] 共 ${totalTests} 个测试文件，${failedPackages} 个包失败`);
process.exit(failedPackages === 0 ? 0 : 1);
