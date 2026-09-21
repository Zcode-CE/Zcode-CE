---
name: pptx
metadata:
  upstream: "@deepseek-ai/dsh-skill-office (MIT)"
  modified: "ZCode-CE: 工具引用改为系统 Python 与文件路径交付，见 NOTICE.md"
description: Create, read, edit, and check PowerPoint presentations (.pptx), including slide text, tables, images, and charts. Use when a PPTX file is an input or requested deliverable.
---

# PowerPoint presentations

Follow an explicit user or applicable AGENTS.md requirement for an environment or library.

This build has no managed Python provisioning tool. Use the system `python3` (verify with `command -v python3`), and check the library before the first write:

```bash
python3 -c "import python-pptx" || python3 -m pip install --user python-pptx
```

Install only when the missing dependency actually blocks the requested operation, and report it to the user when you do. Prefer an already-configured environment (virtualenv, conda, project interpreter) when the workspace provides one.

Keep scripts and output files in the task workspace. The runtime and skill directory contain shared read-only resources. Match the requested slide language and the supplied presentation's design when editing it.

## Create and edit

Use `python-pptx` to inspect or modify an existing presentation. Inspect slide layouts, text runs, images, tables, and charts before editing. Change only the requested content, preserve mixed text formatting, and save to a new file unless the user requests an in-place edit. Rebuilding slides can discard unsupported animation, SmartArt, or other extension content.

For a new deck, use `python-pptx` with editable text, tables, and charts. Use local image assets rather than network-dependent image URLs. Set slide dimensions, text sizes, and chart data explicitly.

A minimal editable deck, run with the selected Python executable:

```python
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE
from pptx.util import Inches, Pt

presentation = Presentation()
presentation.slide_width = Inches(13.333)
presentation.slide_height = Inches(7.5)
slide = presentation.slides.add_slide(presentation.slide_layouts[6])
title = slide.shapes.add_textbox(Inches(0.6), Inches(0.4), Inches(12), Inches(0.8))
run = title.text_frame.paragraphs[0].add_run()
run.text = "Quarterly report"
run.font.size = Pt(30)
data = CategoryChartData()
data.categories = ["Q1", "Q2"]
data.add_series("Revenue", [12, 18])
slide.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED,
                       Inches(0.8), Inches(1.6), Inches(11.5), Inches(4.8), data)
presentation.save("report.pptx")
```

Use `Inches` or `Cm` for positions and sizes and `Pt` for font sizes. To edit a generated title while retaining its other slides and charts:

```python
from pptx import Presentation

presentation = Presentation("report.pptx")
for shape in presentation.slides[0].shapes:
    if shape.has_text_frame and shape.text == "Quarterly report":
        shape.text_frame.paragraphs[0].runs[0].text = "Quarterly results"
presentation.save("report-edited.pptx")
```

Check that text and images fit the slide dimensions, titles form a useful sequence, and chart labels agree with source values. A native chart's embedded workbook is part of the deliverable and must contain the intended data. Library support for writing PPTX is not a rendering engine or a guarantee that every PowerPoint feature survives editing.

## Check and deliver

Run the shared checker with the selected Python executable; `<skill-directory>` is this loaded skill's resource base:

```text
<python> <skill-directory>/../scripts/check_office.py <presentation.pptx> --out <checks.json>
```

It checks ZIP/XML integrity and internal relationships and reports slide count and extracted text. Use repeated `--contains TEXT` arguments for required slide text and `--count N` for a requested slide count; `--contains` excludes chart text and speaker notes. Reopen the file to check the requested edits, chart data, and notes. Structural success does not establish text fit, alignment, readable contrast, or rendering fidelity.

This build has no document-rendering tool, so visual layout cannot be inspected by default. Complete the structural and content checks above, deliver the file, and briefly state that visual layout was not inspected.

If the user explicitly asks for a visual check, convert to PDF with LibreOffice when `soffice` is on PATH and let the user review the result:

```bash
soffice --headless --convert-to pdf report.pptx
```

Do not require the user to install a renderer. When rendering is unavailable, preserve the usable file and report the inspection limit rather than blocking delivery.

Use the available rendering tool for this check. Inspect `warnings`, especially missing fonts. LibreOffice previews do not certify pixel-identical PowerPoint or Keynote output, animation, or media playback. If the rendering tool is unavailable or fails, retain the usable source and report the inspection limit; do not require the user to install another tool.

This build has no file-presentation tool. Provide the final PPTX path in your reply and keep the file in place so the user can open it directly. Do not create intermediate images or QA reports unless the user asks for them.
