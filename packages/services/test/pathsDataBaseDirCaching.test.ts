import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * 数据根的取值语义：优先级不变 + 首次求值后缓存（task-111）。
 *
 * 为什么要有这条：修浏览器崩溃时把默认数据根改成了惰性求值（原来在模块顶层求值），
 * 于是「什么时候读环境变量」这件事从「模块加载」变成「首次调用」。
 * 这条路正是 paths.ts:48-52 那条注释在守的东西 —— 服务实例会启动后台刷新任务，
 * 若每次调用都动态读 HOME，测试或宿主切换环境变量后，旧实例可能把数据写到新实例目录。
 * 所以必须同时钉住两件事：
 *   1) 优先级链不变：setDataBaseDir() > env ZCODE_DATA_BASE_DIR > HOME > homedir()；
 *   2) 首次求值后缓存：之后改 HOME 或 ZCODE_DATA_BASE_DIR 都不再影响结果。
 *
 * 为什么用子进程：缓存是模块级状态，同一进程里只能观测一次「首次求值」；
 * 而且必须能精确控制「模块加载时」的 env（测试文件里的静态 import 会被提升到赋值之前，
 * 见 test/onboardingRecordDeviceMid.test.ts 的同款说明）。
 *
 * 运行：cd packages/services && node --import tsx --test test/pathsDataBaseDirCaching.test.ts
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const pathsSource = join(repoRoot, "packages", "services", "src", "paths.ts");

/** 在给定 env 下加载真实 src/paths.ts，执行探针脚本，返回它打印的 JSON。 */
function probe(env: Record<string, string | undefined>, body: string[]): unknown {
  const dir = mkdtempSync(join(tmpdir(), "zcode-paths-cache-"));
  try {
    const probePath = join(dir, "probe.mts");
    writeFileSync(
      probePath,
      [
        `import { getDataBaseDir, setDataBaseDir } from ${JSON.stringify(pathsSource)};`,
        "const out = {};",
        ...body,
        "console.log(JSON.stringify(out));",
      ].join("\n"),
    );
    const childEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries({ ...process.env, ...env })) {
      if (typeof value === "string") childEnv[key] = value;
    }
    const stdout = execFileSync(process.execPath, ["--import", "tsx", probePath], {
      cwd: repoRoot,
      encoding: "utf8",
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(stdout.trim().split("\n").pop() as string);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("优先级：setDataBaseDir() > env ZCODE_DATA_BASE_DIR > HOME > homedir()", () => {
  const home = "/tmp/zcode-paths-cache-home";
  const envDir = "/tmp/zcode-paths-cache-env";

  const withEnvDir = probe({ HOME: home, ZCODE_DATA_BASE_DIR: envDir }, [
    "out.envWins = getDataBaseDir();",
    'setDataBaseDir("/tmp/zcode-paths-cache-injected");',
    "out.setWins = getDataBaseDir();",
    "setDataBaseDir(null);",
    // 清掉注入后回落到被缓存的 env 值（不是回落 HOME）—— 这条同时覆盖了缓存的取值来源。
    "out.afterClear = getDataBaseDir();",
  ]) as Record<string, string>;
  assert.deepEqual(withEnvDir, {
    envWins: envDir,
    setWins: "/tmp/zcode-paths-cache-injected",
    afterClear: envDir,
  });

  const withoutEnvDir = probe({ HOME: home, ZCODE_DATA_BASE_DIR: undefined }, [
    "out.homeWins = getDataBaseDir();",
  ]) as Record<string, string>;
  assert.equal(withoutEnvDir.homeWins, home, "没有 ZCODE_DATA_BASE_DIR 时必须是 HOME");

  const withoutHome = probe({ HOME: undefined, ZCODE_DATA_BASE_DIR: undefined }, [
    "out.homedirWins = getDataBaseDir();",
  ]) as Record<string, string>;
  assert.equal(withoutHome.homedirWins, homedir(), "没有 HOME 时必须回落到 homedir()");
});

test("首次求值后缓存：之后再改 HOME / ZCODE_DATA_BASE_DIR 都不改变结果", () => {
  const home = "/tmp/zcode-paths-cache-home";
  const result = probe({ HOME: home, ZCODE_DATA_BASE_DIR: undefined }, [
    "out.first = getDataBaseDir();",
    'process.env.HOME = "/tmp/zcode-paths-cache-home-later";',
    'process.env.ZCODE_DATA_BASE_DIR = "/tmp/zcode-paths-cache-env-later";',
    "out.afterEnvChange = getDataBaseDir();",
  ]) as Record<string, string>;

  assert.equal(result.first, home, "首次求值应读当时的 HOME");
  // 反向验证：把 getDataBaseDir() 改成每次动态读环境变量（即删掉缓存分支），这一条必须变红。
  assert.equal(
    result.afterEnvChange,
    home,
    "改 HOME / ZCODE_DATA_BASE_DIR 后结果变了 ⇒ 缓存丢了，旧实例会把数据写到新实例目录",
  );
});
