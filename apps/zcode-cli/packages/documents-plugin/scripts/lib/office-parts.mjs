import { closeSync, openSync, statSync } from "node:fs";
import { posix } from "node:path";

import {
  A_NAMESPACES,
  CheckError,
  MAIN_PARTS,
  P_NAMESPACES,
  PackageBudget,
  R_NAMESPACES,
  S_NAMESPACES,
  W_NAMESPACES,
  isXmlMember,
  suffixOf,
} from "./office-spec.mjs";
import {
  attributeOf,
  findChild,
  findChildren,
  findPath,
  findPathAll,
  findText,
  iterElements,
  withoutNamespace,
} from "./office-xml-tree.mjs";
import { parseXmlMember } from "./office-xml-scan.mjs";
import {
  ZipArchive,
  assertWithinByteBudget,
  readMemberBytes,
  verifyMemberIntegrity,
} from "./office-zip.mjs";

// --- 来源与归属（改本文件前先读 docs/development/office-plugins.md） ---
// 归属:      ZCode-CE 自研（self）—— 不是 DSH 上游文件，不回写上游，不跟 DSH 发版
// 由来:      scripts/check_office.py（derived-from-dsh，MIT）的 Node 重写，按职责拆分。
// 本模块:    OOXML 结构与关系检查（docx/pptx/xlsx）
// 同名副本:  三份（documents/presentations/spreadsheets）必须逐字节相同，改一处同步三处
// 回归测试:  apps/zcode-cli/packages/documents-plugin/test/checkOffice.test.mjs
// ---------------------------------------------------------------------------

// ===== OOXML：与 check_office.py 同名的检查函数 =====

/** Return the main XML namespace after checking its OOXML variant. */
function namespace(root, supported, part) {
  const match = /^\{([^}]*)\}/.exec(root.tag);
  const uri = match === null ? "" : match[1];
  if (!supported.includes(uri)) {
    throw new CheckError(
      part + " uses unsupported XML namespace: " + (uri === "" ? "(none)" : uri),
    );
  }
  return "{" + uri + "}";
}

/** Read an office-document relationship id from Transitional or Strict OOXML. */
function relationshipId(node, part) {
  for (const uri of R_NAMESPACES) {
    const value = attributeOf(node, "{" + uri + "}id");
    if (value !== undefined) return value;
  }
  throw new CheckError(part + " has a reference without a relationship id");
}

/** Return the Transitional and Strict relationship type names for one role. */
function relationshipTypes(kind) {
  return R_NAMESPACES.map((uri) => uri + "/" + kind);
}

/** Iterate matching elements across Transitional and Strict namespaces. */
function* iterNamespaces(root, namespaces, localName) {
  for (const uri of namespaces) {
    yield* iterElements(root, "{" + uri + "}" + localName);
  }
}

/** 等价于 urllib.parse.urlsplit(target).path：只取 path，丢掉 scheme/netloc/query/fragment。 */
function urlPath(target) {
  let rest = target;
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.exec(rest);
  if (scheme !== null) rest = rest.slice(scheme[0].length);
  if (rest.startsWith("//")) {
    const end = rest.slice(2).search(/[/?#]/);
    rest = end === -1 ? "" : rest.slice(2 + end);
  }
  const cut = rest.search(/[?#]/);
  return cut === -1 ? rest : rest.slice(0, cut);
}

/** 等价于 urllib.parse.unquote：解 %XX，非法序列原样保留，非法 UTF-8 用 U+FFFD 替换。 */
function unquote(value) {
  if (!value.includes("%")) return value;
  let out = "";
  let bytes = [];
  const flush = () => {
    if (bytes.length > 0) {
      out += Buffer.from(bytes).toString("utf8");
      bytes = [];
    }
  };
  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index];
    const hex = value.slice(index + 1, index + 3);
    if (ch === "%" && index + 3 <= value.length && /^[0-9a-fA-F]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
      continue;
    }
    flush();
    out += ch;
  }
  flush();
  return out;
}

/** Resolve a package relationship without fetching external resources. */
function relationshipTarget(part, target) {
  const path = unquote(urlPath(target));
  if (path.startsWith("/")) return posix.normalize(path.replace(/^\/+/, ""));
  return posix.normalize(posix.join(posix.dirname(part), path));
}

/** 某个部件的 .rels 里「非 External 且类型匹配」的关系：Id → 解析后的目标路径。 */
function relationships(part, xml, types) {
  const path = posix.join(posix.dirname(part), "_rels", posix.basename(part) + ".rels");
  const root = xml.get(path);
  if (root === undefined) return new Map();
  const links = new Map();
  for (const rel of root.children ?? []) {
    if (attributeOf(rel, "TargetMode") === "External") continue;
    if (types !== undefined && !types.includes(attributeOf(rel, "Type"))) continue;
    const target = attributeOf(rel, "Target");
    if (target === undefined)
      throw new CheckError(path + " has a relationship without a Target attribute");
    const id = attributeOf(rel, "Id");
    if (id === undefined)
      throw new CheckError(path + " has a relationship without an Id attribute");
    links.set(id, relationshipTarget(part, target));
  }
  return links;
}

/** Read a related XML part with diagnostics naming its source and reference. */
function relatedXml(part, reference, links, xml) {
  if (!links.has(reference)) {
    throw new CheckError(part + " references missing relationship: " + reference);
  }
  const target = links.get(reference);
  if (!xml.has(target)) {
    throw new CheckError(
      part + " relationship " + reference + " targets a non-XML member: " + target,
    );
  }
  return xml.get(target);
}

function inspectDocx(xml) {
  const part = "word/document.xml";
  const root = xml.get(part);
  const w = namespace(root, W_NAMESPACES, part);
  const body = findChild(root, w + "body");
  if (body === undefined) throw new CheckError("word/document.xml has no document body");
  const tables = [];
  for (const table of iterElements(body, w + "tbl")) {
    const grid = findPathAll(table, [w + "tblGrid", w + "gridCol"]);
    const rows = findChildren(table, w + "tr");
    // Merged cells span logical grid columns; counting physical cells loses them.
    let columns = grid.length;
    if (grid.length === 0) {
      columns = 0;
      for (const row of rows) {
        let span = 0;
        for (const cell of findChildren(row, w + "tc")) {
          const gridSpan = findPath(cell, [w + "tcPr", w + "gridSpan"]);
          if (gridSpan === undefined) span += 1;
          else span += Number.parseInt(attributeOf(gridSpan, w + "val") ?? "1", 10);
        }
        columns = Math.max(columns, span);
      }
    }
    tables.push({ rows: rows.length, columns });
  }
  const sections = [];
  for (const section of iterElements(body, w + "sectPr")) {
    const size = findChild(section, w + "pgSz");
    const margins = findChild(section, w + "pgMar");
    sections.push({
      page_twips: size === undefined ? {} : withoutNamespace(size.attrib, w),
      margins_twips: margins === undefined ? {} : withoutNamespace(margins.attrib, w),
    });
  }
  const textParts = [body];
  for (const kind of ["header", "footer"]) {
    const links = relationships(part, xml, relationshipTypes(kind));
    for (const section of iterElements(body, w + "sectPr")) {
      for (const reference of findChildren(section, w + kind + "Reference")) {
        textParts.push(relatedXml(part, relationshipId(reference, part), links, xml));
      }
    }
  }
  for (const kind of ["footnote", "endnote"]) {
    const references = new Set(
      [...iterElements(body, w + kind + "Reference")].map((node) => attributeOf(node, w + "id")),
    );
    if (references.size === 0) continue;
    const links = relationships(part, xml, relationshipTypes(kind + "s"));
    for (const reference of links.keys()) {
      const tree = relatedXml(part, reference, links, xml);
      for (const note of findChildren(tree, w + kind)) {
        if (references.has(attributeOf(note, w + "id"))) textParts.push(note);
      }
    }
  }
  const chunks = [];
  for (const tree of textParts) {
    for (const paragraph of iterElements(tree, w + "p")) {
      let chunk = "";
      for (const node of iterElements(paragraph, w + "t")) chunk += node.text;
      chunks.push(chunk);
    }
  }
  return {
    summary: { paragraphs: [...iterElements(body, w + "p")].length, tables, sections },
    text: chunks.join("\n"),
  };
}

function inspectPptx(xml) {
  const part = "ppt/presentation.xml";
  const links = relationships(part, xml);
  const root = xml.get(part);
  const p = namespace(root, P_NAMESPACES, part);
  const slides = findPathAll(root, [p + "sldIdLst", p + "sldId"]);
  const texts = [];
  for (const slide of slides) {
    const tree = relatedXml(part, relationshipId(slide, part), links, xml);
    const lines = [];
    for (const paragraph of iterNamespaces(tree, A_NAMESPACES, "p")) {
      let line = "";
      for (const node of iterNamespaces(paragraph, A_NAMESPACES, "t")) line += node.text;
      lines.push(line);
    }
    texts.push(lines.join("\n"));
  }
  return { summary: { slides: slides.length }, text: texts.join("\n") };
}

function inspectXlsx(xml) {
  const part = "xl/workbook.xml";
  const links = relationships(part, xml);
  const root = xml.get(part);
  const s = namespace(root, S_NAMESPACES, part);
  const sheets = [];
  const texts = [];
  const shared = xml.get("xl/sharedStrings.xml");
  const sharedS =
    shared === undefined ? s : namespace(shared, S_NAMESPACES, "xl/sharedStrings.xml");
  const sharedStrings = [];
  if (shared !== undefined) {
    for (const item of iterElements(shared, sharedS + "si")) {
      let value = "";
      for (const node of iterElements(item, sharedS + "t")) value += node.text;
      sharedStrings.push(value);
    }
  }
  for (const sheet of findPathAll(root, [s + "sheets", s + "sheet"])) {
    const reference = relationshipId(sheet, part);
    const tree = relatedXml(part, reference, links, xml);
    const sheetS = namespace(tree, S_NAMESPACES, links.get(reference));
    const cells = [...iterElements(tree, sheetS + "c")];
    let formulas = 0;
    for (const cell of cells) {
      if (findChild(cell, sheetS + "f") !== undefined) formulas += 1;
    }
    const name = attributeOf(sheet, "name");
    if (name === undefined)
      throw new CheckError(links.get(reference) + " has a sheet without a name");
    sheets.push({ name, cells: cells.length, formulas });
    for (const cell of cells) {
      if (attributeOf(cell, "t") !== "s") continue;
      const value = findText(cell, sheetS + "v", "");
      const location =
        links.get(reference) + " cell " + (attributeOf(cell, "r") ?? "(no reference)");
      const normalized = value.trim().replace(/_/g, "");
      if (!/^[+-]?\d+$/.test(normalized)) {
        throw new CheckError(location + ": invalid shared string index " + JSON.stringify(value));
      }
      const index = Number.parseInt(normalized, 10);
      if (!(index >= 0 && index < sharedStrings.length)) {
        throw new CheckError(location + ": shared string index out of range: " + index);
      }
      texts.push(sharedStrings[index]);
    }
    for (const cell of cells) {
      let value = "";
      for (const node of iterElements(cell, sheetS + "t")) value += node.text;
      texts.push(value);
    }
    for (const cell of cells) {
      if (attributeOf(cell, "t") === "str") texts.push(findText(cell, sheetS + "v", ""));
    }
    texts.push(name);
  }
  return { summary: { sheets, formulas_evaluated: false }, text: texts.join("\n") };
}

/** Validate package members and relationships before inspecting the main part. */
async function inspect(path) {
  const suffix = suffixOf(path).toLowerCase();
  const parts = MAIN_PARTS[suffix];
  if (parts === undefined) throw new CheckError("unsupported input format: " + suffix);
  const fd = openSync(path, "r");
  let archive;
  try {
    archive = new ZipArchive(fd, statSync(path).size);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  try {
    return await inspectArchive(archive, suffix, parts);
  } finally {
    closeSync(fd);
  }
}

/** 打开之后的检查流程；与 .py 的 inspect() 顺序逐条对齐。 */
async function inspectArchive(archive, suffix, parts) {
  const entries = archive.readCentralDirectory();
  // 顺序要紧：体积预算必须排在 CRC 校验与所有解压之前，否则解压已经发生。
  assertWithinByteBudget(entries);
  const members = entries.map((entry) => entry.name);
  if (members.length !== new Set(members).size) {
    throw new CheckError("ZIP contains duplicate member names");
  }
  for (const entry of entries) {
    await verifyMemberIntegrity(archive, entry);
  }
  const budget = new PackageBudget();
  const xml = new Map();
  for (const entry of entries) {
    if (!isXmlMember(entry.name)) continue;
    const data = await readMemberBytes(archive, entry);
    xml.set(entry.name, parseXmlMember(entry.name, data, budget));
  }
  if (!xml.has(parts.main)) throw new CheckError("missing main part: " + parts.main);
  const types = xml.get("[Content_Types].xml");
  const declaresMain =
    types !== undefined &&
    (types.children ?? []).some(
      (node) =>
        attributeOf(node, "PartName") === "/" + parts.main &&
        (attributeOf(node, "ContentType") ?? "").endsWith(parts.contentType),
    );
  if (!declaresMain) {
    throw new CheckError("[Content_Types].xml does not declare " + parts.main + " as " + suffix);
  }
  for (const [name, tree] of xml) {
    if (!name.endsWith(".rels")) continue;
    const source =
      name === "_rels/.rels"
        ? ""
        : posix.join(posix.dirname(posix.dirname(name)), posix.basename(name).slice(0, -5));
    for (const rel of tree.children ?? []) {
      if (attributeOf(rel, "TargetMode") === "External") continue;
      const target = attributeOf(rel, "Target");
      if (target === undefined)
        throw new CheckError(name + " has a relationship without a Target attribute");
      const resolved = relationshipTarget(source, target);
      if (!members.includes(resolved)) {
        throw new CheckError(name + " references missing package member: " + resolved);
      }
    }
  }
  if (suffix === ".docx") return inspectDocx(xml);
  if (suffix === ".pptx") return inspectPptx(xml);
  return inspectXlsx(xml);
}

export { inspect };
export { inspectArchive };
export { inspectDocx };
export { inspectPptx };
export { inspectXlsx };
export { iterNamespaces };
export { namespace };
export { relatedXml };
export { relationshipId };
export { relationshipTarget };
export { relationshipTypes };
export { relationships };
export { unquote };
export { urlPath };
