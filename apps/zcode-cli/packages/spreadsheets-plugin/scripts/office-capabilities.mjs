#!/usr/bin/env node
// --- 来源与归属（改本文件前先读 docs/development/office-plugins.md） ---
// 归属:      ZCode-CE 自研（self）—— 不是 DSH 上游文件，不回写上游，不跟 DSH 发版
// 由来:      DSH 0.2.x 的 office-xlsx 技能把「先探测 recalculate 能力、不支持就如实声明」
//            变成了技能规则（上游有随包 LibreOffice Kit CLI）。CE 明确不搬引擎整包
//            （145–182 MiB/平台 + MPL-2.0 + Linux 仅 WASM），但保留「能力探测 + 如实声明」
//            的语义骨架，并给将来留出单一的引擎挂载点（见 ENGINE_RELATIVE_PATH）。
// 本模块:    能力探测 CLI —— 只回答「本构建能否重算公式」，不做任何重算。
// 契约:      stdout 一行 JSON（非 ASCII 转义，与 check_office.mjs 同口径）；
//            可选 --out <file>；退出码 0 = 探测完成（无论能力是否可用），2 = 参数错误，
//            1 = --out 写入失败。能力不可用不是错误：rc 永远不表达 availability。
// 同名副本:  无。recalculate 是 xlsx 专属能力，只随 spreadsheets-plugin 分发
//            （docx/pptx 不存在公式重算语义，不需要探测）。
// 回归测试:  apps/zcode-cli/packages/spreadsheets-plugin/test/officeE2eBlankRender.test.mjs
//            的 keyless 子测试（输出形状 + 不可用分支的 guidance）。
// ---------------------------------------------------------------------------
/**
 * Office capability probe (xlsx formula recalculation).
 *
 * The xlsx skill must not assume a recalculation engine exists. The model runs
 * this probe when the deliverable must contain calculated formula results, and
 * reports the limit honestly when the probe says the engine is unavailable.
 *
 * 为什么探测用文件存在性而不是「试跑一次引擎」：今天本构建没有引擎，任何「试用」的
 * 探测都是死代码。对着唯一登记的挂载点做路径检查，现在诚实，将来引擎落在那里时
 * 自动翻转，技能正文无需改动（不可用分支的声明义务由本脚本的 guidance 字段携带）。
 */

import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 将来重算引擎的唯一挂载点（相对插件根）。
 *
 * 今天不存在该文件 => available=false。若将来随包分发引擎（自研轻量 JS 求值或
 * 其它裁决），把它落在 scripts/office-node/recalculate.cjs 即可让探测翻转；
 * 技能正文里的不可用声明届时由 guidance 字段替换为可用分支的行为说明。
 */
const ENGINE_RELATIVE_PATH = "scripts/office-node/recalculate.cjs";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const UNAVAILABLE_RECALCULATE = Object.freeze({
  available: false,
  engine: null,
  limit:
    "This build ships no formula recalculation engine: the bundled library stores formulas and cached results but does not evaluate them.",
  guidance:
    "When the deliverable must contain calculated formula results, state in the final reply that cached results were not recalculated in this build and must be recalculated or verified in a spreadsheet application. Do not report cached values as newly calculated results and do not replace requested formulas with constants.",
});

const AVAILABLE_RECALCULATE = Object.freeze({
  available: true,
  engine: ENGINE_RELATIVE_PATH,
  limit: "",
  guidance:
    "Recalculate before delivery when calculated results are required, then reopen the output with the formula view and the cached-value view to verify both.",
});

function probeRecalculate() {
  return existsSync(join(pluginRoot, ENGINE_RELATIVE_PATH))
    ? AVAILABLE_RECALCULATE
    : UNAVAILABLE_RECALCULATE;
}

function buildReport() {
  return {
    format: "office-capabilities",
    plugin: "spreadsheets",
    capabilities: { recalculate: probeRecalculate() },
  };
}

/** 与 check_office.mjs 同口径：JSON.stringify 已转义非 ASCII，单行输出。 */
function serialize(report) {
  return JSON.stringify(report) + "\n";
}

function parseArgs(argv) {
  let outPath;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") {
      const next = argv[index + 1];
      if (typeof next !== "string" || next.length === 0) {
        throw new Error("--out requires a file path");
      }
      outPath = next;
      index += 1;
      continue;
    }
    throw new Error("Unknown argument: " + arg);
  }
  return { outPath };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      "Usage: office-capabilities.mjs [--out <file>]\n" +
        (error instanceof Error ? error.message : String(error)) + "\n",
    );
    return 2;
  }
  const text = serialize(buildReport());
  process.stdout.write(text);
  if (args.outPath === undefined) return 0;
  try {
    await writeFile(args.outPath, text, "utf8");
  } catch (error) {
    process.stderr.write(
      "Failed to write --out: " + (error instanceof Error ? error.message : String(error)) + "\n",
    );
    return 1;
  }
  return 0;
}

main().then((code) => {
  process.exitCode = code;
});
