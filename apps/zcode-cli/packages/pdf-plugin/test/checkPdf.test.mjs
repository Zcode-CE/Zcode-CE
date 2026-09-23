// --- 来源与归属 ---
// 归属: ZCode-CE 自研（self）。无上游来源。
// 目的: check_pdf.mjs 的回归测试。夹具是**程序化拼装的最小 PDF**（零第三方依赖），
//       不依赖任何 PDF 库 —— 与 documents-plugin/test/checkOfficePrefix.test.mjs 用真实库产物
//       打盲区的动机一致，但这里刻意不用真实库产物：校验器的契约是「结构」，而结构可以逐字节控制。
// 变异验证: 每个负例都对应一条真实失效形态，去掉对应检查项后该用例必须变红（否则断言没有牙齿）。
// ---------------------------------------------------------------------------
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const CHECKER = fileURLToPath(new URL("../scripts/check_pdf.mjs", import.meta.url));
const workDir = mkdtempSync(join(tmpdir(), "check-pdf-"));
test.after(() => rmSync(workDir, { recursive: true, force: true }));

/** 程序化拼装最小 PDF：经典 xref 表 + Type0/Identity-H 字体 + 可选 FontFile3 / ToUnicode。 */
function buildPdf(options = {}) {
  const {
    pageCount = 1,
    embedFontFile = true,
    withToUnicode = true,
    subsetTag = "ABCDEF+",
    text = "中文测试",
    // 覆盖 ToUnicode 生成形状：默认逐码位 bfchar；"bfrangeArray" 复刻 PDFKit 的真实输出形状
    // （目标是**数组**，且其中一项含多个 UTF-16 码元，见回归用例）。
    cmapStyle = "bfchar",
    // 显式码位映射（一个码位可以对应**多个** UTF-16 码元，例如 U+2014 U+2014）。
    codeMap = undefined,
  } = options;
  const baseFont = `${subsetTag}TestCJK`;
  const codes = (codeMap ?? [...text].map((char, index) => [index + 1, char])).map(
    ([code, char]) => ({ char, code }),
  );
  const objects = [];
  const define = (body) => {
    objects.push(body);
    return objects.length;
  };
  const catalog = define("");
  const pages = define("");
  const font = define("");
  const cidFont = define("");
  const descriptor = define("");
  const fontFile = embedFontFile ? define("") : null;
  const toUnicode = withToUnicode ? define("") : null;
  const pageIds = [];
  const resourceIds = [];
  const contentIds = [];
  for (let i = 0; i < pageCount; i += 1) {
    const pageId = define("");
    const resourceId = define("");
    const contentId = define("");
    pageIds.push(pageId);
    resourceIds.push(resourceId);
    contentIds.push(contentId);
    objects[pageId - 1] =
      `<</Type/Page/Parent ${pages} 0 R/MediaBox[0 0 595.28 841.89]/Contents ${contentId} 0 R/Resources ${resourceId} 0 R>>`;
    objects[resourceId - 1] = `<</ProcSet[/PDF/Text]/Font<</F1 ${font} 0 R>>>>`;
    const shown = codes.map(({ code }) => code.toString(16).padStart(4, "0")).join("");
    objects[contentId - 1] = `<</Length 0>>\nstream\nBT /F1 12 Tf <${shown}> Tj ET\nendstream`;
    objects[contentId - 1] = objects[contentId - 1].replace(
      "/Length 0",
      "/Length " + (objects[contentId - 1].length - objects[contentId - 1].indexOf("stream\n") - 7),
    );
  }
  objects[catalog - 1] = `<</Type/Catalog/Pages ${pages} 0 R>>`;
  objects[pages - 1] =
    `<</Type/Pages/Kids[${pageIds.map((id) => id + " 0 R").join(" ")}]/Count ${pageCount}>>`;
  objects[font - 1] =
    `<</Type/Font/Subtype/Type0/BaseFont/${baseFont}/Encoding/Identity-H/DescendantFonts[${cidFont} 0 R]${toUnicode ? "/ToUnicode " + toUnicode + " 0 R" : ""}>>`;
  objects[cidFont - 1] =
    `<</Type/Font/Subtype/CIDFontType0/BaseFont/${baseFont}/CIDSystemInfo<</Registry(Adobe)/Ordering(Identity)/Supplement 0>>/FontDescriptor ${descriptor} 0 R/W[0[${codes.map(() => 1000).join(" ")}]]>>`;
  objects[descriptor - 1] =
    `<</Type/FontDescriptor/FontName/${baseFont}/Flags 4${fontFile ? "/FontFile3 " + fontFile + " 0 R" : ""}>>`;
  if (embedFontFile)
    objects[fontFile - 1] = "<</Subtype/CIDFontType0C/Length 4>>\nstream\nDUMM\nendstream";
  if (withToUnicode) {
    const preamble =
      "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n" +
      "1 begincodespacerange\n<0000> <ffff>\nendcodespacerange\n";
    let body;
    if (cmapStyle === "bfrangeArray") {
      // 复刻 PDFKit 的真实形状：一个 bfrange + 目标数组，其中 `<${text}>` 这一项可能是
      // 多个 UTF-16 码元（例如 U+2014 U+2014 表示两个连续的全角破折号）。
      const destinations = codes
        .map(({ char }) => {
          const units = [...char].map((item) => item.codePointAt(0).toString(16).padStart(4, "0"));
          return `<${units.join(" ")}>`;
        })
        .join(" ");
      body = preamble + `1 beginbfrange\n<0001> <${codes.length.toString(16).padStart(4, "0")}> [${destinations}]\nendbfrange\nendcmap\nend\nend\n`;
    } else {
      const entries = codes
        .map(
          ({ char, code }) =>
            `<${code.toString(16).padStart(4, "0")}> <${char.codePointAt(0).toString(16).padStart(4, "0")}>`,
        )
        .join("\n");
      body = preamble + `${codes.length} beginbfchar\n${entries}\nendbfchar\nendcmap\nend\nend\n`;
    }
    objects[toUnicode - 1] = `<</Length ${body.length}>>\nstream\n${body}endstream`;
  }
  let out = "%PDF-1.3\n";
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += String(offset).padStart(10, "0") + " 00000 n \n";
  out += `trailer\n<</Size ${objects.length + 1}/Root ${catalog} 0 R>>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return { bytes: Buffer.from(out, "latin1"), text: codes.map(({ char }) => char).join("") };
}

function write(name, contents) {
  const path = join(workDir, name);
  writeFileSync(path, contents);
  return path;
}

/** 跑校验器，返回 { code, report, stdout, stderr }；不抛错，因为负例本来就该非零退出。 */
function runChecker(args) {
  try {
    const stdout = execFileSync("node", [CHECKER, ...args], { encoding: "utf8" });
    return { code: 0, stdout, stderr: "", report: JSON.parse(stdout) };
  } catch (error) {
    const stdout = error.stdout ?? "";
    return {
      code: error.status,
      stdout,
      stderr: error.stderr ?? "",
      report: stdout.trim() === "" ? null : JSON.parse(stdout),
    };
  }
}

const failedIds = (report) =>
  report.checks.filter((check) => check.status === "fail").map((check) => check.id);

test("正例：结构完整、页数一致、文本层可断言", () => {
  const { bytes, text } = buildPdf({ pageCount: 2, text: "中文测试" });
  const pdf = write("ok.pdf", bytes);
  const textFile = write("ok.txt", text + "\n");
  const result = runChecker([
    pdf,
    "--count",
    "2",
    "--contains",
    "中文",
    "--size",
    "A4",
    "--text",
    textFile,
  ]);
  assert.equal(result.code, 0);
  assert.equal(result.report.verdict, "pass");
  assert.deepEqual(failedIds(result.report), []);
  assert.equal(result.report.summary.pages, 2);
});

test("页数不符必须失败（页脚越界被库静默加页的失效形态）", () => {
  const { bytes } = buildPdf({ pageCount: 4 });
  const result = runChecker([write("pages.pdf", bytes), "--count", "2"]);
  assert.equal(result.code, 1);
  assert.deepEqual(failedIds(result.report), ["pages"]);
});

test("字体未嵌入必须失败", () => {
  const { bytes } = buildPdf({ pageCount: 1, embedFontFile: false });
  const result = runChecker([write("no-fontfile.pdf", bytes)]);
  assert.equal(result.code, 1);
  assert.deepEqual(failedIds(result.report), ["fonts"]);
});

test("CID 字体缺 /ToUnicode 必须失败（文本不可提取 = 检索/复制全废）", () => {
  const { bytes } = buildPdf({ withToUnicode: false });
  const result = runChecker([write("no-tounicode.pdf", bytes)]);
  assert.equal(result.code, 1);
  assert.deepEqual(failedIds(result.report), ["fonts"]);
});

test("整字体嵌入（无子集前缀）必须失败", () => {
  const { bytes } = buildPdf({ subsetTag: "" });
  const result = runChecker([write("no-subset.pdf", bytes)]);
  assert.equal(result.code, 1);
  assert.deepEqual(failedIds(result.report), ["fonts"]);
});

test("文本层缺字必须失败（无中文字体时的静默豆腐产物就是这种形态）", () => {
  const { bytes } = buildPdf({ text: "中文" });
  const pdf = write("partial.pdf", bytes);
  const result = runChecker([pdf, "--text", write("more.txt", "中文字体\n"), "--contains", "字体"]);
  assert.equal(result.code, 1);
  assert.deepEqual(failedIds(result.report).sort(), ["contains", "glyphs"]);
});

test("bfrange 目标数组含多码元项时不得错位（PDFKit 写连续全角破折号的真实形状）", () => {
  // 回归用例（task-9 实跑抓到）：PDFKit 的 ToUnicode 是
  //   beginbfrange <0001> <0003> [<4e2d> <2014 2014> <6587>]  ← 中间那项是两个 UTF-16 码元
  // 早期解析用 /<([0-9A-Fa-f]+)>/ 取值，含空格的 <2014 2014> 匹配不上而被静默丢掉，
  // 于是数组下标整体前移：码位 2 被映成「文」、码位 3 失配 —— 一个**文本层完全正确**的产物
  // 被误报成"缺字"。断言必须证明"没有错位"，而不只是"整体能过"。
  const { bytes } = buildPdf({
    cmapStyle: "bfrangeArray",
    codeMap: [
      [1, "中"],
      [2, "——"],
      [3, "文"],
    ],
  });
  const pdf = write("bfrange-array.pdf", bytes);
  const ok = runChecker([pdf, "--contains", "中——文"]);
  assert.equal(ok.code, 0);
  assert.deepEqual(failedIds(ok.report), []);
  // 反向断言：错位实现会把「中——文」读成「中文」（或丢字），因此这条必须失败。
  const shifted = runChecker([pdf, "--contains", "中文"]);
  assert.equal(shifted.code, 1);
  const textOk = runChecker([pdf, "--text", write("bfrange-array.txt", "中——文\n")]);
  assert.equal(textOk.code, 0);
});

test("视觉检查默认声明为未执行；--require-visual 时必须失败", () => {
  const { bytes } = buildPdf({});
  const pdf = write("visual.pdf", bytes);
  const relaxed = runChecker([pdf]);
  assert.equal(relaxed.report.summary.visualCheck, "not_performed");
  assert.equal(relaxed.report.verdict, "pass");
  const strict = runChecker([pdf, "--require-visual"]);
  assert.equal(strict.code, 1);
  assert.deepEqual(failedIds(strict.report), ["visual"]);
});

test("截断与非法输入必须结构化失败（不允许「退出码 1 + 空 stdout」）", () => {
  const { bytes } = buildPdf({});
  const truncated = runChecker([write("truncated.pdf", bytes.subarray(0, 120))]);
  assert.equal(truncated.code, 1);
  assert.equal(truncated.report.verdict, "fail");
  assert.ok(truncated.report.checks[0].detail.length > 0);
  const notPdf = runChecker([write("not-a.pdf", "hello")]);
  assert.equal(notPdf.code, 1);
  assert.match(notPdf.report.checks[0].detail, /%PDF-/);
});

test("报告 JSON 转义非 ASCII（与 check_office 的 ensure_ascii 口径一致）", () => {
  const { bytes } = buildPdf({ text: "中文" });
  const result = runChecker([write("ascii.pdf", bytes), "--contains", "中文"]);
  assert.equal(result.code, 0);
  // eslint-disable-next-line no-control-regex -- 断言 stdout 里没有原始非 ASCII 字节
  assert.equal(/[^\u0000-\u007f]/.test(result.stdout), false);
});

test("参数错误退出码 2 且不产出报告", () => {
  const { bytes } = buildPdf({});
  const pdf = write("args.pdf", bytes);
  const badCount = runChecker([pdf, "--count", "abc"]);
  assert.equal(badCount.code, 2);
  assert.equal(badCount.report, null);
  assert.match(badCount.stderr, /usage:/);
  assert.equal(runChecker([pdf, "--size", "A5"]).code, 2);
  assert.equal(runChecker([pdf, "--nope"]).code, 2);
  assert.equal(runChecker([write("wrong.txt", "x")]).code, 2);
});
