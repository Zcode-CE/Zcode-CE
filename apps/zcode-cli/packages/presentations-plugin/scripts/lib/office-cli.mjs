import { basename } from "node:path";
import process from "node:process";

// --- 来源与归属（改本文件前先读 docs/development/office-plugins.md） ---
// 归属:      ZCode-CE 自研（self）—— 不是 DSH 上游文件，不回写上游，不跟 DSH 发版
// 由来:      scripts/check_office.py（derived-from-dsh，MIT）的 Node 重写，按职责拆分。
// 本模块:    命令行解析、报告序列化与失败归一化
// 同名副本:  三份（documents/presentations/spreadsheets）必须逐字节相同，改一处同步三处
// 回归测试:  apps/zcode-cli/packages/documents-plugin/test/checkOffice.test.mjs
// ---------------------------------------------------------------------------

// ===== CLI（argparse 的兼容子集：位置参数 input，可选 --out / --contains / --count） =====

const PROGRAM = basename(process.argv[1] ?? "check_office.mjs");
const USAGE =
  "usage: " +
  PROGRAM +
  " [-h] [--out OUT] [--contains TEXT] [--count COUNT] input\n" +
  "\n" +
  "Read-only OOXML checks and structural summaries; no rendering or formula evaluation.\n" +
  "\n" +
  "positional arguments:\n" +
  "  input              path to the .docx, .pptx, or .xlsx file\n" +
  "\n" +
  "options:\n" +
  "  -h, --help         show this help message and exit\n" +
  "  --out OUT          write the JSON report to this path as well\n" +
  "  --contains TEXT    assert that the extracted text contains TEXT (repeatable)\n" +
  "  --count COUNT      expected slide or sheet count\n";

/** 与 argparse 一致：参数错误写 stderr、退出码 2。 */
function argumentError(message) {
  process.stderr.write(USAGE + "\n" + PROGRAM + ": error: " + message + "\n");
  process.exitCode = 2;
  return null;
}

function parseArguments(argv) {
  const parsed = { input: undefined, out: undefined, contains: [], count: undefined };
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "-h" || token === "--help") {
      process.stdout.write(USAGE);
      process.exitCode = 0;
      return null;
    }
    const separator = token.startsWith("--") ? token.indexOf("=") : -1;
    const flag = separator === -1 ? token : token.slice(0, separator);
    const inline = separator === -1 ? undefined : token.slice(separator + 1);
    if (flag === "--out" || flag === "--contains" || flag === "--count") {
      let value = inline;
      if (value === undefined) {
        index += 1;
        value = argv[index];
      }
      if (value === undefined) return argumentError("argument " + flag + ": expected one argument");
      if (flag === "--out") {
        parsed.out = value;
      } else if (flag === "--contains") {
        parsed.contains.push(value);
      } else {
        const normalized = value.trim();
        if (!/^[+-]?\d(?:_?\d)*$/.test(normalized)) {
          return argumentError("argument --count: invalid int value: '" + value + "'");
        }
        parsed.count = Number.parseInt(normalized.replace(/_/g, ""), 10);
      }
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      return argumentError("unrecognized arguments: " + token);
    }
    positionals.push(token);
  }
  if (positionals.length === 0) return argumentError("the following arguments are required: input");
  if (positionals.length > 1) {
    return argumentError("unrecognized arguments: " + positionals.slice(1).join(" "));
  }
  parsed.input = positionals[0];
  return parsed;
}

/** Return a non-empty detail so callers can always tell what failed. */
function failureDetail(error) {
  const message = String(error instanceof Error ? error.message : error).trim();
  if (message.length > 0) return message;
  const name = error instanceof Error && error.name ? error.name : "Error";
  return name + " while reading the package";
}

/** JSON 转义非 ASCII（同 json.dumps(ensure_ascii=True)），并保持 indent=2 的排版。 */
function toReportJson(report) {
  const body = JSON.stringify(report, null, 2).replace(/[\u0080-\uffff]/g, (char) => {
    return "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0");
  });
  return body + "\n";
}

/**
 * 是否转成结构化 fail 而不是让进程裸崩。
 *
 * .py 的 except 列表（OSError/ValueError/KeyError/RuntimeError/ParseError/BadZipFile/
 * zlib.error/MemoryError/OverflowError/RecursionError）在 JS 里对应的就是「一切 Error」：
 * JS 没有 Python 那种「未列出就逃逸」的分层，而调用方是 agent 子进程，
 * 「退出码 1 + 空 stdout + 裸堆栈」正是本次要消灭的失效形态（实测本文件曾因一个
 * ReferenceError 落到该形态）。所以这里一律收进结构化 fail —— 比 .py 更严，不会更松。
 */
function isExpectedFailure(error) {
  return error instanceof Error || typeof error === "object" || typeof error === "string";
}

export { PROGRAM };
export { USAGE };
export { argumentError };
export { failureDetail };
export { isExpectedFailure };
export { parseArguments };
export { toReportJson };
