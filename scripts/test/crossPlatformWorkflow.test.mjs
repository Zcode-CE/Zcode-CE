import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

/**
 * 跨平台实测工作流（`.github/workflows/cross-platform.yml`）的形状护栏。
 *
 * 为什么需要它：这个 workflow 的存在理由是「把 macOS / Windows 的能构建 / 能启动 / 能连面板
 * 从**推断**变成**实测**」（`.reverse/36-ssh/ROADMAP.md` §1 阶梯 ①）。它有三条**会静默退化**的性质 ——
 * 退化了 workflow 仍然绿、仍然跑，但产出的东西不再是当初要的那份证据：
 *
 *   1. **触发时机**：一旦有人加上 `pull_request`，它就变成每个 PR 都跑三个 OS 的完整构建。
 *      `.reverse/45-release/CE3-CHECKLIST.md` §1 的 F2-M 已定口径「nightly 或发布前，不进每个 PR」，
 *      成本回归不会报错，只会让流水线变慢、信号变噪。
 *   2. **`continue-on-error`**：根 AGENTS.md 的硬规则 —— 交付终点失败必须让流水线变红。
 *      加一个 `continue-on-error` 会让「Windows 上这套 smoke 还没打通」伪装成「Windows 可用」，
 *      而这恰恰是本 workflow 唯一要回答的问题。**这是最危险的一种退化**：它把红变成绿。
 *   3. **矩阵缺 OS**：少一个 `macos-latest` 就等于那一列永远没人测，而 job 名字里仍写着
 *      `build + smoke (...)`，看起来仍在测。
 *
 * 判据是**从 workflow 现读**（`yaml.parse`），不在这里写第二份矩阵常量 —— 否则本护栏会与
 * workflow 各自漂移。它守不住的东西写在文件末尾。
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflowPath = resolve(repoRoot, ".github/workflows/cross-platform.yml");

function loadWorkflow() {
  let source;
  try {
    source = readFileSync(workflowPath, "utf8");
  } catch (error) {
    assert.fail(
      "读不到 " +
        workflowPath +
        "：" +
        String(error) +
        "。该 workflow 是 macOS / Windows 支持矩阵的唯一实测路径（见 docs/operations/headless-server.md §10），" +
        "删掉它等于把那两列退回「推断」——若确实要删，请同步改掉文档与 ROADMAP。",
    );
  }
  // 解析失败就失败，不静默跳过：语法坏的 workflow 在 GitHub 上**不会报错**，
  // 只会不运行（或整份文件被忽略），而那正是最难发现的一种失效。
  return parse(source);
}

/** 取矩阵里的 os 列表（`strategy.matrix.os` 形态）。 */
function matrixOperatingSystems(workflow) {
  const job = workflow.jobs["build-and-smoke"];
  assert.ok(job, "cross-platform.yml 里没有 build-and-smoke job");
  const os = job.strategy?.matrix?.os;
  assert.ok(Array.isArray(os), "build-and-smoke 的 strategy.matrix.os 不是列表");
  return os;
}

test("cross-platform.yml 覆盖 Linux / macOS / Windows 三个 OS", () => {
  const os = matrixOperatingSystems(loadWorkflow());
  for (const required of ["ubuntu-latest", "macos-latest", "windows-latest"]) {
    assert.ok(
      os.includes(required),
      "矩阵缺少 " +
        required +
        "（现有：" +
        os.join(", ") +
        "）—— 少了它就等于那一列永远没人测，而 job 名字仍写着 build + smoke (...) 看起来仍在测。",
    );
  }
});

test("一个 OS 失败不得连坐取消另外两个（fail-fast: false）", () => {
  const job = loadWorkflow().jobs["build-and-smoke"];
  assert.equal(
    job.strategy?.["fail-fast"],
    false,
    "build-and-smoke 的 fail-fast 必须是 false：本 job 的产出就是「三个 OS 各自到底行不行」，" +
      "连坐取消等于把实测变回没测。",
  );
});

test("不得用 continue-on-error 吞掉失败（红必须真的是红）", () => {
  const source = readFileSync(workflowPath, "utf8");
  // 去注释后再扫：本文件的注释里刻意解释了「为什么不设 continue-on-error」，
  // 扫注释会逼后来者删掉那段解释（同 releaseWorkflowReleasePaths.test.mjs 的 executableLines）。
  const executable = source
    .split("\n")
    .filter((line) => !/^\s*#/u.test(line))
    .join("\n");
  assert.doesNotMatch(
    executable,
    /continue-on-error/u,
    "cross-platform.yml 不得出现 continue-on-error：它会把「某个 OS 跑不通」伪装成「可用」，" +
      "而「到底通不通」正是本 workflow 唯一要回答的问题（根 AGENTS.md 硬规则）。",
  );
});

test("不进每个 PR（nightly 或手动），否则三 OS 完整构建会压在每个 PR 上", () => {
  const triggers = loadWorkflow().on ?? {};
  assert.ok(
    !("pull_request" in triggers) && !("push" in triggers),
    "cross-platform.yml 不应由 pull_request / push 触发（现有触发：" +
      Object.keys(triggers).join(", ") +
      "）。CE3-CHECKLIST §1 的 F2-M 已定口径：每 PR 跑整套三 OS 构建成本过高，走 nightly 或发布前。",
  );
  assert.ok(
    "workflow_dispatch" in triggers || "schedule" in triggers,
    "cross-platform.yml 至少要有 workflow_dispatch 或 schedule 之一，否则它永远不会运行" +
      "（「可测」不等于「测过了」）。",
  );
});

test("smoke 步骤消费构建产物的精确路径，且不存在时不伪装成通过", () => {
  const job = loadWorkflow().jobs["build-and-smoke"];
  const smoke = job.steps.find((step) => /smoke/i.test(step.name ?? ""));
  assert.ok(smoke, "cross-platform.yml 里没有 smoke 步骤");
  const script = smoke.run ?? "";
  assert.match(
    script,
    /zcode-distribution-smoke\.mjs/u,
    "smoke 步骤没有调用 scripts/zcode-distribution-smoke.mjs —— 那它就不是本 workflow 声称的「跑既有 smoke」",
  );
  // 判据与 release.yml 同源：产物布局是 releases/<版本>/<文件>，少一层匹配不到（tar status 2），
  // 用 * 通配会连历史版本一起取到（smoke 只读 argv[2] 且 glob 按字典序 ⇒ 可能「测旧版、发新版」）。
  assert.match(
    script,
    /releases\/\$VERSION\//u,
    "smoke 的 tarball 路径必须含版本目录（形如 dist/zcode/releases/$VERSION/zcode-$VERSION.tar.gz）—— " +
      "少一层匹配不到、用 * 通配可能测到历史版本。同一条不变式由 releaseWorkflowReleasePaths.test.mjs 守着。",
  );
  assert.match(
    script,
    /exit 1/u,
    "smoke 步骤在找不到产物时必须 exit 1：不把「没东西可测」伪装成通过。",
  );
});

/**
 * 本护栏守不住的东西（如实登记，别把它当成 workflow 本身正确的证明）：
 *
 * 1. 它断言的是 workflow 的**声明形状**，不是「它在 GitHub runner 上真能跑通」。
 *    Actions 只能在 GitHub 的 runner 上执行，本地无法运行工作流本身。
 * 2. 它不判「三个 OS 各自到底行不行」—— 那正是这个 workflow 要产出的**结果**，
 *    在第一次真实运行之前不存在。文档里那两列必须一直写作「未实测」（见
 *    docs/operations/headless-server.md §10 的「结果未观测」标注）。
 * 3. 它不判步骤内容是否会跨平台失败（例如 Windows 上裸 spawnSync("pnpm") 找不到 .cmd shim）。
 *    那类问题由 workflow 自己跑红来暴露，不在这里做静态推断。
 */
