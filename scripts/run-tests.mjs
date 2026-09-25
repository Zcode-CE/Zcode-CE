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
  // 发布链路上两个不可逆/易静默的判定，都是纯函数，用合成数据测（不碰网络与凭据）：
  //   1. 保留最近 N 个版本的清理计划 —— 误删 components/** 会让旧客户端连不上远程工作区，
  //      且无法恢复（那是内容寻址、跨版本共享的资产）；
  //   2. install.sh 的基址 —— npm 打包链路引入了一个占位基址，它一旦泄漏进正常构建，
  //      用户拿到的 install.sh 会指向永不解析的域名，而构建不会报错。
  // 这两个文件是 .mjs（被测的也是 .mjs 脚本，不经 TS 编译），见下面的后缀列表。
  "scripts",
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

/**
 * 测试前必须先生成的包内产物（登记制，勿自动发现 —— 理由同 TEST_PACKAGES）。
 *
 * 为什么需要它（CI run 36136866942 的根因）：@zcode/dynamic-workflow 的
 * src/compiler/compile.ts 以相对路径 `./libs.generated.js` 导入同目录的生成文件，
 * 而该文件只由本包的 scripts/generate-libs.mjs 产出（.ts 形态，且被 .gitignore 忽略）。
 * 根 package.json 的 typecheck 工程列表不含 apps/zcode-cli ⇒ 干净检出里它从不存在
 * ⇒ 测试在 ESM link 阶段直接 ERR_MODULE_NOT_FOUND。
 *
 * 实测否掉了三条看似更近的修法（勿回退到它们）：
 * - 不是 tsx 的映射缺口：tsx 本来就把 `./x.js` 映射到同名 `x.ts`，但只在目标文件存在时
 *   才成立。干净检出里补上 libs.generated.ts 后同一条命令即通过（实测 3/3）。
 *   所以缺的不是映射规则，而是这个文件本身；给 resolver 加「包内相对导入」规则等于
 *   新造一份 tsx 已有的行为，还扩大了它的风险面。
 * - 不是改 compile.ts 的 import：改成 `.ts` 需要 allowImportingTsExtensions，
 *   而本包要 tsc 产出 dist，emit 与 .ts 说明符不兼容。
 * - 不是让生成脚本额外产出 .js：产物落在 src/ 下要多一条 gitignore、与 .ts 形态重复，
 *   且 tsc 会把 src/** 里的 .js 一并纳入编译范围。
 *
 * 为什么在测试入口生成，而不是加 CI 步骤：加步骤会让所有测试变慢，且掩盖
 * 「测试依赖一个没人生成的产物」这个真问题。这里只对登记过的包跑它自己的生成脚本：
 * 幂等（typescript 版本一致即 exit 0）、实测 0.02s、不跑 tsc，因此不构成构建成本。
 */
const TEST_PACKAGE_GENERATORS = new Map([
  ["apps/zcode-cli/packages/dynamic-workflow", "scripts/generate-libs.mjs"],
]);

/**
 * 生成前置：在任何测试进程启动之前跑完所有登记的生成脚本。
 *
 * 为什么必须是前置而不是「跑到那个包时再生成」：依赖是跨包的。core 与 bootstrap 的测试
 * 经 @zcode/dynamic-workflow 的 src/index.ts 传递导入 compile.ts，而 core 在 TEST_PACKAGES 里
 * 排在 dynamic-workflow 之前 —— 实测按包内生成时 core 仍然红（110 文件 / 2 包失败），
 * 只有把生成提前到循环之外才对。所以这里不做「按需」优化：登记的生成脚本一共只有 0.02s。
 *
 * 生成失败必须立刻终止，不能带着缺失的模块去跑测试 —— 那样报出来的是
 * ERR_MODULE_NOT_FOUND，会把「生成脚本坏了」误诊成「导入路径写错了」。
 */
function generateTestPrerequisites() {
  for (const [packageDir, generator] of TEST_PACKAGE_GENERATORS) {
    const result = spawnSync(process.execPath, [generator], {
      cwd: join(repoRoot, packageDir),
      stdio: "inherit",
    });
    if (result.status !== 0) {
      console.error(
        `[test] ${packageDir}: 生成脚本 ${generator} 失败（exit ${result.status}）—— 测试依赖它，终止`,
      );
      process.exit(1);
    }
  }
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

generateTestPrerequisites();

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
