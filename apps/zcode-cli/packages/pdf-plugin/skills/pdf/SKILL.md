---
name: pdf
description: Create PDF documents (.pdf) with the plugin's bundled PDFKit payload — body text in any script the system fonts cover (CJK included), tables drawn to fit the page, page numbers, and structural verification before delivery. Use when a PDF file is a requested deliverable, or when the user wants a document built from scratch rather than converted. Not a LaTeX engine and not an Office converter.
---

# PDF documents

Create PDF files with the bundled PDFKit payload. This skill covers **building a PDF from scratch** — it is not LaTeX, and it does not convert Office files (for DOCX/PPTX/XLSX use those skills; for Office→PDF conversion see "Boundaries" below).

## Runtime

The library ships with the plugin at `<skill-directory>/../../scripts/pdf-node/pdfkit.cjs`, a self-contained bundle (no `node_modules`). `<skill-directory>` is this loaded skill's resource base, and `${ZCODE_SKILL_DIR}` expands to the same path.

```js
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const PDFDocument = require("${ZCODE_SKILL_DIR}/../../scripts/pdf-node/pdfkit.cjs");
```

The anchor must be the bundle file itself. Do **not** point `createRequire` at a `node_modules` directory next to the skill, and do not expect a bare `require("pdfkit")` to resolve: this payload is a sibling of `skills/`, so an ancestor-directory lookup fails with `MODULE_NOT_FOUND`.

**Never install anything.** Do not run `npm install` / `pnpm add` / `pip install`, do not fetch a package, and do not rewrite this skill to make a dependency appear. A missing bundle means the build is incomplete, not that a package needs installing — report that.

## Fonts: system fonts only, and fail closed

**There is no bundled font.** PDFKit embeds and subsets whatever font you register, and only the glyphs actually used — a 30-page Chinese document produced a 67 KB embedded subset from a 19.5 MB system font. Fonts come from the user's system, first match wins.

Register a face with `pdf-fonts.mjs` instead of picking a path yourself:

```js
import { resolveFontFace } from "${ZCODE_SKILL_DIR}/../../scripts/pdf-fonts.mjs";
const face = resolveFontFace(documentText); // { file, postscriptName, missing, candidates }
if (face.missing.length > 0) {
  /* fail closed — see below */
}
doc.registerFont("cjk", face.file, face.postscriptName);
```

Three facts this helper exists for, all measured on Linux:

1. **Most CJK fonts are `.ttc` collections and need a PostScript face name.** `registerFont(path)` without a face name throws `this.font.createSubset is not a function`, and a _family_ name (`"Noto Sans CJK SC"`) fails to resolve inside a collection. Pass `postscriptName`.
2. **Naively scanning every system font is slow and picks the wrong face.** Walking 1,569 font files and testing CJK coverage took 752 ms and selected `NotoSansCJKjp-Black` — a Japanese face in the heaviest weight. Name-filtered candidates plus preference ordering take ~230 ms and select `NotoSansCJKsc-Regular`.
3. **PDFKit reports nothing when the font lacks a glyph.** With a Latin-only font, Chinese text produced a 3.9 KB PDF whose glyphs are all `.notdef`: no exception, no warning, and the extracted text is NUL bytes. That is a silently broken deliverable.

**So: a document whose characters the chosen font does not cover must not be delivered.** Build to a temporary path, verify, and only then move the file into place:

```bash
node "${ZCODE_SKILL_DIR}/../../scripts/check_pdf.mjs" out.tmp.pdf --count <expected> --text source.txt --size A4
# rc 0 → mv out.tmp.pdf report.pdf ; rc 1 → report the failing check, delete the temporary file, deliver nothing
```

When `--text` reports missing code points, the system has no font covering them. Tell the user **which characters** are missing and give the install command for their platform (on Linux, for example, the Noto CJK package), noting that installing needs administrator rights and that they run the command themselves — never paste a password into the conversation. **Do not substitute a Latin font and continue.**

## Build

Register your font, and pass `font: null` so the document does not initialize a built-in standard font: the AFM data for those fonts is not part of the bundle, and initializing one fails at runtime.

```js
const doc = new PDFDocument({
  size: "A4",
  margins: { top: 56, bottom: 56, left: 56, right: 56 },
  bufferPages: true, // needed for "page n of m" footers
  compress: true,
  font: null, // required: no built-in standard fonts in this payload
});
doc.pipe(createWriteStream("out.tmp.pdf"));
doc.registerFont("cjk", face.file, face.postscriptName);
doc.font("cjk").fontSize(11).text(body, { lineGap: 4 });
```

Page numbers are drawn in a second pass over the buffered pages:

```js
const range = doc.bufferedPageRange();
for (let i = range.start; i < range.start + range.count; i++) {
  doc.switchToPage(i);
  doc.page.margins.bottom = 0;   // see the pitfall below
  doc.font("cjk").fontSize(9).text(
    \`第 \${i + 1} 页 / 共 \${range.count} 页\`,
    doc.page.margins.left, doc.page.height - 40,
    { width: doc.page.width - doc.page.margins.left - doc.page.margins.right, align: "center", lineBreak: false },
  );
}
```

**Pitfall, measured:** writing a footer below `page.maxY()` makes PDFKit **add a page** instead of drawing outside the margin. A two-page document became a four-page file, every page carrying a page number — plausible-looking output with wrong pagination. Either zero the bottom margin while drawing the footer (as above) or position it inside the content area, then assert the page count with `check_pdf.mjs --count`, where the expected count is the one your script computed.

**Tables are drawn by hand.** PDFKit has no table primitive: lay out columns as rectangles plus per-cell text, and decide row heights yourself. Keep them inside the content width and avoid splitting a row across pages unless you handle the page break explicitly.

## Verify before delivering

```bash
node "${ZCODE_SKILL_DIR}/../../scripts/check_pdf.mjs" report.pdf --count 7 --size A4 --text source.txt --contains "结论"
```

The checker reads the PDF structure and exit-codes 0 (pass) or 1 (fail), printing a JSON report on stdout: page objects vs `--count`, page-tree consistency, page size, font embedding and subsetting, `/ToUnicode` presence, and the document's text layer (`--contains`, `--text`). Fix the source and re-run until it passes; never deliver a build whose check failed.

**No visual check is performed by this checker, and it says so** (`summary.visualCheck` = `not_performed`). Rendering is an optional enhancement, not a core dependency: converting the PDF to page images needs an external renderer (LibreOffice, Ghostscript, Poppler). When the user asks for a visual check and one of those is installed, render to PNG and dispatch `visual-judge`; when none is installed, **say plainly that pagination and layout were not visually inspected** rather than implying they were. Give the user the install command if they want it — the choice is theirs.

## Boundaries

- **No LaTeX, no math typesetting.** PDFKit places text and vector graphics; it has no formula engine. Do not claim a mathematical deliverable. Unicode math symbols the chosen font covers (superscripts, Greek letters, ∑, ∫) can be written as text, but a real formula with fractions, matrices, or equation numbering is out of scope for this skill — say so and offer an alternative.
- **Office→PDF conversion is a different path.** Use the docx/pptx/xlsx skills and LibreOffice conversion; do not rebuild an Office document from scratch here.
- **Complex layouts** (multi-column magazines, posters, covers) need manual geometry. That is achievable but expensive; state the trade-off before spending the effort.
- **Do not install anything** to make any of the above work, and do not block delivery on an optional renderer.
