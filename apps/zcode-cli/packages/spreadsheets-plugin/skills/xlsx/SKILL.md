---
name: xlsx
metadata:
  upstream: "@deepseek-ai/dsh-skill-office (MIT)"
  modified: "ZCode-CE: 工具链由系统 Python(openpyxl/pandas) 改为随包 Node 库(exceljs 4.4.0)；修正校验器相对路径为 ../../scripts/；补充降级边界（重写丢失图表部件），见 docs/development/office-plugins.md"
description: Read, create, and modify Excel workbooks (.xlsx), including cell values, formulas, formatting, and analysis. Use when an Excel workbook is an input or deliverable.
---

# Excel workbooks

Read and write XLSX workbooks with the bundled `exceljs` library, loaded from this plugin's own payload. Follow an explicit user or applicable AGENTS.md requirement for an environment or library.

## Runtime

The library ships with the plugin at `<skill-directory>/../../scripts/office-node/exceljs.cjs`, a self-contained bundle. `<skill-directory>` is this loaded skill's resource base, and `${ZCODE_SKILL_DIR}` expands to the same path.

```js
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ExcelJS = require("${ZCODE_SKILL_DIR}/../../scripts/office-node/exceljs.cjs");
```

The anchor must be the bundle file itself. Do **not** point `createRequire` at a `node_modules` directory next to the skill, and do not expect a bare `require("exceljs")` to resolve: Node searches `node_modules` only in *ancestor* directories, and this payload is a sibling of `skills/`, so such a lookup fails with `MODULE_NOT_FOUND`.

**Never install anything.** Do not run `npm install` / `pnpm add` / `pip install`, do not fetch a package, and do not rewrite this skill to make a dependency appear. The payload is provided by the plugin; a missing bundle means the build is incomplete, not that a package needs installing. Report that instead.

Keep scripts, working files, and outputs in the task workspace. The runtime and skill directory are shared read-only resources. Save to a new workbook unless the user requests an in-place edit.

## Read and modify

Unlike the DOCX and PPTX skills, this library reads and writes: `workbook.xlsx.readFile()` loads an existing workbook and `workbook.xlsx.writeFile()` saves it. Inspect sheet names, the affected cell types, formulas, styles, and merged ranges before editing. Check the saved file by reopening it, including unchanged content that the request requires preserving.

```js
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ExcelJS = require("${ZCODE_SKILL_DIR}/../../scripts/office-node/exceljs.cjs");

const workbook = new ExcelJS.Workbook();
await workbook.xlsx.readFile("input.xlsx");
const sheet = workbook.getWorksheet("Revenue");
sheet.getCell("B2").value = 12;
await workbook.xlsx.writeFile("result.xlsx");
```

### Known limitation: rewriting a workbook drops chart parts

**`writeFile()` on a workbook loaded from an existing file preserves cell values, formulas, and merged cells, but does not preserve chart parts.** A chart present in the input will be absent from the output. This is a limitation of the bundled library, verified by test.

So:

- If the request touches cells **outside** any chart, do the edit and **tell the user the workbook's charts were not preserved** (or are at risk) before delivering.
- If the request depends on preserving charts, **say plainly that the current build cannot do it reliably** and ask how to proceed. Never present the rewritten workbook as a faithful edit when charts were dropped.
- Do not try to reconstruct charts by hand.

## Create

For a new workbook, write values, styles, and formulas directly:

```js
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ExcelJS = require("${ZCODE_SKILL_DIR}/../../scripts/office-node/exceljs.cjs");

const workbook = new ExcelJS.Workbook();
const sheet = workbook.addWorksheet("Revenue");
sheet.columns = [
  { header: "Quarter", key: "q", width: 18 },
  { header: "Revenue", key: "r", width: 18 },
];
sheet.addRow({ q: "Q1", r: 12 });
sheet.addRow({ q: "Q2", r: 18 });
sheet.addRow({ q: "Total", r: { formula: "SUM(B2:B3)", result: 30 } });
sheet.getRow(1).font = { bold: true };
await workbook.xlsx.writeFile("report.xlsx");
```

Preserve numbers, dates, booleans, and identifiers as the intended cell types; formatting is not a type conversion. Prefer a targeted cell or range edit over rebuilding a sheet, since rebuilding discards parts the library cannot represent.

Writing a formula does not calculate its result: this library stores formulas and any cached `result` you supply, but does not evaluate them. Verify formulas and inputs separately, and state when current results require recalculation in a spreadsheet application. Do not replace requested formulas with constants or report cached values as newly calculated results.

Do not rename `.xls`, `.xlsb`, encrypted files, or macro-enabled files to `.xlsx`. They need an appropriate supported operation, and this build does not provide one. Preserve the original and report the limitation.

## Check and deliver

Run the shared checker with Node; `<skill-directory>` is this loaded skill's resource base:

```text
node ${ZCODE_SKILL_DIR}/../../scripts/check_office.mjs <workbook.xlsx> --out <checks.json>
```

It checks ZIP/XML integrity and internal relationships, and reports sheet names, populated-cell counts, and formula counts. Repeated `--contains TEXT` arguments check string cells and sheet names, and `--count N` checks sheet count. `--contains` excludes numeric cells and does not validate formula results; verify those separately by reopening the workbook. The checker does not calculate formulas or judge workbook appearance. Compare relevant values, types, formulas, styles, and totals with the task's source data.

This build has no document-rendering tool, so visual layout cannot be inspected by default. Complete the structural and content checks above, deliver the file, and briefly state that visual layout was not inspected.

If the user explicitly asks for a visual check, convert to PDF with LibreOffice when `soffice` is on PATH and let the user review the result:

```bash
soffice --headless --convert-to pdf report.xlsx
```

Do not require the user to install a renderer. When rendering is unavailable, preserve the usable workbook and report the inspection limit rather than blocking delivery. Rendered pages follow spreadsheet print settings, so a page is not necessarily a worksheet. LibreOffice preview conversion neither updates the original workbook's cached formulas nor certifies native Excel calculation or appearance.

This build has no file-presentation tool. Provide the final workbook path in your reply and keep the file in place so the user can open it directly. Do not create intermediate images or QA reports unless the user asks for them.