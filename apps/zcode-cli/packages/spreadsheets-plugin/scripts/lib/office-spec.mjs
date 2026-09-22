import { basename } from "node:path";

// --- 来源与归属（改本文件前先读 docs/development/office-plugins.md） ---
// 归属:      ZCode-CE 自研（self）—— 不是 DSH 上游文件，不回写上游，不跟 DSH 发版
// 由来:      scripts/check_office.py（derived-from-dsh，MIT）的 Node 重写，按职责拆分。
// 本模块:    规格常量与错误类型（命名空间、部件表、资源预算、错误类型、后缀规则）
// 同名副本:  三份（documents/presentations/spreadsheets）必须逐字节相同，改一处同步三处
// 回归测试:  apps/zcode-cli/packages/documents-plugin/test/checkOffice.test.mjs
// ---------------------------------------------------------------------------

// ===== 命名空间与部件表（与 check_office.py 同名同值） =====

const W_NAMESPACES = [
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
];
const A_NAMESPACES = [
  "http://schemas.openxmlformats.org/drawingml/2006/main",
  "http://purl.oclc.org/ooxml/drawingml/main",
];
const P_NAMESPACES = [
  "http://schemas.openxmlformats.org/presentationml/2006/main",
  "http://purl.oclc.org/ooxml/presentationml/main",
];
const S_NAMESPACES = [
  "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  "http://purl.oclc.org/ooxml/spreadsheetml/main",
];
const R_NAMESPACES = [
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  "http://purl.oclc.org/ooxml/officeDocument/relationships",
];
const MAIN_PARTS = {
  ".docx": { main: "word/document.xml", contentType: "wordprocessingml.document.main+xml" },
  ".pptx": { main: "ppt/presentation.xml", contentType: "presentationml.presentation.main+xml" },
  ".xlsx": { main: "xl/workbook.xml", contentType: "spreadsheetml.sheet.main+xml" },
};

// 只有这两类成员会被读进内存并解析；其余成员（图片、嵌入对象等）本脚本从不读取，
// 只在完整性校验时按分块做 CRC 校验，内存有界。预算必须**只**作用于这个集合：
// 若把图片也算进总预算，一份 150 MB 的扫描件文档就会被误判为超预算而拒收（实测）。
const XML_MEMBER_SUFFIXES = [".xml", ".rels"];

/** 成员是否会被读进内存解析；预算与读取路径共用，避免两处判断漂移。 */
function isXmlMember(name) {
  return XML_MEMBER_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

// 资源预算（S5 安全修复）。为什么必须有：本脚本的调用方是 LLM agent（见
// skills/docx/SKILL.md 的「Check and deliver」一节），输入来自用户文档或网络下载，
// 属**不可信输入**。修复前对解压体积没有任何约束，安全复查实测 2.09 MB 的 ZIP 可解出
// 2 GiB、子进程峰值 RSS 4116 MiB（放大比约 2000:1）；agent 是独立子进程，OOM 会连带
// 拖垮正在编辑的文档会话（未保存即丢失工作）。
//
// 为什么同时设「字节」和「元素」两条线：字节预算管不住「小体积、多元素」的 XML。
// 实测一个声明体积仅 67.1 MB 的成员能解析出 1677 万个元素、峰值 RSS 1583 MiB
// （ElementTree 每元素约 100 字节），仅按字节设限仍可 OOM。元素预算才是真正约束
// 峰值内存的那条线，字节预算负责拦住巨型部件、并在解压前就拒绝 ZIP bomb。
const MAX_MEMBER_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_MEMBER_ELEMENTS = 2000000;
const MAX_TOTAL_ELEMENTS = 4000000;
// 分块喂给 XML 扫描器的粒度；配合元素预算让解析能在超限时立即停下。
const PARSE_CHUNK_BYTES = 1024 * 1024;

/** 整个包共享的元素解析预算，避免「每个成员都不超限、合起来超限」。 */
class PackageBudget {
  constructor() {
    this.elements = 0;
  }
}

// ===== 错误类型 =====

/** 对应 Python 的 ValueError：可预期的输入缺陷，统一变成结构化 fail。 */
class CheckError extends Error {
  constructor(message) {
    super(message);
    this.name = "CheckError";
  }
}

/** 对应 Python 的 zipfile.BadZipFile。 */
class BadZipFileError extends Error {
  constructor(message) {
    super(message);
    this.name = "BadZipFileError";
  }
}

/** 对应 Python 的 xml.etree.ElementTree.ParseError。 */
class XmlParseError extends Error {
  constructor(message) {
    super(message);
    this.name = "XmlParseError";
  }
}
/** 与 pathlib.Path.suffix 一致：末尾的点不算后缀，点开头的文件名没有后缀。 */
function suffixOf(path) {
  const name = basename(path);
  const index = name.lastIndexOf(".");
  return index > 0 && index < name.length - 1 ? name.slice(index) : "";
}

export { A_NAMESPACES };
export { BadZipFileError };
export { CheckError };
export { MAIN_PARTS };
export { MAX_MEMBER_BYTES };
export { MAX_MEMBER_ELEMENTS };
export { MAX_TOTAL_BYTES };
export { MAX_TOTAL_ELEMENTS };
export { PARSE_CHUNK_BYTES };
export { P_NAMESPACES };
export { PackageBudget };
export { R_NAMESPACES };
export { S_NAMESPACES };
export { W_NAMESPACES };
export { XML_MEMBER_SUFFIXES };
export { XmlParseError };
export { isXmlMember };
export { suffixOf };
