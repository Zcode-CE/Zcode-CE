---
name: docx
description: Create, read, edit, and check Word documents (.docx), including reports, letters, and formatted tables. Use when a DOCX file is an input or requested deliverable.
metadata:
  upstream: "@deepseek-ai/dsh-skill-office (MIT)"
  modified: "ZCode-CE: 工具引用改为系统 Python 与文件路径交付，见 NOTICE.md"
---

# Word documents

Use `python-docx` for DOCX creation and ordinary edits. Follow an explicit user or applicable AGENTS.md requirement for a project environment or another library.

This build has no managed Python provisioning tool. Use the system `python3` (verify with `command -v python3`), and check the library before the first write:

```bash
python3 -c "import docx" || python3 -m pip install --user python-docx
```

Install only when the missing dependency actually blocks the requested operation, and report it to the user when you do. Prefer an already-configured environment (virtualenv, conda, project interpreter) when the workspace provides one.

Keep source scripts, intermediate files, and final documents in the task workspace; the runtime and this skill directory are read-only resources. Use the user's requested language and preserve an existing document's design unless a redesign is requested.

## Create and edit

For existing files, inspect paragraphs, runs, tables, sections, headers, and footers before changing the affected content. Save to a new file unless the user requests an in-place edit. Replacing a paragraph's `.text` destroys its run formatting; change the relevant runs when formatting must survive. Reconstructing the whole document can lose features outside python-docx's supported editing API.

Use paragraph styles for headings and body text. Size tables for the section that contains them, and account for merged cells and nested tables. Chinese, Japanese, and Korean text may need an explicit `w:eastAsia` font assignment in addition to `run.font.name`; font names alone do not establish glyph availability or rendered appearance.

For a new document, use the selected Python executable:

```python
from docx import Document

document = Document()
document.add_heading("Project report", level=0)
document.add_paragraph("Summary", style="Heading 1")
document.add_paragraph("The requested findings go here.")
document.save("report.docx")
```

python-docx does not paginate or render documents. Do not represent ordinary replacement, colored text, or comments as tracked changes. When real revisions or unsupported OOXML features matter, preserve their package parts and verify the requested operation rather than silently discarding them.

## Check and deliver

Run the shared checker with the selected Python executable; `<skill-directory>` is this loaded skill's resource base:

```text
<python> <skill-directory>/../scripts/check_office.py <document.docx> --out <checks.json>
```

It checks ZIP/XML integrity and internal relationships, and reports paragraphs, logical table dimensions, and sections. Optional `--contains TEXT` arguments assert required text. A successful structural check does not verify pagination, clipping, fonts, or visual appearance. Compare the summary and reopened document with the user's request, including unchanged content that matters to an edit.

This build has no document-rendering tool, so visual layout cannot be inspected by default. Complete the structural and content checks above, deliver the document, and briefly state that visual layout was not inspected.

If the user explicitly asks for a visual check, convert to PDF with LibreOffice when `soffice` is on PATH and let the user review the result:

```bash
soffice --headless --convert-to pdf report.docx
```

Do not require the user to install a renderer. When rendering is unavailable, preserve the usable document and report the inspection limit rather than blocking delivery.

Use the available rendering tool for this check. Review `warnings` such as missing fonts. LibreOffice pagination can differ from Microsoft Word. If rendering is unavailable or fails, preserve the usable document and report the inspection limit; do not require the user to install a renderer.

This build has no file-presentation tool. Provide the final DOCX path in your reply and keep the file in place so the user can open it directly. Do not create temporary QA reports unless the user asks for them.
