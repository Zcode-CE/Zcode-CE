#!/usr/bin/env node
// --- 来源与归属 ---
// 归属:      ZCode-CE 自研（self）。无上游来源，不回写任何上游。
// 由来:      把 .reverse/38-pdf/PDF-SPEC.md §2.3 的生成器契约落地：声明式 JSON → PDF，
//            并且**自带校验闸门**（渲染到临时文件 → check_pdf.mjs 断言 → 通过才 rename）。
// 本模块:    命令行 + 编排（字体解析 → 渲染 → 校验 → 原子落地）；布局在 lib/pdf-render.mjs。
// 契约:      stdout 恒为一行 JSON（成功与失败都是），退出码 0=已产出 / 1=失败（未产出任何文件）/ 2=参数错误。
//            **失败关闭**：字体缺字形、载荷缺失、校验不过，一律不产出交付文件。
// 依赖:      scripts/pdf-node/{pdfkit,fontkit}.cjs（打包链 stage）、pdf-fonts.mjs、check_pdf.mjs。
// ---------------------------------------------------------------------------
/**
 * Read-only 结构校验 + 失败关闭的 PDF 生成器。
 *
 * 为什么"渲染到临时文件再校验"而不是直接写目标：PDFKit 有两类**不会报错**的坏产物 ——
 * ①字体缺字形时画成 .notdef（豆腐），②页脚越界时静默加页（2 页变 4 页）。因此生成器自己走一遍
 * check_pdf.mjs 的断言（页数、字体嵌入、文本层字形覆盖），只有全过才把文件挪到用户要的路径。
 *
 * 为什么校验是**两层**：渲染器内部对"页脚是否新增页"做断言（拦在自己的实现里），
 * 产物再用 check_pdf 从结构层复核（打到最终消费点）—— 只做前者会漏掉"我们以为写对了"的情况。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { findMissingGlyphs, fontInstallHints, resolveFaceFromFile, resolveFontFace } from "./pdf-fonts.mjs";
import { collectDocumentText, normalizeModel, PdfBuildError, renderPdf } from "./lib/pdf-render.mjs";

const PROGRAM = basename(process.argv[1] ?? "pdf-build.mjs");
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CHECKER = join(SCRIPT_DIR, "check_pdf.mjs");
const PAYLOAD = join(SCRIPT_DIR, "pdf-node", "pdfkit.cjs");
const require = createRequire(import.meta.url);

const USAGE = [
  "usage: " + PROGRAM + " -h | --in MODEL.json --out OUT.pdf [选项]",
  "",
  "从声明式 JSON 生成 PDF（中文正文 / 表格 / 页码），生成前做字形覆盖检查、生成后跑结构校验；",
  "任何一步不过都不产出交付文件（失败关闭）。",
  "",
  "必填:",
  "  --in MODEL.json     文档模型（blocks/page/style/footer/info/font）",
  "  --out OUT.pdf       目标路径（先写 OUT.pdf.tmp.pdf，校验通过才 rename）",
  "",
  "字体（默认自动发现系统字体；两者都只作用于本次生成）:",
  "  --font-file PATH    正文/默认字体文件（.ttf/.ttc/.otf）",
  "  --font-face NAME    该文件里的 PostScript 面名（.ttc 集合必填，否则自动挑一个覆盖正文的面）",
  "  --bold-font-file PATH / --bold-face NAME   标题与表头字体（缺省自动找粗体面；找不到则如实声明回退）",
  "",
  "其它:",
  "  --keep-temp         校验失败时保留临时文件供排查（默认删除）",
  "  -h, --help          显示本帮助",
].join("\n");

class ArgumentError extends Error {}

function argumentError(message) {
  process.stderr.write(USAGE + "\n" + PROGRAM + ": error: " + message + "\n");
  process.exitCode = 2;
  return null;
}

function parseArguments(argv) {
  const parsed = { keepTemp: false };
  const flags = new Set([
    "--in", "--out", "--font-file", "--font-face", "--bold-font-file", "--bold-face",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "-h" || token === "--help") {
      process.stdout.write(USAGE + "\n");
      return null;
    }
    if (token === "--keep-temp") {
      parsed.keepTemp = true;
      continue;
    }
    const separator = token.startsWith("--") ? token.indexOf("=") : -1;
    const flag = separator === -1 ? token : token.slice(0, separator);
    const inline = separator === -1 ? undefined : token.slice(separator + 1);
    if (!flags.has(flag)) return argumentError("unrecognized arguments: " + token);
    let value = inline;
    if (value === undefined) {
      index += 1;
      value = argv[index];
    }
    if (value === undefined) return argumentError("argument " + flag + ": expected one argument");
    if (flag === "--in") parsed.input = value;
    else if (flag === "--out") parsed.output = value;
    else if (flag === "--font-file") parsed.fontFile = value;
    else if (flag === "--font-face") parsed.fontFace = value;
    else if (flag === "--bold-font-file") parsed.boldFontFile = value;
    else parsed.boldFace = value;
  }
  if (parsed.input === undefined) return argumentError("the following arguments are required: --in");
  if (parsed.output === undefined) return argumentError("the following arguments are required: --out");
  return parsed;
}

/** 成功与失败都只输出一行 JSON —— 调用方（模型）不需要解析自由文本。 */
function emit(payload, exitCode) {
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  process.exitCode = exitCode;
}

function resolveBodyFont(options, text) {
  if (options.fontFile) {
    return resolveFaceFromFile(resolve(options.fontFile), text, { preferName: options.fontFace });
  }
  return resolveFontFace(text, { role: "sans" });
}

function resolveBoldFont(options, text, body) {
  if (options.boldFontFile) {
    return resolveFaceFromFile(resolve(options.boldFontFile), text, { preferName: options.boldFace });
  }
  const bold = resolveFontFace(text, { role: "bold" });
  // 没有任何覆盖全部码点的粗体面时，退回正文面并**如实声明**（合成粗体不在 PDFKit 能力内）。
  if (bold.file === null) return { ...body, boldFallback: true };
  return bold;
}

function reportMissing(role, face, text) {
  return {
    ok: false,
    stage: "font",
    reason:
      role + " 字体不覆盖文档中的全部字符：本机没有可用的" +
      (role === "bold" ? "粗体" : "中文字体") + "面",
    missingCharacters: face.missing,
    missingCount: face.missing.length,
    documentCodePoints: [...new Set([...text].map((char) => char.codePointAt(0)))].length,
    installHints: fontInstallHints(),
    guidance:
      "不要用拉丁字体继续、不要缩小文档内容来凑合；请安装上面的字体包后重跑，或先用 Word/WPS 等已有软件交付。",
  };
}

function runChecker(args) {
  try {
    const stdout = execFileSync("node", [CHECKER, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { exitCode: 0, report: JSON.parse(stdout) };
  } catch (error) {
    const stdout = error.stdout ?? "";
    let report = null;
    try {
      report = stdout.trim() === "" ? null : JSON.parse(stdout);
    } catch {
      report = null;
    }
    return { exitCode: error.status ?? 1, report, stderr: String(error.stderr ?? "").slice(0, 800) };
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options === null) return;
  if (!existsSync(options.input)) return void argumentError("no such file: " + options.input);
  if (!existsSync(dirname(resolve(options.output)))) {
    return void argumentError("output directory does not exist: " + dirname(resolve(options.output)));
  }
  if (!existsSync(PAYLOAD)) {
    emit(
      {
        ok: false,
        stage: "payload",
        reason: "PDF payload is missing: " + PAYLOAD,
        guidance:
          "插件不完整（载荷未 stage）。这是构建缺陷，不是缺依赖 —— 不要 npm/pnpm install，把这条报告给用户/维护者。",
      },
      1,
    );
    return;
  }

  let model;
  try {
    model = normalizeModel(JSON.parse(readFileSync(options.input, "utf8")));
  } catch (error) {
    emit({ ok: false, stage: "model", reason: error instanceof Error ? error.message : String(error) }, 1);
    return;
  }

  const text = collectDocumentText(model);
  let body;
  let bold;
  try {
    body = resolveBodyFont(options, text);
    bold = resolveBoldFont(options, text, body);
  } catch (error) {
    emit(
      {
        ok: false,
        stage: "font",
        reason: error instanceof Error ? error.message : String(error),
        guidance: "指定的字体文件/面名不可用；请检查 --font-file/--font-face，或去掉它们改用系统字体自动发现。",
      },
      1,
    );
    return;
  }
  if (body.missing?.length > 0) return void emit(reportMissing("body", body, text), 1);
  if (bold.missing?.length > 0) return void emit(reportMissing("bold", bold, text), 1);
  // 渲染前再复核一次覆盖（用户指定面名的路径不会经过 resolveFontFace 的过滤）。
  const missingAfter = [
    ...findMissingGlyphs({ file: body.file, postscriptName: body.postscriptName, text }),
    ...findMissingGlyphs({ file: bold.file, postscriptName: bold.postscriptName, text }),
  ];
  if (missingAfter.length > 0) {
    return void emit({ ...reportMissing("body", { missing: [...new Set(missingAfter)] }, text) }, 1);
  }

  const outputPath = resolve(options.output);
  const tempPath = outputPath + ".tmp.pdf";
  rmSync(tempPath, { force: true });
  let rendered;
  try {
    const loaded = require(PAYLOAD);
    // podfkit 的 CJS 产物把构造器本身作为 module.exports；同时兼容 { PDFDocument } / { default } 形状。
    // 三种都不是 ⇒ 载荷损坏或选错入口，必须响亮失败（否则会以"渲染失败"这种模糊信息暴露）。
    const PDFDocument =
      typeof loaded === "function"
        ? loaded
        : (loaded?.PDFDocument ?? loaded?.default?.PDFDocument ?? loaded?.default);
    if (typeof PDFDocument !== "function") {
      throw new PdfBuildError(
        "PDF payload does not expose PDFDocument (wrong bundle entry or corrupted payload: " + PAYLOAD + ")",
      );
    }
    rendered = await renderPdf({
      PDFDocument,
      fontFiles: { body: body.file, bold: bold.file },
      fonts: { body: body.postscriptName, bold: bold.postscriptName },
      model,
      outPath: tempPath,
    });
  } catch (error) {
    rmSync(tempPath, { force: true });
    emit(
      {
        ok: false,
        stage: "render",
        reason: error instanceof PdfBuildError ? error.message : "渲染失败：" + String(error instanceof Error ? error.message : error),
      },
      1,
    );
    return;
  }

  // 校验：把源文本写成临时文件交给 --text，让"哪些字没画出来"变成结构化失败。
  const scratch = mkdtempSync(join(tmpdir(), "pdf-build-verify-"));
  const textPath = join(scratch, "source.txt");
  writeFileSync(textPath, text);
  const checkerArgs = [tempPath, "--count", String(rendered.pages), "--text", textPath];
  if (["A4", "A3", "Letter"].includes(model.pageSize)) checkerArgs.push("--size", model.pageSize);
  const verified = runChecker(checkerArgs);
  rmSync(scratch, { force: true, recursive: true });

  const report = verified.report;
  if (verified.exitCode !== 0 || report?.verdict !== "pass") {
    if (!options.keepTemp) unlinkSync(tempPath);
    emit(
      {
        ok: false,
        stage: "verify",
        reason: "生成物未通过结构校验，已删除临时文件（未产出交付文件）",
        failingChecks: (report?.checks ?? []).filter((check) => check.status === "fail"),
        checkerExitCode: verified.exitCode,
        checkerReport: report,
        ...(options.keepTemp ? { keptTempPath: tempPath } : {}),
      },
      1,
    );
    return;
  }

  renameSync(tempPath, outputPath);
  emit(
    {
      ok: true,
      out: outputPath,
      bytes: rendered.bytes,
      pages: rendered.pages,
      fonts: {
        body: body.postscriptName + " (" + body.file + ")",
        bold: bold.postscriptName + " (" + bold.file + ")",
        boldFallback: bold.boldFallback === true,
      },
      verify: {
        verdict: report.verdict,
        checks: report.checks.map((check) => check.id + ":" + check.status),
        visualCheck: report.summary?.visualCheck ?? "not_performed",
      },
      ...(bold.boldFallback === true
        ? { degradation: "本机没有可用的中文粗体面：标题与表头使用正文字体，未做加粗（如实声明，不是静默降级）" }
        : {}),
    },
    0,
  );
}

try {
  await main();
} catch (error) {
  // 任何未预期失败也输出结构化 JSON：调用方是 agent，"退出码 1 + 空 stdout" 不可接受。
  emit(
    {
      ok: false,
      stage: "unexpected",
      reason: error instanceof Error ? error.message || error.name : String(error),
    },
    1,
  );
}
