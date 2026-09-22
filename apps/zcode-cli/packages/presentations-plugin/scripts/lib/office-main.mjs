import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";

import { MAIN_PARTS, suffixOf } from "./office-spec.mjs";

/**
 * 解析成真实路径用于比较，**跟随符号链接**；目标不存在时回退到 path.resolve()。
 *
 * 为什么不能只用 resolve()：它只做路径规范化。若 --out 是一个指向输入文档的软链，
 * 两者字符串不同却被判为「不同文件」，写入会**穿透软链覆盖输入文档**（安全审计 P1）。
 * .py 版用 Path.resolve() 跟随软链，这里对齐。
 */
function realpathOrResolve(target) {
  try {
    return realpathSync(target);
  } catch {
    // --out 通常指向尚不存在的新文件 ⇒ ENOENT 属正常路径
    return resolve(target);
  }
}
import { inspect } from "./office-parts.mjs";
import {
  argumentError,
  failureDetail,
  isExpectedFailure,
  parseArguments,
  toReportJson,
} from "./office-cli.mjs";

// --- 来源与归属（改本文件前先读 docs/development/office-plugins.md） ---
// 归属:      ZCode-CE 自研（self）—— 不是 DSH 上游文件，不回写上游，不跟 DSH 发版
// 由来:      scripts/check_office.py（derived-from-dsh，MIT）的 Node 重写，按职责拆分。
// 本模块:    入口流程（inspect → checks → 退出码）
// 同名副本:  三份（documents/presentations/spreadsheets）必须逐字节相同，改一处同步三处
// 回归测试:  apps/zcode-cli/packages/documents-plugin/test/checkOffice.test.mjs
// ---------------------------------------------------------------------------

async function runCheckOffice() {
  const args = parseArguments(process.argv.slice(2));
  if (args === null) return process.exitCode ?? 2;
  const suffix = suffixOf(args.input).toLowerCase();
  if (MAIN_PARTS[suffix] === undefined) {
    argumentError(
      "input must be .docx, .pptx, or .xlsx; converting the filename does not convert its contents",
    );
    return 2;
  }
  if (args.count !== undefined && (args.count < 0 || suffix === ".docx")) {
    argumentError("--count must be non-negative and applies only to slides or sheets");
    return 2;
  }
  // 必须**跟随软链**再比较：path.resolve() 只做路径规范化，不解析符号链接，
  // 于是 `ln -sf target.docx link.json` 后 `--out link.json` 会被判为「与输入不同」，
  // 实际写穿软链覆盖掉输入文档（安全审计 P1 实测：target.docx 从 864 B 变成 199 B）。
  // .py 版用 Path.resolve()（跟随软链）能正确拦下，这里对齐其语义。
  // realpathSync 在目标不存在时抛 ENOENT（--out 通常指向新文件）⇒ 回退到 resolve()。
  if (args.out !== undefined && realpathOrResolve(args.out) === realpathOrResolve(args.input)) {
    argumentError("--out must differ from the input document");
    return 2;
  }
  const checks = [];
  let summary = {};
  try {
    const result = await inspect(args.input);
    summary = result.summary;
    checks.push({ id: "package", status: "pass" });
    for (const required of args.contains) {
      checks.push({
        id: "contains",
        status: result.text.includes(required) ? "pass" : "fail",
        text: required,
      });
    }
    if (args.count !== undefined) {
      const actual = summary.slides !== undefined ? summary.slides : (summary.sheets ?? []).length;
      checks.push({
        id: "count",
        status: actual === args.count ? "pass" : "fail",
        expected: args.count,
        actual,
      });
    }
  } catch (error) {
    // 内存类失败（ERR_BUFFER_TOO_LARGE / RangeError 等）一并收进结构化 fail：本脚本跑在
    // agent 子进程里，任何输入都不允许以「裸堆栈 + 空 stdout」的形式失败。
    if (!isExpectedFailure(error)) throw error;
    checks.push({ id: "package", status: "fail", detail: failureDetail(error) });
  }
  let failed = checks.some((check) => check.status === "fail");
  const report = { format: suffix.slice(1), verdict: failed ? "fail" : "pass", checks, summary };
  let output = toReportJson(report);
  if (args.out !== undefined) {
    try {
      mkdirSync(dirname(args.out), { recursive: true });
      writeFileSync(args.out, output, "utf8");
    } catch (error) {
      failed = true;
      report.verdict = "fail";
      checks.push({ id: "output", status: "fail", detail: failureDetail(error) });
      output = toReportJson(report);
    }
  }
  process.stdout.write(output);
  return failed ? 1 : 0;
}

export { runCheckOffice };
