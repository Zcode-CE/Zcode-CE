#!/usr/bin/env node
/**
 * 提交前护栏：本次暂存的文件若落在许可清单的登记输入内，则要求清单已同批重生成。
 *
 * ## 为什么是 pre-commit 而不是 pre-push
 *
 * 「改动必须与重生成 notices 同批提交」这条规则在同一个版本周期里被违反了**四次**：
 *
 * | # | 提交 | 违反方式 |
 * | --- | --- | --- |
 * | 1 | `8b3e459`（fix.1） | 只改 `package.json` 的 version 一行 |
 * | 2 | `6d754dc`（fix.2） | 同上 |
 * | 3 | `633f3a0` | 改了插件 skill roots 内的一个测试文件 |
 * | 4 | `2e28efc` | 改 `package.json`（加一个脚本别名） |
 *
 * 第四次尤其说明问题：`2e28efc` **就是加"防复发护栏"的那个提交** ——
 * 它把新鲜度检查接进了 `verify:pre-push`，然后自己违反了它要防的那条规则。
 *
 * **原因不是"忘了跑"，而是装错了位置**：`git commit` **不触发** `pre-push`，
 * 而本仓只有 `pre-push` 钩子。护栏装在"推代码"这一步，事故发生在"写提交"这一步 ——
 * 装错位置等于没装。
 *
 * ## 判据（与"我觉得无关"相反：一条命令能回答的问题）
 *
 * 只判定**本次暂存的文件**：
 *   staged ∩ `third-party/inventory.json` 的 `inputs` ≠ ∅
 *   ⇒ 要求 `third-party/inventory.json` **也在本次暂存里**（即已同批重生成）。
 *
 * 这比"跑一遍完整新鲜度检查"更准确：它不关心工作区里别人的未提交改动，
 * 只问"**你这次要提交的东西，是不是自洽的**"。
 *
 * ## 为什么不直接报"清单过期"
 *
 * 因为工作区可能有别人的未提交改动（本仓是多 agent 并行），直接比对全量哈希会误报。
 * 本脚本**只看暂存集**，因此**不受他人工作区状态影响** —— 这是它能在多 agent 环境里工作的关键。
 *
 * 逃生阀：`SKIP_LICENSES_INPUTS_CHECK=1 git commit ...`（仅用于确认过无义务的场景）。
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const INVENTORY = "third-party/inventory.json";

if (process.env.SKIP_LICENSES_INPUTS_CHECK === "1") {
  console.log("⚠ 已按 SKIP_LICENSES_INPUTS_CHECK=1 跳过许可输入检查");
  process.exit(0);
}

const root = resolve(import.meta.dirname, "..");

/** 暂存文件名列表（`--diff-filter=d` 排除本次删除的文件）。 */
function stagedFiles() {
  const out = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=d"], {
    cwd: root,
    encoding: "utf8",
  });
  return out.split("\n").filter(Boolean);
}

function main() {
  let inputs;
  try {
    inputs = JSON.parse(readFileSync(resolve(root, INVENTORY), "utf8")).inputs ?? {};
  } catch {
    // 清单缺失不该由本钩子报（licenses.mjs 有更准确的文案）。
    process.exit(0);
  }

  const staged = stagedFiles();
  const touchedInputs = staged.filter((f) => f in inputs);
  if (touchedInputs.length === 0) return; // 本次提交不碰任何登记输入 ⇒ 无需重生成

  if (staged.includes(INVENTORY)) {
    console.log(
      `✓ 本次提交触及 ${touchedInputs.length} 个许可登记输入，且 ${INVENTORY} 已同批暂存`,
    );
    return;
  }

  console.error(
    [
      `✗ 本次提交触及 ${touchedInputs.length} 个许可登记输入，但 ${INVENTORY} 未同批暂存：`,
      ...touchedInputs.map((f) => `    ${f}`),
      "",
      "怎么修：",
      "  node scripts/licenses.mjs notices",
      `  git add ${INVENTORY}`,
      "",
      "为什么：inventory.inputs 登记了 2991 个文件的 sha256（含根 package.json、pnpm-lock.yaml、",
      "各 workspace 的 package.json，以及插件 skill roots 内的技能正文与测试文件）。",
      "改了其中任何一个而不重生成清单，许可门禁就会立刻变红 ——",
      "这条规则在本轮被违反了四次（8b3e459 / 6d754dc / 633f3a0 / 2e28efc）。",
      "四次里三次由队友发现 —— 自检不可靠时，交叉复核是唯一有效的兜底。",
      "",
      "判据是「你改的文件是否落在 inventory.inputs 里」，不是「你觉得与依赖有没有关系」。",
      "",
      "确认无义务时可逃生：SKIP_LICENSES_INPUTS_CHECK=1 git commit ...",
    ].join("\n"),
  );
  process.exit(1);
}

main();
// probe
