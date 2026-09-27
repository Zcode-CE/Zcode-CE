#!/usr/bin/env node
/**
 * 许可清单新鲜度检查（平台无关）。
 *
 * ## 为什么单独成脚本
 *
 * `node scripts/licenses.mjs check` 会做两件事：**材料档位判定**（扫平台包集合，CI 上会因
 * 平台差异误报 —— 这是 `ci.yml` 刻意不跑它的理由）与**清单新鲜度检查**（比对
 * `third-party/inventory.json` 里登记的输入哈希）。
 *
 * 后者**完全平台无关**：它只读工作区文件算 sha256。把它和前者绑在一起，等于让
 * "CI 不跑"这条理由顺带把新鲜度也一起豁免了 —— 而新鲜度恰恰是最容易静默失效的一环。
 *
 * ## 为什么必须有这条护栏（三次实测事故）
 *
 * 规则本身早就写在 `docs/operations/release.md`：「改版本号必须与重生成通知放进同一个提交」。
 * 但它在同一个版本周期里被**违反了三次**：
 *
 * | 提交 | 违反方式 |
 * | --- | --- |
 * | `8b3e459`（fix.1） | 只改 `package.json` 的 version 一行，未重生成 |
 * | `6d754dc`（fix.2） | 同上 |
 * | `633f3a0` | 改了插件 skill roots 内的一个测试文件，未重生成 |
 *
 * 第三次尤其说明问题：作者（Lead）**刚修完前两次**，仍因为"我改的是注释、与依赖无关"这个
 * **不可执行的判据**而跳过检查。正确判据是「**我改的文件是否落在 `inventory.inputs` 里**」——
 * 一个可以用一条命令回答的问题。本脚本就是那条命令。
 *
 * ## 覆盖范围（比"依赖清单"宽得多）
 *
 * `inputs` 登记 **2991** 个文件的 sha256，含：根 `package.json`、`pnpm-lock.yaml`、
 * `pnpm-workspace.yaml`、各 workspace 的 `package.json`，以及**插件 skill roots 内的
 * 技能正文与测试文件**。所以"我只改了注释/Markdown/测试"**不构成**跳过它的理由。
 *
 * 用法：
 *   node scripts/check-licenses-freshness.mjs          # 检查，红则 exit 1
 *   node scripts/check-licenses-freshness.mjs --quiet  # 只输出结论行
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const quiet = process.argv.includes("--quiet");

/** 与 `scripts/third-party-notices.mjs` 的 `readVerifiedNotices` 同一口径：
 *  文本输入按 LF 归一化后取 sha256（容忍 Windows checkout 的 CRLF）。 */
const hashText = (text) => createHash("sha256").update(text).digest("hex");

function main() {
  const manifest = JSON.parse(readFileSync(resolve(root, "third-party/inventory.json"), "utf8"));
  if (manifest.schemaVersion !== 1) {
    console.error("✗ 不支持的 third-party inventory 版本");
    process.exit(1);
  }

  const drifted = [];
  let checked = 0;
  for (const [file, expected] of Object.entries(manifest.inputs)) {
    let text;
    try {
      text = readFileSync(resolve(root, file), "utf8");
    } catch {
      // 文件缺失也交给 licenses.mjs 的完整检查报（那里有更准确的文案）；
      // 本脚本只负责"哈希漂移"这一环。
      continue;
    }
    checked += 1;
    if (hashText(text.replaceAll("\r\n", "\n")) !== expected) drifted.push(file);
  }

  if (drifted.length === 0) {
    if (!quiet) console.log(`✓ 许可清单新鲜：${checked} 个登记输入与 inventory 一致`);
    return;
  }

  console.error(`✗ 许可清单已过期：${drifted.length} / ${checked} 个登记输入的哈希不匹配`);
  for (const file of drifted) console.error(`    ${file}`);
  console.error(
    [
      "",
      "怎么修：",
      "  node scripts/licenses.mjs notices",
      "",
      "然后**把重生成的 third-party/inventory.json 与本次改动放进同一个提交**。",
      "不要单独提交清单、也不要等到发布前才补 —— 这条规则在本轮被违反了三次",
      "（8b3e459 / 6d754dc / 633f3a0），每次都是「以为与依赖无关」这个不可执行的判据造成的。",
      "判据是：**你改的文件是否落在 third-party/inventory.json 的 inputs 里**。",
    ].join("\n"),
  );
  process.exit(1);
}

main();
