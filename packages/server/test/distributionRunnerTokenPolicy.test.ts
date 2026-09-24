import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

/**
 * 分发入口 `zcode --web` 的组合校验护栏。
 *
 * 为什么放在 packages/server/test：
 * 这条断言与 `packages/server/src/http.ts` 的 `assertListenSecurity` 是**同一个安全不变式的两半** ——
 * 服务端对「非回环 + 无 token」fail-closed 硬拒绝，分发入口必须在**解析参数阶段**就给出同样的解释，
 * 否则用户会先看到「ZCode Web is running」的假象、再被二段错误打断（task-12/13 的由来）。
 * 放这里可以直接复用已登记进 `scripts/run-tests.mjs` 的 packages/server 测试包，无需为 `scripts/` 发明新的登记机制。
 *
 * 为什么用「临时 mini 分发包 + 子进程」而不是 import 那个脚本：
 * `scripts/zcode-distribution/runner.mjs` 在**模块顶层**就读 `<root>/package.json`，并以
 * `<root>/server|web|agent` 为运行时文件位置（`<root>` 是它的父目录），即它是**为安装后的发行目录写的**；
 * 在源码检出里直接跑会 `ENOENT .../scripts/package.json`（既有行为，与本护栏无关）。
 * 因此这里复制真实的 runner 到临时目录、补一个最小 package.json，按发行布局驱动它 ——
 * 也就是**最终消费点**上验证，而不是验证一个被抽取出来的纯函数。
 */

const repoRoot = resolve(import.meta.dirname, "../../..");
const runnerSource = join(repoRoot, "scripts/zcode-distribution/runner.mjs");
/**
 * runner.mjs 的**旁路模块**（task-49 拆分后引入的结构依赖）。
 *
 * 它们必须和 runner 一起进入 `bin/`：runner 现在 `import "./runner-*.mjs"`，漏拷任何一个都会让
 * 入口启动即 `ERR_MODULE_NOT_FOUND` —— 这正是分发打包必须同步修改的那一处
 * （`scripts/build-zcode.mjs` 里逐个 cp）。夹具按**发行布局**复制，所以这里也必须跟。
 *
 * **task-61 F2：清单不再在这里手写第三份，而是从 `build-zcode.mjs` 的拷贝循环现读**（单一真相源）。
 * 起因：此前打包清单与这里的清单各写一份、无交叉校验 ⇒ 只改 runner 的 import 而漏改拷贝清单时
 * PR 仍然全绿，包却缺文件。现在打包清单是唯一真相源，另有一条断言把「拷贝清单 ↔ runner 的真实 import」
 * 钉成集合相等（见文件末尾的用例）。
 */
function readPackagingSidecarModules() {
  const buildScriptPath = join(repoRoot, "scripts/build-zcode.mjs");
  const source = readFileSync(buildScriptPath, "utf8");
  const arrayLiteral = source.match(/for \(const sidecar of \[([^\]]*)\]/u);
  assert.ok(
    arrayLiteral,
    `${buildScriptPath} 里找不到旁路模块拷贝循环（for (const sidecar of [...])）：` +
      "要么循环被改写，要么打包清单被挪走；本护栏无法确认清单，必须人工修好",
  );
  const names = [...arrayLiteral[1].matchAll(/["'](runner-[a-z-]+\.mjs)["']/gu)].map(
    (match) => match[1],
  );
  assert.ok(
    names.length > 0,
    `${buildScriptPath} 的旁路模块拷贝清单解析为空：解析器失效时不能让下面的集合相等断言空转`,
  );
  return names;
}

const RUNNER_SIDECAR_MODULES = readPackagingSidecarModules();

/**
 * 建发行布局夹具。
 *
 * `withRuntimeFiles` 是 task-82 新增的**阳性对照**开关，作用是让"没有打印 running 横幅"这句
 * 断言**不是空断言**：
 * - 不带运行时文件时，校验通过也只会走到 `Missing runtime file` ⇒ 永远看不到横幅，
 *   于是 `doesNotMatch(/ZCode Web is running/)` 在任何情况下都成立，**钉不住"拒绝发生在打印之前"**；
 * - 带上（桩）运行时文件后，**通过校验的配置真的会打印横幅**（下面有专门一条断言证明这一点），
 *   于是"被拒绝的配置没有横幅"才真正说明**拒绝早于打印**。
 */
async function createDistributionFixture(options: { withRuntimeFiles?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "zcode-runner-guard-"));
  await mkdir(join(directory, "bin"), { recursive: true });
  await cp(runnerSource, join(directory, "bin/zcode.mjs"));
  for (const sidecar of RUNNER_SIDECAR_MODULES) {
    await cp(
      join(repoRoot, "scripts/zcode-distribution", sidecar),
      join(directory, "bin", sidecar),
    );
  }
  // runner 顶层会读 <root>/package.json 取 version；运行时文件检查只发生在校验通过之后。
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ name: "zcode-dist-runner-fixture", version: "0.0.0-test" }),
  );
  if (options.withRuntimeFiles) {
    // 桩运行时文件：只要三份都在，runner 就会越过 assertRuntimeFiles 走到 spawn + 打印横幅。
    await mkdir(join(directory, "server"), { recursive: true });
    await mkdir(join(directory, "web"), { recursive: true });
    await mkdir(join(directory, "agent"), { recursive: true });
    await writeFile(
      join(directory, "server/entry-http.js"),
      'console.log("[stub-server] started");process.exit(0);\n',
    );
    await writeFile(join(directory, "web/index.html"), "<!doctype html>\n");
    await writeFile(join(directory, "agent/zcode.cjs"), "module.exports = {};\n");
  }
  return directory;
}

function runRunner(
  directory: string,
  args: readonly string[],
  options: { env?: Record<string, string> } = {},
) {
  const result = spawnSync(process.execPath, [join(directory, "bin/zcode.mjs"), ...args], {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
  });
  return {
    status: result.status,
    output: String(result.stdout ?? "") + String(result.stderr ?? ""),
  };
}

/** 把配置写进夹具目录，返回路径（配合 ZCODE_CLI_CONFIG 使用）。 */
async function writeConfig(directory: string, name: string, value: unknown): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, JSON.stringify(value));
  return path;
}

/** 校验通过后 runner 会走到运行时文件检查，并在源码/夹具布局下报缺文件 —— 用它当「没被组合校验拦下」的信号。 */
const PASSED_VALIDATION = /Missing runtime file/;
const REJECTED = /Refusing to start: --no-token cannot be combined with a non-loopback --host/;
/** task-82：回环 + 登记域名/可信代理 + 无令牌的拒绝（与 REJECTED 是**两条不同的**文案）。 */
const REJECTED_LOOPBACK_PROXY =
  /Refusing to start: --no-token cannot be combined with a reverse-proxy/;
/** 起进程并打印横幅的标志 —— 「拒绝必须早于它」是 task-82 的核心断言。 */
const RUNNING_BANNER = /ZCode Web is running/;

test("分发 runner：非回环 + --no-token 在解析阶段就被拒绝（与服务端口径一致）", async () => {
  const directory = await createDistributionFixture();
  try {
    for (const host of ["0.0.0.0", "192.168.0.10", "::"]) {
      const { status, output } = runRunner(directory, ["--web", "--host", host, "--no-token"]);
      assert.equal(status, 1, "host=" + host + " 必须非零退出");
      assert.match(output, REJECTED, "host=" + host + " 必须给出与服务端一致的拒绝原因");
      // 提示必须给出两条可行路线（回环 / 带 token），否则用户无从下手。
      assert.match(output, /127\.0\.0\.1/);
      assert.match(output, /--token/);
      // 必须在触碰运行时文件之前就拒绝：否则用户会先看到「ZCode Web is running」的假象。
      assert.doesNotMatch(output, PASSED_VALIDATION);
      assert.doesNotMatch(output, /ZCode Web is running/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("分发 runner：--token=<空值> 等价于无 token，非回环下同样被拒绝", async () => {
  const directory = await createDistributionFixture();
  try {
    const { status, output } = runRunner(directory, ["--web", "--host", "0.0.0.0", "--token="]);
    assert.equal(status, 1);
    assert.match(output, REJECTED);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("分发 runner：回环 + --no-token 不被误伤（本地开发路径保持不变）", async () => {
  const directory = await createDistributionFixture();
  try {
    for (const host of ["127.0.0.1", "localhost"]) {
      const { status, output } = runRunner(directory, ["--web", "--host", host, "--no-token"]);
      assert.equal(status, 1, "夹具缺运行时文件，仍应以 1 退出");
      assert.doesNotMatch(output, REJECTED, "host=" + host + " 不该被组合校验拦下");
      assert.match(
        output,
        PASSED_VALIDATION,
        "host=" + host + " 应通过组合校验、走到运行时文件检查",
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("分发 runner：非回环 + 显式 token 仍然合法", async () => {
  const directory = await createDistributionFixture();
  try {
    const { output } = runRunner(directory, ["--web", "--host", "0.0.0.0", "--token=abc"]);
    assert.doesNotMatch(output, REJECTED);
    assert.match(output, PASSED_VALIDATION);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * task-61 F2：把「打包拷贝清单」与「runner 的真实 import」钉成集合相等。
 * 反向验证过：从 build-zcode.mjs 的拷贝清单里删掉任一项，这条用例立刻变红（其余 5 条仍绿）。
 */
test("分发 runner：打包拷贝清单与 runner 的真实 import 集合一致（漏拷必须在 PR 上变红）", () => {
  const runnerSourceText = readFileSync(runnerSource, "utf8");
  const imported = [...runnerSourceText.matchAll(/from\s+["'](\.\/runner-[a-z-]+\.mjs)["']/gu)].map(
    (match) => match[1].replace("./", ""),
  );
  assert.ok(
    imported.length > 0,
    "未能从 runner.mjs 解析出任何 ./runner-*.mjs import：解析器失效时必须显式失败，不能空转通过",
  );
  assert.deepEqual(
    [...imported].sort(),
    [...RUNNER_SIDECAR_MODULES].sort(),
    "runner.mjs 的 ./runner-*.mjs import 必须与 build-zcode.mjs 的拷贝清单集合相等：" +
      "漏拷任何一项，分发包启动即 ERR_MODULE_NOT_FOUND（只在 release 打包时才会暴露）",
  );
  for (const name of RUNNER_SIDECAR_MODULES) {
    assert.ok(
      existsSync(join(repoRoot, "scripts/zcode-distribution", name)),
      `${name} 被列进打包清单但文件不存在于 scripts/zcode-distribution/`,
    );
  }
});

test("分发 runner：--help 声明该约束", async () => {
  const directory = await createDistributionFixture();
  try {
    const { output } = runRunner(directory, ["--web", "--help"]);
    assert.match(output, /--no-token/);
    assert.match(output, /loopback/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// task-82：组合校验必须看**生效值**（env / 配置文件），且拒绝要早于打印横幅
//
// 背景（实测的缺陷）：校验此前留在 parseArgs 里，只看命令行 flag；而 host / noToken /
// 登记项都可以来自环境变量或配置文件（优先级 flag > env > 文件 > 默认）。于是下面这些配置
// 会**先打印 running 横幅**、再被服务端的二段错误打断 —— 正是该函数注释里要避免的形态。
// ---------------------------------------------------------------------------

test("阳性对照：带桩运行时文件的夹具**确实会**打印 running 横幅（否则下面的否定式断言是空断言）", async () => {
  const directory = await createDistributionFixture({ withRuntimeFiles: true });
  try {
    const { output } = runRunner(directory, ["--web", "--no-open", "--host", "127.0.0.1"]);
    assert.match(
      output,
      RUNNING_BANNER,
      "通过校验的配置必须能打印横幅 —— 这条是下面『拒绝时没有横幅』的前提，缺了它断言就空转：" +
        output,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("分发 runner：配置文件里的 host=0.0.0.0 + noToken 也必须在**打印横幅之前**被拒绝", async () => {
  const directory = await createDistributionFixture({ withRuntimeFiles: true });
  try {
    const config = await writeConfig(directory, "lan.json", { host: "0.0.0.0", noToken: true });
    const { status, output } = runRunner(directory, ["--web", "--no-open"], {
      env: { ZCODE_CLI_CONFIG: config },
    });
    assert.equal(status, 1, "必须非零退出：" + output);
    assert.match(output, REJECTED, "必须给出与服务端一致的拒绝原因");
    assert.doesNotMatch(output, RUNNING_BANNER, "拒绝必须早于 running 横幅（这就是本任务的由来）");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("分发 runner：环境变量 ZCODE_SERVER_HOST=0.0.0.0 + --no-token 同样要早于横幅被拒绝", async () => {
  const directory = await createDistributionFixture({ withRuntimeFiles: true });
  try {
    const { status, output } = runRunner(directory, ["--web", "--no-open", "--no-token"], {
      env: { ZCODE_SERVER_HOST: "0.0.0.0" },
    });
    assert.equal(status, 1);
    assert.match(output, REJECTED);
    assert.doesNotMatch(output, RUNNING_BANNER);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("分发 runner：回环 + 登记域名 + 无令牌 ⇒ 早于横幅被拒绝（本轮加固的服务端口径）", async () => {
  const directory = await createDistributionFixture({ withRuntimeFiles: true });
  try {
    // 三条来源各来一次：配置文件 / 环境变量 / flag 组合，确保不是只修了一条。
    const cases: { label: string; args: string[]; env: Record<string, string> }[] = [
      { label: "配置文件", args: ["--web", "--no-open"], env: {} },
      {
        label: "环境变量",
        args: ["--web", "--no-open", "--no-token"],
        env: { ZCODE_SERVER_TRUSTED_HOSTS: "panel.example" },
      },
      {
        label: "可信代理（环境变量）",
        args: ["--web", "--no-open", "--no-token"],
        env: { ZCODE_SERVER_TRUSTED_PROXIES: "127.0.0.1" },
      },
    ];
    const config = await writeConfig(directory, "domain.json", {
      host: "127.0.0.1",
      noToken: true,
      trustedHosts: ["panel.example"],
    });
    for (const testCase of cases) {
      const { status, output } = runRunner(directory, testCase.args, {
        env: { ZCODE_CLI_CONFIG: config, ...testCase.env },
      });
      assert.equal(status, 1, testCase.label + " 必须非零退出：" + output);
      assert.match(output, REJECTED_LOOPBACK_PROXY, testCase.label + " 必须给出拒绝原因");
      // 文案必须可操作（两条修法）且说清为什么。
      assert.match(output, /--token/);
      assert.match(output, /TRUSTED_HOSTS|TRUSTED_PROXIES/);
      assert.match(output, /ZCODE_SERVER_AUTH_TOKENS_FILE/);
      assert.doesNotMatch(output, RUNNING_BANNER, testCase.label + " 的拒绝必须早于横幅");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("分发 runner：**非法登记项不算信号**（判据读生效项，不读变量有没有设置）", async () => {
  const directory = await createDistributionFixture({ withRuntimeFiles: true });
  try {
    // 服务端会静默丢弃非法项；若 runner 据此拒绝，就会拒掉一个服务端本来能正常启动的配置
    // —— 那比"先打印横幅"严重得多。
    const config = await writeConfig(directory, "bad.json", {
      host: "127.0.0.1",
      noToken: true,
      trustedHosts: ["host:abc"],
      trustedProxies: ["not-an-ip"],
    });
    const { output } = runRunner(directory, ["--web", "--no-open"], {
      env: { ZCODE_CLI_CONFIG: config },
    });
    assert.doesNotMatch(output, REJECTED_LOOPBACK_PROXY, "非法项被丢弃 ⇒ 不得据此拒绝");
    assert.match(output, RUNNING_BANNER, "应当照常走到打印横幅");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("分发 runner：**令牌文件可用时不得误拒**（服务端实测 401/200 能起）", async () => {
  const directory = await createDistributionFixture({ withRuntimeFiles: true });
  try {
    // 实测依据：host=127.0.0.1 + TRUSTED_HOSTS + ZCODE_SERVER_AUTH_TOKENS_FILE（有内容）
    // ⇒ 服务端正常启动（无令牌 401 / 带令牌 200）。误拒它会让一个**能用的配置**直接起不来。
    const tokenPath = join(directory, "tokens");
    await writeFile(tokenPath, "file-token-abc\n");
    const config = await writeConfig(directory, "tokfile.json", {
      host: "127.0.0.1",
      trustedHosts: ["panel.example"],
      authTokensFile: tokenPath,
    });
    const { output } = runRunner(directory, ["--web", "--no-open"], {
      env: { ZCODE_CLI_CONFIG: config },
    });
    assert.doesNotMatch(output, REJECTED_LOOPBACK_PROXY, "有可用令牌文件 ⇒ 不得拒绝");
    assert.match(output, RUNNING_BANNER, "应当照常起");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("分发 runner：令牌文件**为空/只有注释**时不算可用令牌（与服务端 fail-closed 同向）", async () => {
  const directory = await createDistributionFixture({ withRuntimeFiles: true });
  try {
    const tokenPath = join(directory, "empty-tokens");
    await writeFile(tokenPath, "# 只有注释\n\n   \n");
    const config = await writeConfig(directory, "emptytok.json", {
      host: "127.0.0.1",
      noToken: true,
      trustedHosts: ["panel.example"],
      authTokensFile: tokenPath,
    });
    const { status, output } = runRunner(directory, ["--web", "--no-open"], {
      env: { ZCODE_CLI_CONFIG: config },
    });
    assert.equal(status, 1, "空令牌文件不能算作已配令牌：" + output);
    assert.match(output, REJECTED_LOOPBACK_PROXY);
    assert.doesNotMatch(output, RUNNING_BANNER);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("分发 runner：**仅登记 TRUSTED_ORIGINS 不得拒绝**（服务端对它只告警、不拒绝）", async () => {
  const directory = await createDistributionFixture({ withRuntimeFiles: true });
  try {
    const config = await writeConfig(directory, "origins.json", {
      host: "127.0.0.1",
      noToken: true,
      trustedOrigins: ["https://ui.example"],
    });
    const { output } = runRunner(directory, ["--web", "--no-open"], {
      env: { ZCODE_CLI_CONFIG: config },
    });
    assert.doesNotMatch(
      output,
      REJECTED_LOOPBACK_PROXY,
      "服务端对 TRUSTED_ORIGINS 只告警不拒绝 ⇒ runner 不得擅自升级成拒绝（会打死合法路径）",
    );
    assert.match(output, RUNNING_BANNER);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * **交叉校验（防解析口径漂移）**：runner 的解析是服务端解析器的镜像实现（分发包里的
 * bin/zcode.mjs 是纯 ESM，不能 import 服务端的 TS 模块）。这里把同一批语料同时喂给两边，
 * 断言「是否有生效项」的结论逐条一致 —— 服务端规则改了而忘了改镜像实现时，这条会变红。
 */
test("交叉校验：runner 的信号解析与服务端解析器对同一批语料结论一致", async () => {
  const runnerExposure = await import(
    join(repoRoot, "scripts/zcode-distribution/runner-exposure.mjs")
  );
  const { parseTrustedHosts } = await import("../src/hostAllowlist.js");
  const { parseTrustedProxies } = await import("../src/authThrottle.js");

  const hostCorpus = [
    "panel.example",
    "panel.example:8443",
    "PANEL.Example.",
    "[::1]:3030",
    "127.0.0.1",
    "host:abc",
    "1.2.3.4:80/path",
    "a b",
    "host:",
    "host:0",
    "host:70000",
    "",
    "   ",
    "::1:3030",
    "[::1",
  ];
  // **逐码位穷尽**：把 U+0000–U+009F 全塞进主机名，两侧结论必须逐条一致。
  // 这条不是装饰 —— 实现期我先用 `\p{Cc}` 代替了服务端的字符类，它把 C1 区（U+0080–U+009F）
  // 也判为控制字符，于是 runner 会拒掉服务端本来接受的 Host（32/176 条漂移）。
  // 正是这条穷尽语料把它抓出来的；只测 ASCII 控制字符会漏掉。
  for (let code = 0x00; code <= 0x9f; code += 1) {
    hostCorpus.push("host" + String.fromCharCode(code) + "x");
  }
  for (const raw of hostCorpus) {
    assert.equal(
      runnerExposure.parseTrustedHosts(raw).length > 0,
      parseTrustedHosts(raw).length > 0,
      "TRUSTED_HOSTS 语料 " + JSON.stringify(raw) + " 两侧的『是否有生效项』结论必须一致",
    );
  }

  const proxyCorpus = [
    "127.0.0.1",
    "10.0.0.0/8",
    "10.0.0.0/33",
    "not-an-ip",
    "::1",
    "2001:db8::/32",
    "2001:db8::/129",
    "",
    "   ",
    "1.2.3.4,,",
  ];
  for (const raw of proxyCorpus) {
    assert.equal(
      runnerExposure.parseTrustedProxies(raw).length > 0,
      parseTrustedProxies(raw).length > 0,
      "TRUSTED_PROXIES 语料 " + JSON.stringify(raw) + " 两侧的『是否有生效项』结论必须一致",
    );
  }

  // 优先级：非空 env 覆盖文件（与服务端 configEnv 的 setIfUnset 一致）。
  const byFile = runnerExposure.resolveExposureSignals({
    env: {},
    file: { trustedHosts: ["panel.example"] },
  });
  assert.equal(runnerExposure.hasExposureSignal(byFile), true, "文件里的登记项要算信号");
  const envWins = runnerExposure.resolveExposureSignals({
    env: { ZCODE_SERVER_TRUSTED_HOSTS: "host:abc" },
    file: { trustedHosts: ["panel.example"] },
  });
  assert.equal(
    runnerExposure.hasExposureSignal(envWins),
    false,
    "非空 env 覆盖文件（env 里的值是非法项 ⇒ 丢弃 ⇒ 无信号），这与服务端 configEnv 的优先级一致",
  );
});
