import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

/**
 * Release 流水线 macOS 发布矩阵与上传清单的形状护栏（136-darwin-auto-update-skip §1.6）。
 *
 * 为什么需要它：darwin x64 + darwin arm64 是产品规则 —— 少一行矩阵，对应架构的 macOS 未签名
 * 安装包就从发布中**静默消失**：流水线照常全绿（build job 的 Upload installers 是
 * `if-no-files-found: warn`，缺产物只 warn 不红），而 README / release.md 仍写着
 * 「发布未签名 .dmg/.zip」。与 crossPlatformWorkflow.test.mjs / releaseWorkflowReleasePaths.test.mjs
 * 同构：判据从 workflow 现读（yaml.parse），不写第二份矩阵常量。
 *
 * 为什么不断言 publisher 顺序 / latest-mac.yml 的覆盖关系：两个 mac job 经各自的 electron-builder
 * publisher 顺序上传 latest-mac.yml（max-parallel: 1 下后跑者覆盖先跑者），这是 publisher 的既有
 * 行为，不是本项目的契约 —— pin「顺序」等于把偶发性质固化成规则，将来按 arch 拆分 yml 或改用
 * 统一发布步骤时会误红。该性质的**消费侧**已有护栏：darwin 打包客户端整体跳过更新检查
 * （packages/desktop/test/autoUpdaterDarwinSkip.test.ts 断言 checkForUpdates 调用数为 0），
 * 所以 latest-mac.yml 被覆盖对 CE 客户端无害；自建 feed / 未来启用 macOS 自动更新的场景
 * 见 136 spec §7。本护栏守不住的东西写在文件末尾。
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflowPath = resolve(repoRoot, ".github/workflows/release.yml");

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
        "。release.yml 是安装包发布的唯一流水线，删掉它等于把所有平台退回手工发布。",
    );
  }
  // 解析失败就失败，不静默跳过：语法坏的 workflow 在 GitHub 上不会报错，
  // 只会不运行（或整份文件被忽略），而那正是最难发现的一种失效（同 crossPlatformWorkflow）。
  return parse(source);
}

function buildMatrixInclude(workflow) {
  const job = workflow.jobs?.build;
  assert.ok(job, "release.yml 里没有 build job");
  const include = job.strategy?.matrix?.include;
  assert.ok(Array.isArray(include), "build 的 strategy.matrix.include 不是列表");
  return include;
}

test("build 矩阵覆盖 darwin x64 与 arm64 两个架构（每个恰好一行）", () => {
  const mac = buildMatrixInclude(loadWorkflow()).filter((entry) => entry?.platform === "mac");
  assert.deepEqual(
    mac.map((entry) => entry.arch).sort(),
    ["arm64", "x64"],
    "build 矩阵的 mac 条目必须恰好覆盖 x64 与 arm64 两个架构（现有：" +
      JSON.stringify(mac) +
      "）—— 少一个 = 该架构的 macOS 未签名安装包静默失去发布入口（136 §1.6）。",
  );
  for (const entry of mac) {
    // macos-13 runner 是 Intel（x64）；macos-14 起 runner 是 Apple Silicon（arm64）。
    // runner 与架构错配不会报错，只会让原生模块（node-pty 等）走跨架构构建路径。
    const expectedArch = entry.os === "macos-13" ? "x64" : entry.os === "macos-14" ? "arm64" : null;
    assert.ok(
      expectedArch !== null,
      "mac 条目用了未登记的 runner：" +
        JSON.stringify(entry.os) +
        "（当前登记的对应关系：macos-13→x64、macos-14→arm64；换 runner 架构时需同步本护栏）。",
    );
    assert.equal(
      entry.arch,
      expectedArch,
      entry.os + " 上应构建 " + expectedArch + "（矩阵声明的是 " + entry.arch + "）。",
    );
  }
});

test("Upload installers 的清单包含 macOS 产物（*.dmg / *.zip）", () => {
  const upload = loadWorkflow().jobs?.build?.steps?.find(
    (step) => step.name === "Upload installers",
  );
  assert.ok(upload, "build job 里没有 Upload installers 步骤");
  const path = upload.with?.path;
  assert.equal(typeof path, "string", "Upload installers 没有 path 清单");
  // 该步骤是 if-no-files-found: warn：清单里缺 macOS 产物只 warn 不红，
  // 不会自动提醒任何人文档与产物已经脱节。
  assert.ok(
    path.includes("packages/desktop/dist/*.dmg") && path.includes("packages/desktop/dist/*.zip"),
    "Upload installers 的清单缺少 macOS 产物（*.dmg / *.zip）：" + JSON.stringify(path),
  );
});

/**
 * 本护栏守不住的东西（如实登记，别把它当发布正确性的证明）：
 * 1. 它断言的是 workflow 的**声明形状**，不是「mac job 在 GitHub runner 上真能构建 / 签名 / 打包」。
 *    ad-hoc 签名（identity: "-"）路径与本机的 dmg 产物只能在 ce.2 发版时由 CI mac job 验证（136 §7）。
 * 2. 它不判产物名规则（ZCode-CE-<版本>-darwin-<arch>.dmg）：产物名由 electron-builder.config.js
 *    的 mac.artifactName 决定，与 workflow 无关。
 * 3. 它不判 latest-mac.yml 的上传与覆盖关系（见文件头说明）。
 */
