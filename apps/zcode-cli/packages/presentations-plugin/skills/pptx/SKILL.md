---
name: pptx
metadata:
  upstream: "@deepseek-ai/dsh-skill-office (MIT)"
  modified: "ZCode-CE: 工具链由系统 Python(python-pptx) 改为随包 Node 库(pptxgenjs 4.0.1)；修正校验器相对路径为 ../../scripts/；补充降级边界，见 docs/development/office-plugins.md"
description: Create, read, edit, and check PowerPoint presentations (.pptx), including slide text, tables, images, and charts. Use when a PPTX file is an input or requested deliverable.
---

# PowerPoint presentations

Create PPTX files with the bundled `pptxgenjs` library, loaded from this plugin's own payload. Follow an explicit user or applicable AGENTS.md requirement for an environment or library.

## Runtime

The library ships with the plugin at `<skill-directory>/../../scripts/office-node/pptxgenjs.cjs`, a self-contained bundle. `<skill-directory>` is this loaded skill's resource base, and `${ZCODE_SKILL_DIR}` expands to the same path.

```js
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const PptxGenJS = require("${ZCODE_SKILL_DIR}/../../scripts/office-node/pptxgenjs.cjs");
```

The anchor must be the bundle file itself. Do **not** point `createRequire` at a `node_modules` directory next to the skill, and do not expect a bare `require("pptxgenjs")` to resolve: Node searches `node_modules` only in *ancestor* directories, and this payload is a sibling of `skills/`, so such a lookup fails with `MODULE_NOT_FOUND`.

**Never install anything.** Do not run `npm install` / `pnpm add` / `pip install`, do not fetch a package, and do not rewrite this skill to make a dependency appear. The payload is provided by the plugin; a missing bundle means the build is incomplete, not that a package needs installing. Report that instead.

Keep source scripts, intermediate files, and final decks in the task workspace; the runtime and this skill directory are read-only resources. Match the requested slide language and the supplied presentation's design when editing it.

## Create

For a new deck, use editable text, tables, and charts. Use local image assets rather than network-dependent image URLs. Set slide dimensions, text sizes, and chart data explicitly.

```js
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const PptxGenJS = require("${ZCODE_SKILL_DIR}/../../scripts/office-node/pptxgenjs.cjs");

const presentation = new PptxGenJS();
presentation.defineLayout({ name: "WIDE", width: 13.333, height: 7.5 });
presentation.layout = "WIDE";
const slide = presentation.addSlide();
slide.addText("Quarterly report", { x: 0.6, y: 0.4, w: 12, h: 0.8, fontSize: 30 });
slide.addChart(presentation.ChartType.bar, [{ name: "Revenue", labels: ["Q1", "Q2"], values: [12, 18] }], {
  x: 0.8, y: 1.6, w: 11.5, h: 4.8,
});
await presentation.writeFile({ fileName: "report.pptx" });
```

Use inches for positions and sizes and points for font sizes. Set fonts explicitly on every run rather than relying on inherited theme fonts.

Check that text and images fit the slide dimensions, titles form a useful sequence, and chart labels agree with source values. A native chart's embedded workbook is part of the deliverable and must contain the intended data.

## Edit an existing presentation

**The bundled library is a generator: it has no read or edit API.** It cannot open an existing PPTX. `python-pptx`-style operations (inspect layouts, runs, images, tables, charts, then change only the requested content) are not available here.

Therefore:

- **Light, precisely-locatable edits are acceptable** only when you can do them without guessing — e.g. a text substitution the user spelled out, applied to the raw package with your own ZIP + XML handling. Verify the result by reopening the file and re-reading the affected content.
- **Heavy or structural editing of an existing PPTX is not supported by this build.** Do not attempt it by reconstructing the deck, and do not silently discard parts you cannot represent (animations, SmartArt, and other extension content are the usual casualties).
- When a request needs editing beyond that boundary, **say so plainly**: tell the user the current build cannot edit an existing PPTX reliably, state what you *can* do (create a new deck, or apply the specific precise change if it is safe), and ask how to proceed. Never present a rebuilt deck as a faithful edit of theirs.

A deeper editing capability is planned as an optional enhancement; it is not part of this version.

## Check and deliver

Run the shared checker with Node; `<skill-directory>` is this loaded skill's resource base:

```text
node ${ZCODE_SKILL_DIR}/../../scripts/check_office.mjs <presentation.pptx> --out <checks.json>
```

It checks ZIP/XML integrity and internal relationships and reports slide count and extracted text. Use repeated `--contains TEXT` arguments for required slide text and `--count N` for a requested slide count; `--contains` excludes chart text and speaker notes. Reopen the file to check the requested edits, chart data, and notes. Structural success does not establish text fit, alignment, readable contrast, or rendering fidelity.

This build has no document-rendering tool, so visual layout cannot be inspected by default. Complete the structural and content checks above, deliver the file, and briefly state that visual layout was not inspected.

If the user explicitly asks for a visual check, convert to PDF with LibreOffice when `soffice` is on PATH and let the user review the result:

```bash
soffice --headless --convert-to pdf report.pptx
```

Rendering is an **optional enhancement, not a core dependency**: creating and structurally checking this file needs nothing beyond the bundled payload. When `soffice` is absent, do not silently skip the check — say plainly that visual layout was not inspected.

If the user wants rendering and `soffice` is missing, **tell them it needs LibreOffice and offer the install** (roughly several hundred MB); the choice is theirs. Do not install it unprompted, and do not block delivery on it. On Linux you usually **cannot install it for them** (no TTY, `sudo` needs a password) — give the command for the user to run. Using software they already have (Word, WPS, Pages) to produce a PDF is a legitimate path; do not steer them away from it.

LibreOffice previews do not certify pixel-identical PowerPoint output, animation, or media playback.

This build has no file-presentation tool. Provide the final PPTX path in your reply and keep the file in place so the user can open it directly. Do not create intermediate images or QA reports unless the user asks for them.