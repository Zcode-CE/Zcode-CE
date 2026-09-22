import { XmlParseError } from "./office-spec.mjs";

// --- 来源与归属（改本文件前先读 docs/development/office-plugins.md） ---
// 归属:      ZCode-CE 自研（self）—— 不是 DSH 上游文件，不回写上游，不跟 DSH 发版
// 由来:      scripts/check_office.py（derived-from-dsh，MIT）的 Node 重写，按职责拆分。
// 本模块:    XML 词法：实体解码、名字字符、错误位置
// 同名副本:  三份（documents/presentations/spreadsheets）必须逐字节相同，改一处同步三处
// 回归测试:  apps/zcode-cli/packages/documents-plugin/test/checkOffice.test.mjs
// ---------------------------------------------------------------------------

const XML_ENTITY_NAMES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const XML_NAMESPACE_PREFIX = "xml";
const XML_NAMESPACE_URI = "http://www.w3.org/XML/1998/namespace";

function isXmlSpace(ch) {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

/** XML 名首字符；0x00C0 以上一律接受（覆盖 CJK 等非 ASCII 名字）。 */
function isNameStart(ch) {
  if (ch === ":" || ch === "_") return true;
  if ((ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z")) return true;
  return ch.codePointAt(0) >= 0x00c0;
}

function isNameChar(ch) {
  if (isNameStart(ch)) return true;
  if (ch >= "0" && ch <= "9") return true;
  return ch === "." || ch === "-";
}

function firstNonSpace(text, start, end) {
  for (let index = start; index < end; index += 1) {
    if (!isXmlSpace(text[index])) return index;
  }
  return -1;
}

/** 与 ElementTree 的 ParseError 一致：行号从 1 起、列号从 0 起。 */
function xmlError(text, offset, message) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text[index] === "\n") line += 1;
  }
  const column = offset - text.lastIndexOf("\n", offset - 1) - 1;
  return new XmlParseError(message + ": line " + line + ", column " + column);
}

/**
 * 解码实体引用，位置与文案对齐 expat：
 * - 未定义的命名实体 → undefined entity（字符数据里指向 '&'）；
 * - 非法的字符引用（&#; / &#xZZ;）→ not well-formed，指向第一个数字位；
 * - 缺 ';' 的引用 → not well-formed，字符数据里指向字符数据结束处（expat 指向那个 '<'）。
 * 三个位置由调用方按上下文给出，因为 expat 在属性值里统一指向标签起点。
 */
function decodeEntities(raw, context, positions) {
  if (!raw.includes("&")) return raw;
  let out = "";
  let cursor = 0;
  while (cursor < raw.length) {
    const amp = raw.indexOf("&", cursor);
    if (amp === -1) {
      out += raw.slice(cursor);
      break;
    }
    out += raw.slice(cursor, amp);
    const semi = raw.indexOf(";", amp + 1);
    const body = semi === -1 ? null : raw.slice(amp + 1, semi);
    const named = body !== null && /^[A-Za-z_][A-Za-z0-9._-]*$/.test(body);
    if (body === null || (!named && !body.startsWith("#"))) {
      throw xmlError(context.text, positions.malformed, "not well-formed (invalid token)");
    }
    if (body.startsWith("#")) {
      const isHex = body[1] === "x" || body[1] === "X";
      const digits = body.slice(isHex ? 2 : 1);
      const valid = isHex ? /^[0-9a-fA-F]+$/.test(digits) : /^[0-9]+$/.test(digits);
      const code = valid ? Number.parseInt(digits, isHex ? 16 : 10) : Number.NaN;
      if (!Number.isFinite(code) || code > 0x10ffff) {
        throw xmlError(
          context.text,
          positions.character(amp, isHex ? 3 : 2),
          "not well-formed (invalid token)",
        );
      }
      out += String.fromCodePoint(code);
    } else {
      const value = XML_ENTITY_NAMES[body];
      if (value === undefined)
        throw xmlError(context.text, positions.entity(amp), "undefined entity");
      out += value;
    }
    cursor = semi + 1;
  }
  return out;
}

/** 按 BOM 与 XML 声明选择解码方式；其余编码按 ElementTree 的做法直接报错。 */
function decodeXmlBytes(data, part) {
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) {
    return data.subarray(2).toString("utf16le");
  }
  if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) {
    return Buffer.from(data.subarray(2)).swap16().toString("utf16le");
  }
  if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
    return data.subarray(3).toString("utf8");
  }
  const head = data.subarray(0, 200).toString("latin1");
  const declared = /^<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i.exec(head);
  if (declared) {
    const encoding = declared[1].toLowerCase();
    if (encoding === "utf-16" || encoding === "utf-16le") return data.toString("utf16le");
    if (
      encoding !== "utf-8" &&
      encoding !== "utf8" &&
      encoding !== "us-ascii" &&
      encoding !== "ascii"
    ) {
      throw new XmlParseError(part + ": unsupported XML encoding " + declared[1]);
    }
  }
  return data.toString("utf8");
}

/**
 * 元素：属性用扁平数组 [名, 值, 名, 值, ...]（比 Map 省一半以上），
 * 作用域只在元素自己声明了 xmlns 时才挂一帧，否则沿用父元素的引用。
 */

export { XML_ENTITY_NAMES };
export { XML_NAMESPACE_PREFIX };
export { XML_NAMESPACE_URI };
export { decodeEntities };
export { decodeXmlBytes };
export { firstNonSpace };
export { isNameChar };
export { isNameStart };
export { isXmlSpace };
export { xmlError };
