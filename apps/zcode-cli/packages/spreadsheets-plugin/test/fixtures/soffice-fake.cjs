#!/usr/bin/env node
// e2e 夹具：PATH 注入的假 soffice（空白渲染注入）。只被测试复制到临时工作区的 bin/ 下，
// 不是插件的运行时资产（seed 顶层白名单不含 test/，它不会进用户缓存）。
//
// 只实现 CE xlsx 技能两步链里用到的两种形态：
//   soffice --version
//   soffice --headless --convert-to pdf --outdir <dir> <file>
// 行为：--convert-to pdf 时在 <dir>/<stem>.pdf 写一份「无内容流的一页 PDF」——
// 任何真实渲染器（含真实 poppler）都把它渲成空白页，这正是被测的故障形态；
// 不报错、不「拒绝渲染」，否则模型会走「渲染器缺失」的另一条诚实分支，偏离场景。
// 每次调用追加一行 JSON 到同目录 calls.jsonl，供测试断言「首次空白之后不再渲染」。

const fs = require("node:fs");
const path = require("node:path");

const argv = process.argv.slice(2);
const logPath = path.join(__dirname, "calls.jsonl");

function log(entry) {
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
}

function fail(error) {
  const message = error && error.message ? error.message : String(error);
  log({ tool: "soffice", argv, status: 1, error: message });
  process.stderr.write(message + "\n");
  process.exit(1);
}

/**
 * 一页、无内容流的最小 PDF；xref 偏移逐字节构造，真实 poppler 也能解析。
 */
function minimalBlankPdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += index + 1 + " 0 obj\n" + object + "\nendobj\n";
  });
  const xrefOffset = body.length;
  body += "xref\n0 4\n0000000000 65535 f \n";
  offsets.forEach((offset) => {
    body += String(offset).padStart(10, "0") + " 00000 n \n";
  });
  body += "trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n" + xrefOffset + "\n%%EOF\n";
  return Buffer.from(body, "latin1");
}

function valueOf(flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const next = argv[index + 1];
  return typeof next === "string" && next.length > 0 ? next : undefined;
}

try {
  if (argv.includes("--version")) {
    process.stdout.write("LibreOffice 24.8.0.0 (e2e fixture: converts to blank-page PDFs)\n");
    log({ tool: "soffice", argv, status: 0, probe: true });
    process.exit(0);
  }
  const convertIndex = argv.indexOf("--convert-to");
  if (convertIndex === -1) {
    fail("fake soffice only implements --convert-to pdf and --version");
  }
  const rawFormat = argv[convertIndex + 1];
  const format = typeof rawFormat === "string" && !rawFormat.startsWith("-") ? rawFormat : "pdf";
  if (format !== "pdf") {
    fail("fake soffice cannot convert to " + format + ": only pdf");
  }
  const input = argv[argv.length - 1];
  if (typeof input !== "string" || input.length === 0 || input.startsWith("-")) {
    fail("fake soffice: cannot determine the input file from the command");
  }
  const outDir = valueOf("--outdir") ?? path.dirname(path.resolve(input));
  const stem = path.basename(input).replace(/\.[^.]*$/, "") || "output";
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, stem + ".pdf"), minimalBlankPdf());
  log({ tool: "soffice", argv, status: 0 });
  process.exit(0);
} catch (error) {
  fail(error);
}
