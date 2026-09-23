// --- 来源与归属 ---
// 归属:      ZCode-CE 自研（self）。无上游来源，不回写任何上游。
// 由来:      原型实测结论的固化（见 .reverse/38-pdf/PDF-FEASIBILITY.md §3）：PDFKit 有流式排版与
//            自动分页，但**没有表格原语**、且页脚画在可写区之下会被库**静默加页**。
// 本模块:    文档模型（blocks）→ PDF 渲染。只处理布局与绘制，不做字体验证、不写最终文件。
// 约束:      布局只用 PDFKit 的公开 API；分页断言失败必须抛错，不许产出"看着对"的产物。
// ---------------------------------------------------------------------------
import { createWriteStream, existsSync, statSync } from "node:fs";

/** 默认排版参数（集中一处，便于技能与文档引用）。 */
const DEFAULT_MARGINS = { top: 56, right: 56, bottom: 56, left: 56 };
const DEFAULT_BODY_SIZE = 11;
const DEFAULT_LINE_GAP = 4;
const HEADING_SIZES = { 1: 20, 2: 15, 3: 13 };
const HEADING_SPACE_AFTER = { 1: 10, 2: 8, 3: 6 };
const TABLE_ROW_PADDING = 5;
const TABLE_HEADER_FILL = "#F2F4F7";
const TABLE_BORDER_COLOR = "#B7BDC6";
const TABLE_HEADER_BORDER_COLOR = "#8A9199";
const LIST_INDENT = 16;
const LIST_MARKER = "• ";
const FOOTER_SIZE = 9;
const FOOTER_COLOR = "#5F6368";
const FOOTER_BOTTOM_OFFSET = 40;
const MIN_COLUMN_FRACTION_TOTAL = 2;

/** 支持的页面尺寸：与 check_pdf.mjs 的 --size 取值、PAGE_SIZES 保持一致。 */
export const PAGE_SIZES = { A3: "A3", A4: "A4", Letter: "Letter" };

const BLOCK_TYPES = ["heading", "paragraph", "table", "list", "spacer", "pageBreak"];

export class PdfBuildError extends Error {}

function fail(message) {
  throw new PdfBuildError(message);
}

/** 规范化模型：任何不认识的 block 类型都**报错**而不是跳过（跳过 = 静默丢内容）。 */
export function normalizeModel(raw) {
  if (raw === null || typeof raw !== "object") fail("文档模型必须是 JSON 对象");
  if (!Array.isArray(raw.blocks) || raw.blocks.length === 0) fail("文档模型缺少非空的 blocks 数组");
  const pageSize = raw.page?.size ?? "A4";
  if (!Object.hasOwn(PAGE_SIZES, pageSize)) {
    fail(["不支持的 page.size：", pageSize, "（支持 ", Object.keys(PAGE_SIZES).join(" / "), "）"].join(""));
  }
  const margins = { ...DEFAULT_MARGINS, ...(raw.page?.margins ?? {}) };
  raw.blocks.forEach((block, index) => {
    if (block === null || typeof block !== "object") fail("blocks[" + index + "] 不是对象");
    if (!BLOCK_TYPES.includes(block.type)) {
      fail("blocks[" + index + "].type 不受支持：" + block.type + "（支持 " + BLOCK_TYPES.join(" / ") + "）");
    }
    if (block.type === "table") {
      if (!Array.isArray(block.columns) || block.columns.length === 0) fail("blocks[" + index + "] 表格缺少 columns");
      if (!Array.isArray(block.rows)) fail("blocks[" + index + "] 表格缺少 rows 数组");
    }
  });
  return { ...raw, margins, pageSize };
}

function footerText(model, page, pages) {
  const template = model.footer?.text ?? "第 {page} 页 / 共 {pages} 页";
  return template.replaceAll("{page}", String(page)).replaceAll("{pages}", String(pages));
}

/**
 * 收集文档里出现的全部文本（供 check_pdf --text 做字形覆盖断言）。
 *
 * 为什么要有这一步：PDFKit 对"字体缺字形"**不报错**，只会画成 .notdef（实测：纯拉丁字体写中文
 * 得到一份 3.9 KB 的豆腐 PDF）。把源文本交给校验器，"哪些字没画出来"就变成可断言的事实。
 */
export function collectDocumentText(model) {
  const parts = [];
  const push = (value) => {
    if (typeof value === "string" && value.length > 0) parts.push(value);
  };
  push(model.info?.title);
  push(model.info?.author);
  if (model.footer?.enabled !== false) push(footerText(model, 1, 1));
  for (const block of model.blocks) {
    push(block.text);
    if (block.type === "list") for (const item of block.items ?? []) push(item);
    if (block.type === "table") {
      for (const column of block.columns) push(column.title ?? column.text);
      for (const row of block.rows) for (const cell of row) push(cell);
    }
  }
  return parts.join("\n");
}

/** 列宽：全为数字时按比例归一化到内容宽度（和为 1 或任意正数都接受），否则等分。 */
function resolveColumnWidths(columns, contentWidth) {
  const raw = columns.map((column) => column.width);
  const allNumeric = raw.every((value) => typeof value === "number" && value > 0);
  if (allNumeric && raw.reduce((sum, value) => sum + value, 0) <= MIN_COLUMN_FRACTION_TOTAL * contentWidth) {
    const total = raw.reduce((sum, value) => sum + value, 0);
    return raw.map((value) => (value / total) * contentWidth);
  }
  return columns.map(() => contentWidth / columns.length);
}

function measureRowHeight(doc, cells, widths) {
  return Math.max(
    ...cells.map((cell, index) =>
      doc.heightOfString(String(cell ?? ""), { width: widths[index] - TABLE_ROW_PADDING * 2 }),
    ),
  ) + TABLE_ROW_PADDING * 2;
}

function drawTableRow(doc, { x, y, widths, cells, bodyFont, boldFont, header = false, fontSize }) {
  const height = measureRowHeight(doc, cells, widths);
  const totalWidth = widths.reduce((sum, width) => sum + width, 0);
  doc.save();
  if (header) doc.rect(x, y, totalWidth, height).fill(TABLE_HEADER_FILL);
  doc.lineWidth(0.6);
  let cursor = x;
  for (let index = 0; index < cells.length; index += 1) {
    doc
      .rect(cursor, y, widths[index], height)
      .stroke(header ? TABLE_HEADER_BORDER_COLOR : TABLE_BORDER_COLOR);
    doc.font(header ? boldFont : bodyFont).fontSize(fontSize).fillColor("#000");
    doc.text(String(cells[index] ?? ""), cursor + TABLE_ROW_PADDING, y + TABLE_ROW_PADDING, {
      width: widths[index] - TABLE_ROW_PADDING * 2,
    });
    cursor += widths[index];
  }
  doc.restore();
  return height;
}

/**
 * 渲染整份文档。
 *
 * @param {{ PDFDocument: any, model: any, fonts: { body: string, bold: string }, fontFiles: { body: string, bold: string }, outPath: string }} input
 * @returns {Promise<{ pages: number, bytes: number }>}
 */
export async function renderPdf({ PDFDocument, model, fonts, fontFiles, outPath }) {
  const doc = new PDFDocument({
    autoFirstPage: true,
    bufferPages: true,
    compress: true,
    // 必须显式关掉内建标准字体：它们的 AFM 数据不在随包载荷里（实测缺 data/*.afm 会让构造期
    // 直接 ENOENT 崩）。代价是所有文本都要显式 registerFont —— 漏了会抛错（响亮失败）。
    font: null,
    info: { Author: model.info?.author ?? "", Title: model.info?.title ?? "" },
    margins: model.margins,
    size: model.pageSize,
  });
  doc.registerFont("pdf-body", fontFiles.body, fonts.body);
  doc.registerFont("pdf-bold", fontFiles.bold, fonts.bold);
  const stream = createWriteStream(outPath);
  doc.pipe(stream);

  const contentWidth = doc.page.width - model.margins.left - model.margins.right;
  const contentLeft = model.margins.left;
  const bodyFontSize = model.style?.size ?? DEFAULT_BODY_SIZE;
  const lineGap = model.style?.lineGap ?? DEFAULT_LINE_GAP;
  const fontsRef = { body: "pdf-body", bold: "pdf-bold" };

  const ensureSpace = (needed) => {
    if (doc.y + needed > doc.page.maxY()) doc.addPage();
  };

  for (const block of model.blocks) {
    if (block.type === "pageBreak") {
      doc.addPage();
    } else if (block.type === "spacer") {
      doc.y += typeof block.height === "number" && block.height > 0 ? block.height : 12;
    } else if (block.type === "heading") {
      const level = [1, 2, 3].includes(block.level) ? block.level : 1;
      doc.font("pdf-bold").fontSize(HEADING_SIZES[level]).fillColor("#000");
      ensureSpace(doc.heightOfString(block.text ?? "", { width: contentWidth }));
      doc.text(block.text ?? "", { lineGap, width: contentWidth });
      doc.y += HEADING_SPACE_AFTER[level];
    } else if (block.type === "paragraph") {
      doc.font("pdf-body").fontSize(block.size ?? bodyFontSize).fillColor("#000");
      doc.text(block.text ?? "", { align: block.align ?? "justify", lineGap, width: contentWidth });
      doc.y += lineGap;
    } else if (block.type === "list") {
      doc.font("pdf-body").fontSize(bodyFontSize).fillColor("#000");
      for (const item of block.items ?? []) {
        ensureSpace(doc.heightOfString(LIST_MARKER + item, { width: contentWidth - LIST_INDENT }));
        doc.text(LIST_MARKER + item, contentLeft + LIST_INDENT, doc.y, {
          lineGap,
          width: contentWidth - LIST_INDENT,
        });
      }
      doc.y += lineGap;
    } else if (block.type === "table") {
      const widths = resolveColumnWidths(block.columns, contentWidth);
      const fontSize = block.size ?? bodyFontSize - 1;
      const titles = block.columns.map((column) => column.title ?? column.text ?? "");
      const repeatHeader = block.headerRepeat !== false;
      const rows = [
        titles,
        ...block.rows.map((row) => block.columns.map((_, index) => row[index] ?? "")),
      ];
      let rowIndex = 0;
      while (rowIndex < rows.length) {
        const isHeader = rowIndex === 0;
        doc.font(isHeader ? "pdf-bold" : "pdf-body").fontSize(fontSize);
        if (doc.y + measureRowHeight(doc, rows[rowIndex], widths) > doc.page.maxY()) {
          doc.addPage();
          // 表头在续页重复：只画表头，不递增 rowIndex（数据行没变）。
          if (repeatHeader && rowIndex > 0) {
            doc.y += drawTableRow(doc, {
              bodyFont: fontsRef.body, boldFont: fontsRef.bold, cells: titles, fontSize,
              header: true, widths, x: contentLeft, y: doc.y,
            });
          }
        }
        doc.y += drawTableRow(doc, {
          bodyFont: fontsRef.body, boldFont: fontsRef.bold, cells: rows[rowIndex], fontSize,
          header: isHeader, widths, x: contentLeft, y: doc.y,
        });
        rowIndex += 1;
      }
      doc.y += lineGap;
    } else {
      // normalizeModel 已排除未知类型；这里保留响亮失败而不是静默跳过。
      fail("未处理的 block 类型：" + block.type);
    }
  }

  // 页码：两遍渲染。**先记下内容页数** —— 页脚绘制必须是"零新增页"，否则就是那个被实测抓到的
  // 静默加页缺陷（页脚画在 maxY 之下时 PDFKit 会新增一页，2 页文档变 4 页且每页都有页码）。
  const contentPages = doc.bufferedPageRange().count;
  if (model.footer?.enabled !== false) {
    const range = doc.bufferedPageRange();
    for (let index = range.start; index < range.start + range.count; index += 1) {
      doc.switchToPage(index);
      // 关键：页脚要落在内容区之下，必须先临时把 bottom margin 归零。
      const savedBottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font("pdf-body").fontSize(FOOTER_SIZE).fillColor(FOOTER_COLOR);
      doc.text(footerText(model, index + 1, range.count), contentLeft, doc.page.height - FOOTER_BOTTOM_OFFSET, {
        align: "center",
        lineBreak: false,
        width: contentWidth,
      });
      doc.page.margins.bottom = savedBottom;
    }
  }
  const pagesAfterFooter = doc.bufferedPageRange().count;
  if (pagesAfterFooter !== contentPages) {
    fail("页脚绘制导致页数变化（" + contentPages + " → " + pagesAfterFooter + "）：页脚越界会被 PDFKit 静默加页");
  }

  doc.end();
  await new Promise((resolveFinish, rejectFinish) => {
    stream.on("finish", resolveFinish);
    stream.on("error", rejectFinish);
  });
  if (!existsSync(outPath)) fail("渲染未产出文件：" + outPath);
  return { bytes: statSync(outPath).size, pages: contentPages };
}
