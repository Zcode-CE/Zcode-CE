// --- 来源与归属 ---
// 归属:      ZCode-CE 自研（self）。无上游来源，不回写任何上游。
// 由来:      check_pdf.mjs 的按职责拆分（依赖方向单向：structure → text → checks → 入口，无循环依赖）。
// 本模块:    检查流程与报告组装
// 行为基准:  与拆分前的单文件实现逐项一致（回归测试见 test/checkPdf.test.mjs）。
// ---------------------------------------------------------------------------
import { readFileSync, statSync } from "node:fs";
import { MAX_INPUT_BYTES, PdfFormatError, decodeStream, parsePdf } from "./pdf-structure.mjs";
import {
  bytesToText,
  collectFonts,
  fontResourceMap,
  mediaBox,
  pageObjects,
  readShownStrings,
} from "./pdf-text.mjs";

const PAGE_SIZES = { A4: [595.28, 841.89], Letter: [612, 792], A3: [841.89, 1190.55] };

// ===== 检查流程 =====

function checkPdf(inputPath, options) {
  const checks = [];
  const summary = {
    pages: 0,
    fonts: [],
    contentChars: 0,
    visualCheck: "not_performed",
    visualCheckReason: null,
  };
  let failed = false;
  const add = (id, status, detail) => {
    checks.push(detail === undefined ? { id, status } : { id, status, detail });
    if (status === "fail") failed = true;
  };
  let pdf;
  try {
    if (statSync(inputPath).size > MAX_INPUT_BYTES)
      throw new PdfFormatError("input exceeds " + MAX_INPUT_BYTES + " bytes");
    pdf = parsePdf(readFileSync(inputPath));
    add("package", "pass");
  } catch (error) {
    add("package", "fail", error instanceof Error ? error.message : String(error));
    return { report: { format: "pdf", verdict: "fail", checks, summary }, failed: true };
  }

  const catalog = pdf.objects.get(pdf.xref.root);
  if (!catalog || !/\/Type\s*\/Catalog\b/.test(catalog.dict))
    add("catalog", "fail", "trailer /Root does not point at a /Catalog");
  else if (!/\/Pages\s+\d+\s+0\s+R/.test(catalog.dict))
    add("catalog", "fail", "catalog has no /Pages reference");
  else add("catalog", "pass");

  const pages = pageObjects(pdf);
  summary.pages = pages.length;
  if (pages.length === 0) add("pages", "fail", "no /Type /Page object found");
  else if (options.count !== undefined && pages.length !== options.count) {
    add("pages", "fail", "expected " + options.count + " page(s), found " + pages.length);
  } else {
    add("pages", "pass", pages.length + " page(s)");
  }
  const pagesNode = pdf.objects.get(
    Number(/\/Pages\s+(\d+)\s+0\s+R/.exec(catalog?.dict ?? "")?.[1] ?? -1),
  );
  const declaredCount = Number(/\/Count\s+(\d+)/.exec(pagesNode?.dict ?? "")?.[1] ?? -1);
  if (declaredCount !== -1 && declaredCount !== pages.length) {
    add(
      "page-tree",
      "fail",
      "/Pages /Count is " + declaredCount + " but " + pages.length + " page object(s) exist",
    );
  } else add("page-tree", "pass");

  if (options.size) {
    const expected = PAGE_SIZES[options.size];
    const boxes = pages.map(mediaBox);
    const bad = boxes.find(
      (box) =>
        !box || Math.abs(box.width - expected[0]) > 1 || Math.abs(box.height - expected[1]) > 1,
    );
    if (bad === undefined)
      add("page-size", "pass", options.size + " (" + expected.join(" × ") + " pt)");
    else
      add(
        "page-size",
        "fail",
        "expected " +
          options.size +
          " (" +
          expected.join(" × ") +
          " pt), got " +
          JSON.stringify(bad),
      );
  }

  const fonts = collectFonts(pdf);
  summary.fonts = [...fonts.values()].map((font) => ({
    baseFont: font.baseFont,
    embedded: font.embedded,
    embeddedBytes: font.embeddedBytes,
    subset: font.subset,
    type0: font.type0,
    subsetGlyphs: font.subsetGlyphs,
  }));
  const used = new Map();
  for (const page of pages) {
    for (const [, objNum] of fontResourceMap(pdf, page)) {
      const font = fonts.get(objNum);
      if (font) used.set(objNum, font);
    }
  }
  if (used.size === 0) add("fonts", "fail", "no font is referenced by any page resource");
  else {
    const notEmbedded = [...used.values()].filter((font) => !font.embedded || !font.embeddedBytes);
    const missingUnicode = [...used.values()].filter((font) => font.type0 && !font.toUnicode);
    const notSubset = [...used.values()].filter((font) => !font.subset);
    if (notEmbedded.length)
      add(
        "fonts",
        "fail",
        "font(s) referenced but not embedded: " + notEmbedded.map((f) => f.baseFont).join(", "),
      );
    else if (missingUnicode.length)
      add(
        "fonts",
        "fail",
        "CID font(s) without /ToUnicode (text is not extractable): " +
          missingUnicode.map((f) => f.baseFont).join(", "),
      );
    else if (notSubset.length)
      add(
        "fonts",
        "fail",
        "font(s) without a subset tag (full font embedding): " +
          notSubset.map((f) => f.baseFont).join(", "),
      );
    else
      add(
        "fonts",
        "pass",
        used.size +
          " embedded subset(s), " +
          [...used.values()].reduce((sum, f) => sum + (f.embeddedBytes ?? 0), 0) +
          " B total",
      );
  }

  let text = "";
  for (const page of pages) {
    const resources = fontResourceMap(pdf, page);
    const contents = [...page.dict.matchAll(/\/Contents\s+(?:(\d+)\s+0\s+R|\[([^\]]+)\])/g)];
    const streams = [];
    for (const entry of contents) {
      if (entry[0].includes("["))
        for (const ref of entry[2].matchAll(/(\d+)\s+0\s+R/g))
          streams.push(pdf.objects.get(Number(ref[1])));
      else streams.push(pdf.objects.get(Number(entry[1])));
    }
    let current = null;
    for (const stream of streams) {
      const content = decodeStream(stream);
      if (!content) continue;
      for (const item of readShownStrings(content.toString("latin1"))) {
        if (item.font !== undefined) current = fonts.get(resources.get(item.font) ?? -1) ?? null;
        else text += bytesToText(item, current);
      }
    }
    text += "\n";
  }
  summary.contentChars = text.replace(/\s/g, "").length;

  for (const needle of options.contains) {
    if (text.includes(needle)) add("contains", "pass", JSON.stringify(needle));
    else add("contains", "fail", "text layer does not contain " + JSON.stringify(needle));
  }

  if (options.textFile) {
    const source = readFileSync(options.textFile, "utf8");
    const needed = [...new Set([...source].filter((char) => char.codePointAt(0) > 0x7f))];
    const present = new Set([...text]);
    const missing = needed.filter((char) => !present.has(char));
    if (missing.length === 0)
      add(
        "glyphs",
        "pass",
        needed.length + " distinct non-ASCII code point(s) present in the text layer",
      );
    else
      add(
        "glyphs",
        "fail",
        missing.length +
          "/" +
          needed.length +
          " source code point(s) missing from the text layer, e.g. " +
          JSON.stringify(missing.slice(0, 12).join("")),
      );
  }

  summary.visualCheckReason =
    "this tool performs structural checks only; run a renderer such as LibreOffice or Ghostscript if a visual check is required";
  add(
    "visual",
    options.requireVisual ? "fail" : "pass",
    options.requireVisual
      ? "visual check was not performed and --require-visual was given"
      : "not performed by design (structural checks only); declared in summary.visualCheck",
  );

  return { report: { format: "pdf", verdict: failed ? "fail" : "pass", checks, summary }, failed };
}

export { PAGE_SIZES, checkPdf };
