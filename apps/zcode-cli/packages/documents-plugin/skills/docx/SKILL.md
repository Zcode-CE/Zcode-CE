---
name: docx
description: Create, read, edit, and check Word documents (.docx), including reports, letters, and formatted tables. Use when a DOCX file is an input or requested deliverable.
metadata:
  upstream: "@deepseek-ai/dsh-skill-office (MIT)"
  modified: "ZCode-CE: 工具链由系统 Python(python-docx) 改为随包 Node 库(docx 9.7.1)；修正校验器相对路径为 ../../scripts/；补充降级边界；提权安装场景改为给出确切命令并声明所需权限（引导式授权，见 docs/development/office-plugins.md）"
---

# Word documents

Create DOCX files with the bundled `docx` library (docx-js), loaded from this plugin's own payload. Follow an explicit user or applicable AGENTS.md requirement for a project environment or another library.

## Runtime

The library ships with the plugin at `<skill-directory>/../../scripts/office-node/docx.cjs`, a self-contained bundle. `<skill-directory>` is this loaded skill's resource base, and `${ZCODE_SKILL_DIR}` expands to the same path.

```js
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require(
  "${ZCODE_SKILL_DIR}/../../scripts/office-node/docx.cjs",
);
```

The anchor must be the bundle file itself. Do **not** point `createRequire` at a `node_modules` directory next to the skill, and do not expect a bare `require("docx")` to resolve: Node searches `node_modules` only in *ancestor* directories, and this payload is a sibling of `skills/`, so such a lookup fails with `MODULE_NOT_FOUND`.

**Never install anything.** Do not run `npm install` / `pnpm add` / `pip install`, do not fetch a package, and do not rewrite this skill to make a dependency appear. The payload is provided by the plugin; a missing bundle means the build is incomplete, not that a package needs installing. Report that instead.

Keep source scripts, intermediate files, and final documents in the task workspace; the runtime and this skill directory are read-only resources. Use the user's requested language and preserve an existing document's design unless a redesign is requested.

## Create

Use paragraph styles for headings and body text. Size tables for the section that contains them, and account for merged cells and nested tables. Chinese, Japanese, and Korean text needs an explicit `eastAsia` font in addition to the ASCII font; font names alone do not establish glyph availability or rendered appearance.

```js
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require(
  "${ZCODE_SKILL_DIR}/../../scripts/office-node/docx.cjs",
);

const document = new Document({
  styles: { default: { document: { run: { font: { eastAsia: "SimSun" } } } } },
  sections: [
    {
      children: [
        new Paragraph({ text: "\u201cProject report\u201d", heading: HeadingLevel.HEADING_1 }),
        new Paragraph({ text: "Summary", heading: HeadingLevel.HEADING_2 }),
        new Paragraph({ children: [new TextRun("The requested findings go here.")] }),
      ],
    },
  ],
});
writeFileSync("report.docx", await Packer.toBuffer(document));
```

Escape Chinese curly quotes as `\u201c` / `\u201d` / `\u2018` / `\u2019`; a raw `"` inside a double-quoted JS string breaks the script. Use `Packer.toBuffer()` for an in-memory buffer or `Packer.toBase64String()` when you need a string.

## Edit an existing document

**The bundled library is a generator: it has no read or edit API** (`Document.load` does not exist; there is no `load`/`parse`/`read` export). It cannot open an existing DOCX at all.

Therefore:

- **Light, precisely-locatable edits are acceptable** only when you can do them without guessing — e.g. a text substitution the user spelled out, applied to the raw package with your own ZIP + XML handling. Verify the result by reopening the file and re-reading the affected content.
- **Heavy or structural editing of an existing DOCX is not supported by this build.** Do not attempt it by reconstructing the document, and do not silently discard parts you cannot represent.
- When a request needs editing beyond that boundary, **say so plainly**: tell the user the current build cannot edit an existing DOCX reliably, state what you *can* do (create a new document, or apply the specific precise change if it is safe), and ask how to proceed. Never present a rewritten document as a faithful edit of theirs.

python-docx-style operations are not available here, so "inspect paragraphs, runs, tables, sections, headers and footers before changing the affected content" is not a reachable workflow in this build. A deeper editing capability is planned as an optional enhancement; it is not part of this version.

## Check and deliver

Run the shared checker with Node; `<skill-directory>` is this loaded skill's resource base:

```text
node ${ZCODE_SKILL_DIR}/../../scripts/check_office.mjs <document.docx> --out <checks.json>
```

It checks ZIP/XML integrity and internal relationships, and reports paragraphs, logical table dimensions, and sections. Optional `--contains TEXT` arguments assert required text. Exit code 0 means the checks passed, 1 means a document, assertion, or report-write failure, and 2 means invalid arguments. A successful structural check does not verify pagination, clipping, fonts, or visual appearance. Compare the summary and reopened document with the user's request, including unchanged content that matters to an edit.

This build has no document-rendering tool, so visual layout cannot be inspected by default. Complete the structural and content checks above, deliver the document, and briefly state that visual layout was not inspected.

If the user explicitly asks for a visual check, convert to PDF with LibreOffice when `soffice` is on PATH and let the user review the result:

```bash
soffice --headless --convert-to pdf report.docx
```

Rendering is an **optional enhancement, not a core dependency**: creating and structurally checking this document needs nothing beyond the bundled payload. When `soffice` is absent, do not silently skip the check — say plainly that visual layout was not inspected.

If the user wants rendering and `soffice` is missing, **tell them it needs LibreOffice and offer the install** (roughly several hundred MB); the choice is theirs. Do not install it unprompted, and do not block delivery on it. On Linux you usually **cannot install it for them** (no TTY, `sudo` needs a password) — give the command for the user to run.

When you give that command, put it in a **bash code block** and state plainly what it needs, so the user can judge before running it. The interface offers a "send to terminal" action on shell code blocks that pastes the command into the integrated terminal **without running it** — the user reviews it there and presses Enter themselves. Say so when you offer the command. Name the privilege explicitly: an install needs administrator rights, so give the `sudo` form and say it will ask for the account password. Do **not** ask the user to paste their password into the chat, and do not offer to run it for them.

```bash
sudo apt-get install -y libreoffice
```

That is the Debian/Ubuntu form; adapt it to the user's platform and package manager rather than assuming `apt`. Using software they already have (Word, WPS, Pages) to produce a PDF is a legitimate path; do not steer them away from it.

LibreOffice pagination can differ from Microsoft Word.

This build has no file-presentation tool. Provide the final DOCX path in your reply and keep the file in place so the user can open it directly. Do not create temporary QA reports unless the user asks for them.
