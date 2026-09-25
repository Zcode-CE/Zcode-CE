import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * 浏览器侧加载守卫：paths.ts 必须在「没有真实 node:os、也没有 HOME」的环境里可加载（task-111）。
 *
 * 缺陷形态（真浏览器实测）：web 客户端控制台一条 error ——
 *   TypeError: (0, R2e.homedir) is not a function
 *   at http://127.0.0.1:38429/assets/index-Dm2nPbA0.js:330:88150
 * 根因是 paths.ts 在模块顶层求值 `process.env.HOME?.trim() || homedir()`，而本模块会被
 * packages/ui 以值导入（如 src/lib/cuaComposerEntryState.ts）⇒ 进浏览器产物。
 * Vite 对浏览器构建的 node 内置模块不做 polyfill，产物里 node:os 是空对象
 * （bundle 原文：`({}).ZCODE_DATA_BASE_DIR?.trim(),{}.HOME?.trim()||(0,R2e.homedir)()`）。
 *
 * 为什么端到端那条（packages/web/test/webLoadConsoleErrors.test.ts）还不够：
 * 它跑的是已构建的 dist，而 dist 可能陈旧 —— 本缺陷正是被旧 dist 藏了整批
 * （同一份源码，旧产物下那条用例是绿的）。这条用例把同一条加载路径钉在源码上：
 * 它 import 的就是 src/paths.ts，把求值挪回模块顶层立刻变红（已反向验证）。
 *
 * 怎么构造「浏览器」：见 support/browserNodeOsShim.mjs（node:os 换空对象）+
 * 子进程 env 去掉 HOME 与 ZCODE_DATA_BASE_DIR。不引入 jsdom 等新依赖，
 * 也不在产品代码里加环境检测分支 —— 那类分支正是本任务要避免的东西。
 *
 * 运行：cd packages/services && node --import tsx --test test/pathsBrowserBundleLoad.test.ts
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const pathsSource = join(repoRoot, "packages", "services", "src", "paths.ts");
const osShimUrl = new URL("./support/browserNodeOsShim.mjs", import.meta.url).href;

interface ProbeResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * 在子进程里加载真实的 src/paths.ts。
 *
 * 为什么用子进程：加载期的副作用（本缺陷就是加载期抛错）无法在已加载的进程里复现，
 * 而 --import 钩子必须挂在进程启动时（与 test/support/zcodeSourceResolver.mjs 同一理由）。
 * 子进程还让「这个环境没有真实 node:os / 没有 HOME」与其它用例互不干扰。
 */
function loadPathsWithoutNodeOs(probeBody: string): ProbeResult {
  const dir = mkdtempSync(join(tmpdir(), "zcode-paths-browser-"));
  try {
    const probePath = join(dir, "probe.mts");
    writeFileSync(
      probePath,
      [
        `import { getDataBaseDir, getZCodeDataRootDir } from ${JSON.stringify(pathsSource)};`,
        probeBody,
      ].join("\n"),
    );
    // 浏览器形状的另一半：env 里既没有 HOME 也没有 ZCODE_DATA_BASE_DIR，
    // 于是顶层表达式只能落到 homedir()（正是崩溃那一支）。
    const env = { ...process.env };
    delete env.HOME;
    delete env.ZCODE_DATA_BASE_DIR;
    try {
      const stdout = execFileSync(
        process.execPath,
        ["--import", "tsx", "--import", osShimUrl, probePath],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      return { status: 0, stdout, stderr: "" };
    } catch (error) {
      const failure = error as { status?: number | null; stdout?: string; stderr?: string };
      return {
        status: failure.status ?? null,
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? "",
      };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("浏览器形状的环境下加载 paths.ts 不得抛错（模块顶层不得求值默认数据根）", () => {
  const result = loadPathsWithoutNodeOs(
    [
      // 只证明「模块求值完成 + 导出可用」。故意不调用 getDataBaseDir()：
      // 真实 Web 客户端也不调用它（路径拼接是服务端的事），浏览器里没有任何
      // 可用的 HOME/homedir 兜底，调用它本来就该失败。本用例守的是加载期安全。
      'console.log("LOADED");',
      'console.log("EXPORTS=" + [typeof getDataBaseDir, typeof getZCodeDataRootDir].join(","));',
    ].join("\n"),
  );

  assert.equal(
    result.status,
    0,
    `加载 paths.ts 失败（浏览器里就是页面加载期的 TypeError）：\n${result.stderr}`,
  );
  assert.match(result.stdout, /LOADED/u, "探针没有跑完，输出：" + result.stdout);
  assert.match(result.stdout, /EXPORTS=function,function/u, "导出不可用，输出：" + result.stdout);
  assert.doesNotMatch(
    result.stderr,
    /homedir|is not a function/u,
    "出现 homedir 调用：说明默认数据根又回到模块顶层求值了。stderr：" + result.stderr,
  );
});
