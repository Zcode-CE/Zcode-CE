#!/usr/bin/env node
// --- 来源与归属 ---
// 归属:      ZCode-CE 自研（self）—— 无上游来源，不回写任何上游，不跟任何上游发版
// 同型参照:  apps/zcode-cli/packages/documents-plugin/scripts/check_office.mjs（OFFICE-5 的 Node 校验器）
// 对外契约:  stdout JSON {format, verdict, checks[], summary}；退出码 0=通过 / 1=检查失败 / 2=参数错误；
//            --out PATH 同时写盘；非 ASCII 转义为 \\uXXXX（与 check_office 的 json.dumps(ensure_ascii=True) 口径一致）
// 本模块:    只读 PDF 结构检查 + 文本层断言；**不做视觉检查**，未做时必须如实声明（见 summary.visualCheck）
// 约束:      零第三方依赖（只用 node:fs / node:zlib / node:path / node:process）；
//            输入视为不可信：流解压有界，失败一律结构化 fail，不允许「退出码 1 + 空 stdout」
// ---------------------------------------------------------------------------
/**
 * Read-only PDF structural checks. No rendering, no visual inspection.
 *
 * Run with INPUT.pdf. Optional assertions: --count N (expected page count), --contains TEXT
 * (repeatable; assert the text layer contains TEXT), --text FILE (assert every distinct
 * non-ASCII code point of FILE is present in the document text layer), --size A4 (page size),
 * --require-visual (fail when the visual check was not performed).
 *
 * 为什么这些检查：PDF 的三个静默失效形态 —— ①页数被库静默加页（页脚写在可写区之下，
 * 实测 2 页文档变 4 页，且每页都有页码，「看着对」）；②字体未嵌入（换机器就变字体）；
 * ③字形缺失或整段丢字（豆腐块 / 空段）。三者都是「视觉上也许看不出来，但交付物已经错了」，
 * 因此由结构检查与文本层断言承担，而不是靠渲染截图。
 */
import { existsSync, writeFileSync } from "node:fs";
import { basename, extname } from "node:path";
import process from "node:process";
import { PAGE_SIZES, checkPdf } from "./lib/pdf-checks.mjs";

const PROGRAM = basename(process.argv[1] ?? "check_pdf.mjs");
const USAGE = `usage: ${PROGRAM} [-h] [--out OUT] [--count COUNT] [--contains TEXT] [--text FILE] [--size A4|Letter|A3] [--require-visual] input

Read-only PDF structural checks and text-layer assertions; no rendering or visual inspection.

positional arguments:
  input                path to the .pdf file

options:
  -h, --help           show this help message and exit
  --out OUT            write the JSON report to this path as well
  --count COUNT        expected page count
  --contains TEXT      assert that the text layer contains TEXT (repeatable)
  --text FILE          assert every distinct non-ASCII code point of FILE is present in the text layer
  --size A4|Letter|A3  expected page size
  --require-visual     fail when the visual check was not performed
`;

// ===== CLI =====

function argumentError(message) {
  process.stderr.write(USAGE + "\n" + PROGRAM + ": error: " + message + "\n");
  process.exitCode = 2;
  return null;
}

function parseArguments(argv) {
  const parsed = {
    input: undefined,
    out: undefined,
    count: undefined,
    contains: [],
    textFile: undefined,
    size: undefined,
    requireVisual: false,
  };
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "-h" || token === "--help") {
      process.stdout.write(USAGE);
      return null;
    }
    if (token === "--require-visual") {
      parsed.requireVisual = true;
      continue;
    }
    const separator = token.startsWith("--") ? token.indexOf("=") : -1;
    const flag = separator === -1 ? token : token.slice(0, separator);
    const inline = separator === -1 ? undefined : token.slice(separator + 1);
    if (["--out", "--count", "--contains", "--text", "--size"].includes(flag)) {
      let value = inline;
      if (value === undefined) {
        index += 1;
        value = argv[index];
      }
      if (value === undefined) return argumentError("argument " + flag + ": expected one argument");
      if (flag === "--out") parsed.out = value;
      else if (flag === "--count") {
        if (!/^\d+$/.test(value.trim()))
          return argumentError("argument --count: invalid int value: '" + value + "'");
        parsed.count = Number.parseInt(value.trim(), 10);
      } else if (flag === "--contains") parsed.contains.push(value);
      else if (flag === "--text") parsed.textFile = value;
      else {
        const size = value.trim().toUpperCase();
        if (!Object.hasOwn(PAGE_SIZES, size))
          return argumentError(
            "argument --size: expected one of " + Object.keys(PAGE_SIZES).join(", "),
          );
        parsed.size = size;
      }
      continue;
    }
    if (token.startsWith("-") && token !== "-")
      return argumentError("unrecognized arguments: " + token);
    positionals.push(token);
  }
  if (positionals.length === 0) return argumentError("the following arguments are required: input");
  if (positionals.length > 1)
    return argumentError("unrecognized arguments: " + positionals.slice(1).join(" "));
  parsed.input = positionals[0];
  return parsed;
}

/** JSON 转义非 ASCII，与 check_office 的 ensure_ascii 口径一致。 */
function toReportJson(report) {
  return (
    JSON.stringify(report, null, 2).replace(
      /[\u0080-\uffff]/g,
      (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"),
    ) + "\n"
  );
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options === null) return;
  if (extname(options.input).toLowerCase() !== ".pdf")
    return void argumentError("input must be a .pdf file");
  if (!existsSync(options.input)) return void argumentError("no such file: " + options.input);
  try {
    const { report, failed } = checkPdf(options.input, options);
    const json = toReportJson(report);
    process.stdout.write(json);
    if (options.out) writeFileSync(options.out, json);
    process.exitCode = failed ? 1 : 0;
  } catch (error) {
    // 任何未预期失败也必须产出结构化 fail 与非空 detail（不允许「退出码 1 + 空 stdout」）
    const detail =
      (error instanceof Error && error.message.trim()) || "unknown failure while checking the PDF";
    process.stdout.write(
      toReportJson({
        format: "pdf",
        verdict: "fail",
        checks: [{ id: "package", status: "fail", detail }],
        summary: {
          pages: 0,
          fonts: [],
          contentChars: 0,
          visualCheck: "not_performed",
          visualCheckReason: detail,
        },
      }),
    );
    process.exitCode = 1;
  }
}

await main();
