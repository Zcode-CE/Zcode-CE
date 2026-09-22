import { firstNonSpace, isNameChar, isNameStart, isXmlSpace, xmlError } from "./office-xml-lex.mjs";
import { scopeLookup } from "./office-xml-tree.mjs";

// --- 来源与归属（改本文件前先读 docs/development/office-plugins.md） ---
// 归属:      ZCode-CE 自研（self）—— 不是 DSH 上游文件，不回写上游，不跟 DSH 发版
// 由来:      scripts/check_office.py（derived-from-dsh，MIT）的 Node 重写，按职责拆分。
// 本模块:    XML 声明 / DOCTYPE / 处理指令 / QName 校验
// 同名副本:  三份（documents/presentations/spreadsheets）必须逐字节相同，改一处同步三处
// 回归测试:  apps/zcode-cli/packages/documents-plugin/test/checkOffice.test.mjs
// ---------------------------------------------------------------------------

function checkQualifiedName(context, source, start, end, base) {
  const colon = source.indexOf(":", start);
  if (colon === -1 || colon >= end) return;
  const localStart = colon + 1;
  const second = source.indexOf(":", localStart);
  if (second >= 0 && second < end) {
    throw xmlError(context.text, base + second, "not well-formed (invalid token)");
  }
  if (localStart >= end)
    throw xmlError(context.text, base + localStart, "not well-formed (invalid token)");
  if (!isNameStart(source[localStart]) || colon === start) {
    throw xmlError(
      context.text,
      base + (colon === start ? colon : localStart),
      "not well-formed (invalid token)",
    );
  }
}

/** 版本号字面量：expat 只接受 [A-Za-z0-9_.-]+（空串与其它字符都报错）。 */
function isVersionLiteral(value) {
  return value.length > 0 && /^[A-Za-z0-9_.-]+$/.test(value);
}

/** 编码名：首字符必须是字母，其后是 [A-Za-z0-9._-]。 */
function isEncodingName(value) {
  return /^[A-Za-z][A-Za-z0-9._-]*$/.test(value);
}

/** 字面量里第一个非法字符的位置；全部合法时返回起点（与 expat 的报错列一致）。 */
function firstInvalidLiteralChar(value, start) {
  const match = /[^A-Za-z0-9_.-]/.exec(value);
  return match === null ? start : start + match.index;
}

/**
 * 跳过 DOCTYPE 声明（含内部子集），位置与文案对齐 expat。
 *
 * expat 要求 "<!DOCTYPE" 后紧跟空白，然后是根元素名；内部子集里可能含 ">"，
 * 所以必须按 "[" / "]" 配对跳过，不能简单地找第一个 ">"。
 */
function readDoctype(context, open) {
  const text = context.text;
  const nameStart = firstNonSpace(text, open + 9, text.length);
  if (nameStart === -1 || !isNameStart(text[nameStart])) {
    const message = nameStart === -1 ? "syntax error" : "not well-formed (invalid token)";
    throw xmlError(text, nameStart === -1 ? text.length : nameStart, message);
  }
  let cursor = nameStart;
  while (cursor < text.length && isNameChar(text[cursor])) cursor += 1;
  let depth = 0;
  for (; cursor < text.length; cursor += 1) {
    const ch = text[cursor];
    if (ch === "[") depth += 1;
    else if (ch === "]") depth -= 1;
    else if (ch === ">" && depth <= 0) return cursor + 1;
  }
  throw xmlError(text, open, "unclosed token");
}

/**
 * 读处理指令的目标名。
 *
 * 为什么必须校验目标名：expat 对 "<?]]>" 这类输入报 not well-formed 而不是当成处理指令跳过；
 * 只按 "?>" 找结尾会把这些非法输入静默放行，等于校验器少了一条拒绝路径。
 */
function readProcessingInstructionTarget(context, open, end) {
  const text = context.text;
  const start = open + 2;
  if (start >= end || !isNameStart(text[start])) {
    throw xmlError(text, start, "not well-formed (invalid token)");
  }
  let cursor = start;
  while (cursor < end && isNameChar(text[cursor])) cursor += 1;
  // PI 目标名是 Name，不含冒号；"<?p:x?>" 之类要报在冒号上。
  if (text[cursor] === ":") throw xmlError(text, cursor, "not well-formed (invalid token)");
  if (cursor < end && !isXmlSpace(text[cursor])) {
    // 目标名后面只能是空白或 "?>"："<?p! x?>"、"<?p/x>" 都报在目标名之后。
    throw xmlError(text, cursor, "not well-formed (invalid token)");
  }
  const target = text.slice(start, cursor);
  // XML 规范保留 "xml" 的所有大小写变体；只有全小写的才是声明，其余按非法 token 报。
  if (target.toLowerCase() === "xml" && target !== "xml") {
    throw xmlError(text, cursor, "not well-formed (invalid token)");
  }
  return target;
}

/**
 * 校验 XML 声明（<?xml ... ?>）的伪属性序列，位置与文案对齐 expat。
 *
 * 为什么值得单独写：声明里写错一个属性名（encding / standalon）时，只按 "?>" 跳过的实现会
 * 把整个文档判成合法 —— 校验器放行非法输入是最不该有的失效方向（模糊对比实测抓到）。
 * expat 的规则：必须出现在文档最开头；依次为 version、encoding、standalone；
 * 属性间必须有空白；standalone 只接受 yes/no。
 */
function readXmlDeclaration(context, open, end, outside) {
  const text = context.text;
  if (outside && context.count > 0) {
    throw xmlError(text, open, "junk after document element");
  }
  if (open !== 0) {
    throw xmlError(text, open, "XML or text declaration not at start of entity");
  }
  let stage = 0;
  let cursor = open + 5;
  while (true) {
    const beforeSpace = cursor;
    while (cursor < end && isXmlSpace(text[cursor])) cursor += 1;
    if (cursor >= end) {
      if (stage === 0) throw xmlError(text, open + 5, "XML declaration not well-formed");
      return;
    }
    if (cursor === beforeSpace) {
      // 伪属性之间必须有空白（<?xml version="1.0"encoding="UTF-8"?>）。
      throw xmlError(text, cursor, "XML declaration not well-formed");
    }
    const nameStart = cursor;
    while (cursor < end && isNameChar(text[cursor])) cursor += 1;
    const name = text.slice(nameStart, cursor);
    if ((name === "version" && stage === 0) || (name === "encoding" && stage === 1)) {
      stage = name === "version" ? 1 : 2;
    } else if (name === "standalone" && (stage === 1 || stage === 2)) {
      stage = 3;
    } else {
      throw xmlError(text, nameStart, "XML declaration not well-formed");
    }
    while (cursor < end && isXmlSpace(text[cursor])) cursor += 1;
    if (text[cursor] !== "=") throw xmlError(text, cursor, "XML declaration not well-formed");
    cursor += 1;
    while (cursor < end && isXmlSpace(text[cursor])) cursor += 1;
    const quote = text[cursor];
    if (quote !== '"' && quote !== "'")
      throw xmlError(text, cursor, "XML declaration not well-formed");
    const quoteAt = cursor;
    const valueEnd = text.indexOf(quote, cursor + 1);
    if (valueEnd === -1 || valueEnd > end)
      throw xmlError(text, quoteAt, "XML declaration not well-formed");
    const value = text.slice(cursor + 1, valueEnd);
    if (name === "standalone" && value !== "yes" && value !== "no") {
      throw xmlError(text, quoteAt, "XML declaration not well-formed");
    }
    if (name === "version" && !isVersionLiteral(value)) {
      throw xmlError(
        text,
        firstInvalidLiteralChar(value, cursor + 1),
        "XML declaration not well-formed",
      );
    }
    if (name === "encoding" && !isEncodingName(value)) {
      throw xmlError(
        text,
        firstInvalidLiteralChar(value, cursor + 1),
        "XML declaration not well-formed",
      );
    }
    cursor = valueEnd + 1;
  }
}

/** 把 "w:val" 这样的名字解析成 Clark 记法；未声明的前缀按 XML 规则报错。 */
function resolveName(context, rawName, scope, isAttribute, position) {
  const colon = rawName.indexOf(":");
  if (colon === -1) {
    if (isAttribute) return rawName;
    const defaultNamespace = scopeLookup(scope, "");
    if (defaultNamespace === undefined || defaultNamespace === "") return rawName;
    return "{" + defaultNamespace + "}" + rawName;
  }
  const prefix = rawName.slice(0, colon);
  const uri = scopeLookup(scope, prefix);
  if (uri === undefined) throw xmlError(context.text, position, "unbound prefix");
  return "{" + uri + "}" + rawName.slice(colon + 1);
}

export { checkQualifiedName };
export { firstInvalidLiteralChar };
export { isEncodingName };
export { isVersionLiteral };
export { readDoctype };
export { readProcessingInstructionTarget };
export { readXmlDeclaration };
export { resolveName };
