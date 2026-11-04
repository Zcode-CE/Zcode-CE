import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

/**
 * 发布两段式的护栏：构建期不得上传 Release，资产只能在冒烟通过之后发布。
 *
 * 为什么需要它：3.16.3-ce.1.fix.1 的失败形态是「Linux 启动冒烟红，但安装包已经在
 * Release 上」——因为 electron-builder 的 GitHub publisher 在 **构建步骤里** 直接上传，
 * 而冒烟在它之后。这类缺陷在本地完全看不见（workflow 只能在 GitHub 上跑），只能靠
 * 对 workflow 文本的结构断言钉住。
 *
 * 它守住的四条不变式：
 *   1. build 一律 --publish never（与 tag 无关），因此构建期不可能产出 Release 资产；
 *   2. 发布点唯一：publish-release 一个 job 里 `gh release upload`（+ 无 Release 时创建）；
 *   3. publish-release 依赖 build（冒烟在 build 里），且只在 tag 构建执行；
 *   4. 依赖 Release 已存在的后续 job（release-notes / headless）都等 publish-release。
 *
 * 守不住的：真实运行结果。GitHub Actions 本地跑不了，这里只做文本/结构级对账。
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflowPath = resolve(repoRoot, ".github/workflows/release.yml");

function loadWorkflow() {
  const source = readFileSync(workflowPath, "utf8");
  // 解析失败就失败，不静默跳过（语法坏的 workflow 在 GitHub 上不会报错，只会不运行）。
  return { source, workflow: parse(source) };
}

function stepRun(step) {
  return typeof step?.run === "string" ? step.run : "";
}

function findStep(job, name) {
  const step = (job?.steps ?? []).find((candidate) => candidate.name === name);
  assert.ok(step, "缺少名为 " + JSON.stringify(name) + " 的步骤");
  return step;
}

test("构建期一律 --publish never：tag 与非 tag 都不得在 build 里发布", () => {
  const { workflow } = loadWorkflow();
  const buildStep = findStep(workflow.jobs?.build, "Build installers");
  const run = stepRun(buildStep);
  assert.match(
    run,
    /--publish never\b/u,
    "Build installers 必须显式 --publish never：不传时 electron-builder 在 CI 下推断成 onTagOrDraft，" +
      "而 GitHub provider 的判据只有「不是 PR」—— 不是 tag 也会发布。",
  );
  assert.doesNotMatch(
    run,
    /--publish onTag/u,
    "不能在构建步骤里按 tag 发布：那样 Linux 冒烟失败时资产已经躺在 Release 上（3.16.3-ce.1.fix.1）。",
  );
});

test("发布点唯一：只有 publish-release 与 headless attach 会写该 Release 的资产", () => {
  const { workflow } = loadWorkflow();
  const publishers = Object.entries(workflow.jobs ?? {})
    .filter(([, job]) => (job.steps ?? []).some((step) => /gh release upload/u.test(stepRun(step))))
    .map(([name]) => name)
    .sort();
  assert.deepEqual(
    publishers,
    ["headless-server-package", "publish-release"],
    "安装包资产只能由 publish-release 发布：矩阵项各自上传会让 Windows/macOS 抢在 Linux 冒烟之前发布。",
  );
});

test("publish-release 依赖 build、只在 tag 构建执行，且能自建 Release", () => {
  const { workflow } = loadWorkflow();
  const publish = workflow.jobs?.["publish-release"];
  assert.ok(publish, "缺少 publish-release job：发布必须与构建分开，否则冒烟拦不住已发出的资产");
  assert.equal(publish.needs, "build", "publish-release 必须 needs: build（冒烟在 build job 里）");
  assert.match(
    String(publish.if ?? ""),
    /refs\/tags\//u,
    "publish-release 必须只在 tag 构建执行：workflow_dispatch 演练不得新建/修改 Release",
  );
  const source = JSON.stringify(publish);
  assert.match(source, /gh release create/u, "Release 不存在时必须先创建（首次发版）");
  assert.match(source, /--clobber/u, "重跑同一 tag 必须用 --clobber 覆盖，不能静默跳过");
  assert.doesNotMatch(
    source,
    /continue-on-error/u,
    "发布步骤禁止 continue-on-error：发布失败必须让 job 变红（这是交付终点）",
  );
});

test("在 publish-release 里下载全部平台的 artifact 后再上传", () => {
  const { workflow } = loadWorkflow();
  const steps = workflow.jobs?.["publish-release"]?.steps ?? [];
  const download = steps.find((step) =>
    String(step.uses ?? "").startsWith("actions/download-artifact"),
  );
  assert.ok(download, "publish-release 必须先从 workflow artifact 取回各平台安装包");
  assert.equal(
    download.with?.pattern,
    "zcode-ce-*",
    "要按 Upload installers 的 artifact 名前缀下载",
  );
  assert.equal(
    download.with?.["merge-multiple"],
    true,
    "四个 artifact 需合并到同一目录才能一次上传",
  );
  const uploadIndex = steps.findIndex((step) => /gh release upload/u.test(stepRun(step)));
  assert.ok(uploadIndex > steps.indexOf(download), "上传必须发生在下载之后");
});

test("依赖 Release 已存在的后续 job 都等 publish-release", () => {
  const { workflow } = loadWorkflow();
  for (const [jobName, why] of [
    ["release-notes", "正文写入需要一个已存在的 Release，而 Release 现在由 publish-release 创建"],
    ["headless-server-package", "无头包要挂到同一个 Release 上，抢在创建之前会 release not found"],
  ]) {
    assert.equal(
      workflow.jobs?.[jobName]?.needs,
      "publish-release",
      jobName + " 必须 needs: publish-release（" + why + "）",
    );
  }
});

test("Upload installers 仍是 if: always()（排障用 artifact，不是交付终点）", () => {
  const { workflow } = loadWorkflow();
  const upload = findStep(workflow.jobs?.build, "Upload installers");
  assert.equal(
    upload.if,
    "always()",
    "构建失败也要留下 artifact 便于排障；它不构成发布，所以保留 always()",
  );
});

test("矩阵并行：发布移出 build 后不再需要 max-parallel: 1", () => {
  const { workflow } = loadWorkflow();
  assert.equal(
    workflow.jobs?.build?.strategy?.["max-parallel"],
    undefined,
    "max-parallel: 1 的唯一理由是 electron-builder 在各矩阵项里并发创建 Release（422 already_exists）；" +
      "发布移到唯一的 publish-release 后该竞态不存在。若确需重新串行，请在此处写明新理由。",
  );
});

test("不再依赖 electron-publish 的上传时间保护", () => {
  const { source } = loadWorkflow();
  assert.doesNotMatch(
    source,
    /EP_GH_IGNORE_TIME/u,
    "EP_GH_IGNORE_TIME 只对 electron-publish 的 GitHub publisher 有意义；发布改走 gh release upload --clobber 后不再需要，残留会让读者以为构建期仍在发布。",
  );
});
