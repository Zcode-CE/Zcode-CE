#!/usr/bin/env python3
# --- 来源与归属（改本文件前先读 docs/development/office-plugins.md） ---
# Upstream:  @deepseek-ai/dsh-skill-office (MIT)
#            packages/skill/skill-office/assets/scripts/check_office.py
# Baseline:  13,217 bytes, sha256 d94afa67593a284751e0f2dc000877e836f885d39954a882033cf22a13278f66
#            (deepseek-harness 0.1.7-alpha.2；0.1.6 起该文件未变)
# Modified:  ZCode-CE —— 已与上游分叉；三份同名副本（documents/presentations/spreadsheets）
#            必须逐字节相同，改一处就要同步三处
# Local changes（追加式：只新增常量/类/函数，未改上游函数签名与语义，故上游更新可手工合并）:
#   1) 成员白名单 XML_MEMBER_SUFFIXES + is_xml_member()：只把 .xml / .rels 当作结构成员
#   2) 资源预算 MAX_MEMBER_BYTES(64MiB) / MAX_TOTAL_BYTES(256MiB) /
#      MAX_MEMBER_ELEMENTS(2000000) / MAX_TOTAL_ELEMENTS(4000000) + class PackageBudget
#      —— 修复无界解压（实测 2.09MB 的 ZIP 可解出 2GiB、子进程峰值 RSS 4116MiB）
#   3) PARSE_CHUNK_BYTES(1MiB) 分块解析；失败也给出结构化错误而不是空 stdout
#   4) 2026-09-23：except 列表补 LookupError（含子类 IndexError）。未知 encoding 的成员会让
#      ET 抛 LookupError，而它不属于上面任何一类 → 逃逸成「退出码 1 + 空 stdout + 裸
#      traceback」，正是第 3 条要消灭的形态（OFFICE-CHECKER-JS.md §5.4 记录了该缺陷）
# 状态:      本文件是 **Node 主路径之外的保留实现**（技能正文只引用 check_office.mjs）。
#            保留理由：① 作为 JS 重写的**行为基准**（对比测试与 fuzz 都以它为准）；
#            ② docs/development/office-plugins.md §8 把 Python 定位为「按需增强」路径。
#            因此它必须与 .mjs **保持契约一致**：改一边要同时核对另一边。
# 回归测试: apps/zcode-cli/packages/documents-plugin/test/checkOffice.test.mjs
# ---------------------------------------------------------------------------
"""Read-only OOXML checks and structural summaries; no rendering or formula evaluation.

Run with INPUT.docx, INPUT.pptx, or INPUT.xlsx. Optional --contains assertions
check extracted text; DOCX excludes comments, glossary text, and unreferenced parts or notes.
--count checks slides or sheets. JSON escapes non-ASCII
characters and goes to stdout and optionally --out. Exit 0 means the requested
structural checks passed, 1 means a document, assertion, or report write failed, and 2 means
invalid command-line arguments.

The input is treated as untrusted: decompression is bounded by the MAX_* budgets below,
and any failure — including running out of memory — is reported as a structured fail
check with a readable detail instead of an empty stdout.
"""

from __future__ import annotations

import argparse
import json
import posixpath
import sys
import zipfile
import zlib
from pathlib import Path
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree as ET

W_NAMESPACES = (
    "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "http://purl.oclc.org/ooxml/wordprocessingml/main",
)
A_NAMESPACES = (
    "http://schemas.openxmlformats.org/drawingml/2006/main",
    "http://purl.oclc.org/ooxml/drawingml/main",
)
P_NAMESPACES = (
    "http://schemas.openxmlformats.org/presentationml/2006/main",
    "http://purl.oclc.org/ooxml/presentationml/main",
)
S_NAMESPACES = (
    "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "http://purl.oclc.org/ooxml/spreadsheetml/main",
)
R_NAMESPACES = (
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "http://purl.oclc.org/ooxml/officeDocument/relationships",
)
MAIN_PARTS = {
    ".docx": ("word/document.xml", "wordprocessingml.document.main+xml"),
    ".pptx": ("ppt/presentation.xml", "presentationml.presentation.main+xml"),
    ".xlsx": ("xl/workbook.xml", "spreadsheetml.sheet.main+xml"),
}
# 只有这两类成员会被读进内存并解析；其余成员（图片、嵌入对象等）本脚本从不读取，
# 只被 testzip() 以 1 MiB 分块做 CRC 校验，内存有界。预算必须**只**作用于这个集合：
# 若把图片也算进总预算，一份 150 MB 的扫描件文档就会被误判为超预算而拒收（实测）。
XML_MEMBER_SUFFIXES = (".xml", ".rels")


def is_xml_member(name: str) -> bool:
    """成员是否会被读入内存解析；预算与读取路径共用，避免两处判断漂移。"""
    return name.endswith(XML_MEMBER_SUFFIXES)

# 资源预算（S5 安全修复）。为什么必须有：本脚本的调用方是 LLM agent（见
# skills/docx/SKILL.md 的「Check and deliver」一节），输入来自用户文档或网络下载，
# 属**不可信输入**。修复前对解压体积没有任何约束，安全复查实测 2.09 MB 的 ZIP 可解出
# 2 GiB、子进程峰值 RSS 4116 MiB（放大比约 2000:1）；agent 是独立子进程，OOM 会连带
# 拖垮正在编辑的文档会话（未保存即丢失工作）。
#
# 为什么同时设「字节」和「元素」两条线：字节预算管不住「小体积、多元素」的 XML。
# 实测一个声明体积仅 67.1 MB 的成员能解析出 1677 万个元素、峰值 RSS 1583 MiB
# （ElementTree 每元素约 100 字节），仅按字节设限仍可 OOM。元素预算才是真正约束
# 峰值内存的那条线，字节预算负责拦住巨型部件、并在解压前就拒绝 ZIP bomb。
MAX_MEMBER_BYTES = 64 * 1024 * 1024
MAX_TOTAL_BYTES = 256 * 1024 * 1024
MAX_MEMBER_ELEMENTS = 2_000_000
MAX_TOTAL_ELEMENTS = 4_000_000
# 分块喂给 XMLPullParser 的粒度；配合元素预算让解析能在超限时立即停下。
PARSE_CHUNK_BYTES = 1024 * 1024


class PackageBudget:
    """整个包共享的元素解析预算，避免「每个成员都不超限、合起来超限」。"""

    def __init__(self) -> None:
        self.elements = 0


def namespace(root: ET.Element, supported: tuple[str, ...], part: str) -> str:
    """Return the main XML namespace after checking its OOXML variant."""
    uri = root.tag[1:].split("}", 1)[0] if root.tag.startswith("{") else ""
    if uri not in supported:
        raise ValueError(f"{part} uses unsupported XML namespace: {uri or '(none)'}")
    return "{" + uri + "}"


def relationship_id(node: ET.Element, part: str) -> str:
    """Read an office-document relationship id from Transitional or Strict OOXML."""
    for uri in R_NAMESPACES:
        value = node.get("{" + uri + "}id")
        if value is not None:
            return value
    raise ValueError(f"{part} has a reference without a relationship id")


def relationship_types(kind: str) -> set[str]:
    """Return the Transitional and Strict relationship type names for one role."""
    return {f"{uri}/{kind}" for uri in R_NAMESPACES}


def iter_namespaces(root: ET.Element, namespaces: tuple[str, ...], local_name: str):
    """Iterate matching elements across Transitional and Strict namespaces."""
    for uri in namespaces:
        yield from root.iter("{" + uri + "}" + local_name)


def relationship_target(part: str, target: str) -> str:
    """Resolve a package relationship without fetching external resources."""
    path = unquote(urlsplit(target).path)
    return posixpath.normpath(path.lstrip("/") if path.startswith("/") else posixpath.join(posixpath.dirname(part), path))


def relationships(part: str, xml: dict[str, ET.Element], types: set[str] | None = None) -> dict[str, str]:
    path = posixpath.join(posixpath.dirname(part), "_rels", posixpath.basename(part) + ".rels")
    root = xml.get(path)
    if root is None:
        return {}
    return {
        rel.attrib["Id"]: relationship_target(part, rel.attrib["Target"])
        for rel in root if rel.get("TargetMode") != "External" and (types is None or rel.get("Type") in types)
    }


def related_xml(part: str, reference: str, links: dict[str, str], xml: dict[str, ET.Element]) -> ET.Element:
    """Read a related XML part with diagnostics naming its source and reference."""
    if reference not in links:
        raise ValueError(f"{part} references missing relationship: {reference}")
    target = links[reference]
    if target not in xml:
        raise ValueError(f"{part} relationship {reference} targets a non-XML member: {target}")
    return xml[target]


def assert_within_byte_budget(archive: zipfile.ZipFile) -> None:
    """Reject the package on its declared member sizes before any content is read.

    为什么先算总量再读：ZIP 放大比可达 1000:1 以上，等成员已经进内存再判断就已经 OOM 了，
    所以这条检查必须排在 testzip() 和所有 read() 之前。
    为什么逐成员也要判：总量不超时，单个巨型部件仍可独占全部内存。
    为什么只统计 XML 成员：见 is_xml_member 的说明 —— 把图片算进来会误伤正常的大文档。
    为什么按声明体积判断是安全的：archive.read() 被 ZipInfo.file_size 硬截断（实测），
    所以「声明体积」就是单个成员真正能被读进内存的上限；谎报更小的体积只会让成员读不全，
    并在 CRC 校验上失败，不会绕过预算。
    """
    total = 0
    for info in archive.infolist():
        if not is_xml_member(info.filename):
            continue
        if info.file_size > MAX_MEMBER_BYTES:
            raise ValueError(
                f"ZIP member {info.filename} declares {info.file_size} bytes, "
                f"over the {MAX_MEMBER_BYTES} byte per-member limit"
            )
        total += info.file_size
    if total > MAX_TOTAL_BYTES:
        raise ValueError(
            f"ZIP XML members declare {total} bytes in total, "
            f"over the {MAX_TOTAL_BYTES} byte decompression budget"
        )


def parse_xml_member(name: str, data: bytes, budget: PackageBudget) -> ET.Element:
    """Parse one XML member into an element tree under the shared element budget.

    为什么不用 ET.fromstring：它一次性建完整棵树，超限时内存已经吃满，只能在事后抛
    MemoryError（修复前 2 GiB 夹具上正是如此）。这里改用 XMLPullParser 分块喂入、边解析
    边计数，一旦超预算立刻停止喂数据。实测同一 64 MiB 夹具：提前中止峰值 RSS 255 MiB，
    不中止则需约 1600 MiB。解析结果与 ET.fromstring 等价（已用 tostring 逐字节比对）。
    """
    parser = ET.XMLPullParser(events=("start",))
    root = None
    count = 0
    for offset in range(0, len(data), PARSE_CHUNK_BYTES):
        parser.feed(data[offset:offset + PARSE_CHUNK_BYTES])
        for _event, element in parser.read_events():
            if root is None:
                root = element
            count += 1
            if count > MAX_MEMBER_ELEMENTS:
                raise ValueError(f"{name}: XML element count exceeds the {MAX_MEMBER_ELEMENTS} element per-member limit")
            if budget.elements + count > MAX_TOTAL_ELEMENTS:
                raise ValueError(f"package XML element count exceeds the {MAX_TOTAL_ELEMENTS} element budget at {name}")
    parser.close()
    if root is None:
        # 与 ET.fromstring 的行为对齐：空成员报同一个可读错误，而不是返回 None 让下游崩。
        raise ET.ParseError(f"{name}: no element found")
    budget.elements += count
    return root


def failure_detail(error: BaseException) -> str:
    """Return a non-empty detail so callers can always tell what failed.

    为什么需要：MemoryError 的 str() 是空串。修复前 except 列表不含
    MemoryError / OverflowError / RecursionError，2 GiB 夹具上 OverflowError 直接逃逸，
    结果是「退出码 1 但 stdout 为空」，调用方无法区分「文档结构不合法」与「检查器崩了」。
    """
    message = str(error).strip()
    return message if message else f"{type(error).__name__} while reading the package"


def inspect_docx(xml: dict[str, ET.Element]) -> tuple[dict, str]:
    part = "word/document.xml"
    root = xml[part]
    w = namespace(root, W_NAMESPACES, part)
    body = root.find(f"{w}body")
    if body is None:
        raise ValueError("word/document.xml has no document body")
    tables = []
    for table in body.iter(f"{w}tbl"):
        grid = table.findall(f"{w}tblGrid/{w}gridCol")
        rows = table.findall(f"{w}tr")
        # Merged cells span logical grid columns; counting physical cells loses them.
        columns = len(grid) if grid else max((sum(
            int(cell.find(f"{w}tcPr/{w}gridSpan").get(f"{w}val", "1"))
            if cell.find(f"{w}tcPr/{w}gridSpan") is not None else 1
            for cell in row.findall(f"{w}tc")
        ) for row in rows), default=0)
        tables.append({"rows": len(rows), "columns": columns})
    sections = []
    for section in body.iter(f"{w}sectPr"):
        size = section.find(f"{w}pgSz")
        margins = section.find(f"{w}pgMar")
        sections.append({
            "page_twips": {} if size is None else {key.removeprefix(w): value for key, value in size.attrib.items()},
            "margins_twips": {} if margins is None else {key.removeprefix(w): value for key, value in margins.attrib.items()},
        })
    text_parts = [body]
    for kind in ("header", "footer"):
        links = relationships(part, xml, relationship_types(kind))
        for section in body.iter(f"{w}sectPr"):
            for reference in section.findall(f"{w}{kind}Reference"):
                text_parts.append(related_xml(part, relationship_id(reference, part), links, xml))
    for kind in ("footnote", "endnote"):
        references = {node.attrib[f"{w}id"] for node in body.iter(f"{w}{kind}Reference")}
        if not references:
            continue
        links = relationships(part, xml, relationship_types(f"{kind}s"))
        for reference in links:
            tree = related_xml(part, reference, links, xml)
            text_parts.extend(note for note in tree.findall(f"{w}{kind}") if note.get(f"{w}id") in references)
    text = "\n".join("".join(node.text or "" for node in paragraph.iter(f"{w}t")) for tree in text_parts
                     for paragraph in tree.iter(f"{w}p"))
    return {"paragraphs": len(list(body.iter(f"{w}p"))), "tables": tables, "sections": sections}, text


def inspect_pptx(xml: dict[str, ET.Element]) -> tuple[dict, str]:
    part = "ppt/presentation.xml"
    links = relationships(part, xml)
    root = xml[part]
    p = namespace(root, P_NAMESPACES, part)
    slides = root.findall(f"{p}sldIdLst/{p}sldId")
    texts = []
    for slide in slides:
        reference = relationship_id(slide, part)
        tree = related_xml(part, reference, links, xml)
        texts.append("\n".join("".join(node.text or "" for node in iter_namespaces(paragraph, A_NAMESPACES, "t"))
                               for paragraph in iter_namespaces(tree, A_NAMESPACES, "p")))
    return {"slides": len(slides)}, "\n".join(texts)


def inspect_xlsx(xml: dict[str, ET.Element]) -> tuple[dict, str]:
    part = "xl/workbook.xml"
    links = relationships(part, xml)
    root = xml[part]
    s = namespace(root, S_NAMESPACES, part)
    sheets = []
    texts = []
    shared = xml.get("xl/sharedStrings.xml")
    shared_s = s if shared is None else namespace(shared, S_NAMESPACES, "xl/sharedStrings.xml")
    shared_strings = [] if shared is None else [
        "".join(node.text or "" for node in item.iter(f"{shared_s}t")) for item in shared.iter(f"{shared_s}si")
    ]
    for sheet in root.findall(f"{s}sheets/{s}sheet"):
        reference = relationship_id(sheet, part)
        tree = related_xml(part, reference, links, xml)
        sheet_s = namespace(tree, S_NAMESPACES, links[reference])
        cells = list(tree.iter(f"{sheet_s}c"))
        formulas = sum(cell.find(f"{sheet_s}f") is not None for cell in cells)
        sheets.append({"name": sheet.attrib["name"], "cells": len(cells), "formulas": formulas})
        for cell in cells:
            if cell.get("t") == "s":
                value = cell.findtext(f"{sheet_s}v", "")
                location = f"{links[reference]} cell {cell.get('r', '(no reference)')}"
                try:
                    index = int(value)
                except ValueError as error:
                    raise ValueError(f"{location}: invalid shared string index {value!r}") from error
                if not 0 <= index < len(shared_strings):
                    raise ValueError(f"{location}: shared string index out of range: {index}")
                texts.append(shared_strings[index])
        texts.extend("".join(node.text or "" for node in cell.iter(f"{sheet_s}t")) for cell in cells)
        texts.extend(cell.findtext(f"{sheet_s}v", "") for cell in cells if cell.get("t") == "str")
        texts.append(sheet.attrib["name"])
    return {"sheets": sheets, "formulas_evaluated": False}, "\n".join(texts)


def inspect(path: Path) -> tuple[dict, str]:
    """Validate package members and relationships before inspecting the main part."""
    main, content_type = MAIN_PARTS[path.suffix.lower()]
    with zipfile.ZipFile(path) as archive:
        # 顺序要紧：体积预算必须排在 testzip() 与所有 read() 之前，否则解压已经发生。
        assert_within_byte_budget(archive)
        members = archive.namelist()
        if len(members) != len(set(members)):
            raise ValueError("ZIP contains duplicate member names")
        corrupt = archive.testzip()
        if corrupt is not None:
            raise ValueError(f"ZIP member failed its CRC check: {corrupt}")
        budget = PackageBudget()
        xml = {name: parse_xml_member(name, archive.read(name), budget) for name in members
               if is_xml_member(name)}
    if main not in xml:
        raise ValueError(f"missing main part: {main}")
    types = xml.get("[Content_Types].xml")
    if types is None or not any(node.get("PartName") == "/" + main
                                and node.get("ContentType", "").endswith(content_type) for node in types):
        raise ValueError(f"[Content_Types].xml does not declare {main} as {path.suffix.lower()}")
    for name, tree in xml.items():
        if not name.endswith(".rels"):
            continue
        source = "" if name == "_rels/.rels" else posixpath.join(posixpath.dirname(posixpath.dirname(name)), posixpath.basename(name)[:-5])
        for rel in tree:
            if rel.get("TargetMode") == "External":
                continue
            target = relationship_target(source, rel.attrib["Target"])
            if target not in members:
                raise ValueError(f"{name} references missing package member: {target}")
    if path.suffix.lower() == ".docx":
        return inspect_docx(xml)
    if path.suffix.lower() == ".pptx":
        return inspect_pptx(xml)
    return inspect_xlsx(xml)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--contains", action="append", default=[], metavar="TEXT")
    parser.add_argument("--count", type=int, help="expected slide or sheet count")
    args = parser.parse_args()
    if args.input.suffix.lower() not in MAIN_PARTS:
        parser.error("input must be .docx, .pptx, or .xlsx; converting the filename does not convert its contents")
    if args.count is not None and (args.count < 0 or args.input.suffix.lower() == ".docx"):
        parser.error("--count must be non-negative and applies only to slides or sheets")
    if args.out is not None and args.out.resolve() == args.input.resolve():
        parser.error("--out must differ from the input document")
    checks = []
    summary = {}
    try:
        summary, text = inspect(args.input)
        checks.append({"id": "package", "status": "pass"})
        for required in args.contains:
            checks.append({"id": "contains", "status": "pass" if required in text else "fail", "text": required})
        if args.count is not None:
            actual = summary.get("slides", len(summary.get("sheets", [])))
            checks.append({"id": "count", "status": "pass" if actual == args.count else "fail", "expected": args.count, "actual": actual})
    # MemoryError / OverflowError / RecursionError 一并收进结构化 fail：本脚本跑在 agent
    # 子进程里，任何输入都不允许以「裸 traceback + 空 stdout」的形式失败。
    # （RecursionError 已是 RuntimeError 的子类，显式列出是为了表达意图。）
    #
    # LookupError（含其子类 IndexError）是 2026-09-23 补上的：成员声明未知编码时
    # ET 的 XMLPullParser 抛 LookupError("unknown encoding: X")，它既不是 ValueError
    # 也不是 OSError，于是直接逃逸 —— 实测该输入下本脚本「退出码 1 + 空 stdout +
    # 裸 traceback」，正是上面这句注释要消灭的形态（同型缺陷见 OFFICE-CHECKER-JS.md §5.4）。
    except (OSError, ValueError, KeyError, LookupError, RuntimeError, ET.ParseError, zipfile.BadZipFile,
            zlib.error, MemoryError, OverflowError, RecursionError) as error:
        checks.append({"id": "package", "status": "fail", "detail": failure_detail(error)})
    failed = any(check["status"] == "fail" for check in checks)
    report = {"format": args.input.suffix.lower()[1:], "verdict": "fail" if failed else "pass", "checks": checks, "summary": summary}
    output = json.dumps(report, ensure_ascii=True, indent=2) + "\n"
    if args.out is not None:
        try:
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_text(output, encoding="utf-8")
        except OSError as error:
            failed = True
            report["verdict"] = "fail"
            checks.append({"id": "output", "status": "fail", "detail": str(error)})
            output = json.dumps(report, ensure_ascii=True, indent=2) + "\n"
    sys.stdout.write(output)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
