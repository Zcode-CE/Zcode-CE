import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
 * 若新增旁路模块：改 build-zcode.mjs 与这里两处，否则本文件会以"缺模块"的形式立刻变红。
 */
const RUNNER_SIDECAR_MODULES = ["runner-usage.mjs", "runner-config.mjs", "runner-web.mjs"];

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
