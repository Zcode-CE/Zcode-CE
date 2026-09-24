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

async function createDistributionFixture() {
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
  return directory;
}

function runRunner(directory, args) {
  const result = spawnSync(process.execPath, [join(directory, "bin/zcode.mjs"), ...args], {
    cwd: directory,
    encoding: "utf8",
  });
  return {
    status: result.status,
    output: String(result.stdout ?? "") + String(result.stderr ?? ""),
  };
}

/** 校验通过后 runner 会走到运行时文件检查，并在源码/夹具布局下报缺文件 —— 用它当「没被组合校验拦下」的信号。 */
const PASSED_VALIDATION = /Missing runtime file/;
const REJECTED = /Refusing to start: --no-token cannot be combined with a non-loopback --host/;

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
