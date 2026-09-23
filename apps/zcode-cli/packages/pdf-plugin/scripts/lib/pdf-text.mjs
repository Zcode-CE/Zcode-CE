// --- 来源与归属 ---
// 归属:      ZCode-CE 自研（self）。无上游来源，不回写任何上游。
// 由来:      check_pdf.mjs 的按职责拆分（依赖方向单向：structure → text → checks → 入口，无循环依赖）。
// 本模块:    文本层：ToUnicode CMap 解析、内容流取字、字体表与页面资源
// 行为基准:  与拆分前的单文件实现逐项一致（回归测试见 test/checkPdf.test.mjs）。
// ---------------------------------------------------------------------------
import { decodeStream } from "./pdf-structure.mjs";

// ===== 文本层：ToUnicode CMap + 内容流 text-showing 算子 =====

function decodeUtf16Be(buf) {
  let out = "";
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const unit = buf.readUInt16BE(i);
    if (unit >= 0xd800 && unit <= 0xdbff && i + 3 < buf.length) {
      const low = buf.readUInt16BE(i + 2);
      out += String.fromCodePoint(0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00));
      i += 2;
    } else {
      out += String.fromCharCode(unit);
    }
  }
  return out;
}

const HEX_SEQUENCE = /<([0-9A-Fa-f\s]+)>/g;

/**
 * 解析 ToUnicode CMap 的 bfchar / bfrange。
 *
 * **一个实测抓到的坑（task-9）**：目标串允许**一个 hex 串里放多个 UTF-16 码元**，PDFKit 写中文
 * 破折号时正是这种形状 —— `beginbfrange <0000> <001a> [<0000> <7834> … <2014 2014> <4e59> …]`。
 * 早期实现用 `<([0-9A-Fa-f]+)>` 取值：`<2014 2014>` 因为含空格而**匹配不上**，被静默丢掉，
 * 于是数组下标整体前移一位 —— 该码点及其后**每个**码点都映射到错误的字符（实测：乙、。、以…整体错位），
 * `--contains` 与 `--text` 于是在"文本层其实没问题"的产物上误报缺失。
 * 现在的口径：取值正则允许空格、数组按**位置**对齐（不因为某项解析不了而丢掉位置），
 * 目标串按 UTF-16BE 解码（自动处理代理对与多码元）。
 */
function parseToUnicode(cmap) {
  const map = new Map();
  const decodeHex = (hex) => decodeUtf16Be(Buffer.from(hex.replace(/\s+/g, ""), "hex"));
  const hexNumber = (hex) => Number.parseInt(hex.replace(/\s+/g, ""), 16);
  for (const block of cmap.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
    const tokens = [...block.matchAll(HEX_SEQUENCE)];
    for (let index = 0; index + 1 < tokens.length; index += 2) {
      map.set(hexNumber(tokens[index][1]), decodeHex(tokens[index + 1][1]));
    }
  }
  for (const block of cmap.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []) {
    const body = block.replace(/beginbfrange|endbfrange/g, "");
    const entries = body.matchAll(
      /<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>\s*(?:<([0-9A-Fa-f\s]+)>|\[([\s\S]*?)\])/g,
    );
    for (const entry of entries) {
      const low = hexNumber(entry[1]);
      const high = hexNumber(entry[2]);
      if (entry[3] !== undefined) {
        const base = hexNumber(entry[3]);
        for (let code = low; code <= high && code - low < 65_536; code += 1) {
          map.set(code, decodeHex((base + code - low).toString(16).padStart(4, "0")));
        }
      } else {
        // 数组形式：位置即偏移量。用允许空格的取值正则，保证 `<2014 2014>` 也占一个位置。
        [...entry[4].matchAll(HEX_SEQUENCE)].forEach((item, index) =>
          map.set(low + index, decodeHex(item[1])),
        );
      }
    }
  }
  return map;
}

/** 内容流里被 show 出来的字节序列（只处理 Tj / TJ / ' / "，足以覆盖 PDF 生成库的输出）。 */
function readShownStrings(content) {
  const shown = [];
  const token =
    /\/([A-Za-z0-9+._-]+)\s+[\d.]+\s+Tf|\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]*>|\bTJ\b|\bTj\b/g;
  let pending = [];
  const push = (bytes) => {
    pending.push(bytes);
  };
  const flush = () => {
    for (const item of pending) shown.push(item);
    pending = [];
  };
  for (const match of content.matchAll(token)) {
    const text = match[0];
    if (text.endsWith("Tf")) {
      flush();
      shown.push({ font: match[1] });
      continue;
    }
    if (text === "Tj" || text === "TJ") {
      flush();
      continue;
    }
    if (text.startsWith("(")) push(decodeLiteralString(text.slice(1, -1)));
    else if (text.startsWith("<")) push(Buffer.from(text.slice(1, -1).replace(/\s+/g, ""), "hex"));
  }
  flush();
  return shown;
}

function decodeLiteralString(body) {
  const bytes = [];
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (char !== "\\") {
      bytes.push(char.charCodeAt(0) & 0xff);
      continue;
    }
    const next = body[++i];
    if (next === "n") bytes.push(10);
    else if (next === "r") bytes.push(13);
    else if (next === "t") bytes.push(9);
    else if (next === "b") bytes.push(8);
    else if (next === "f") bytes.push(12);
    else if (next === "(" || next === ")" || next === "\\") bytes.push(next.charCodeAt(0));
    else if (next >= "0" && next <= "7") {
      let octal = next;
      while (octal.length < 3 && body[i + 1] >= "0" && body[i + 1] <= "7") octal += body[++i];
      bytes.push(Number.parseInt(octal, 8) & 0xff);
    } else bytes.push(next.charCodeAt(0) & 0xff);
  }
  return Buffer.from(bytes);
}

/** 按字体的 ToUnicode 把字节序列解成文本；Type0/Identity-H 用双字节码。 */
function bytesToText(bytes, font) {
  if (!font || !font.toUnicode) return "";
  let out = "";
  const twoByte = font.type0;
  for (let i = 0; i < bytes.length; i += twoByte ? 2 : 1) {
    const code = twoByte ? (bytes[i] << 8) | (bytes[i + 1] ?? 0) : bytes[i];
    out += font.toUnicode.get(code) ?? "";
  }
  return out;
}

function collectFonts(pdf) {
  const fonts = new Map();
  for (const object of pdf.objects.values()) {
    if (!/\/Type\s*\/Font\b/.test(object.dict)) continue;
    const base = /\/BaseFont\s*\/([^\s/<>\[\]()]+)/.exec(object.dict)?.[1] ?? null;
    const type0 = /\/Subtype\s*\/Type0\b/.test(object.dict);
    const entry = {
      obj: object.num,
      baseFont: base,
      type0,
      subset: base ? /^[A-Z]{6}\+/.test(base) : false,
      encoding: /\/Encoding\s*\/([\w-]+)/.exec(object.dict)?.[1] ?? null,
      embedded: null,
      embeddedBytes: null,
      subsetGlyphs: null,
      toUnicode: null,
    };
    const toUnicodeRef = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(object.dict);
    if (toUnicodeRef) {
      const cmap = decodeStream(pdf.objects.get(Number(toUnicodeRef[1])));
      if (cmap) entry.toUnicode = parseToUnicode(cmap.toString("latin1"));
    }
    if (type0) {
      const descendant = pdf.objects.get(
        Number(/\/DescendantFonts\s*\[\s*(\d+)\s+0\s+R/.exec(object.dict)?.[1] ?? -1),
      );
      entry.descendantSubtype = /\/Subtype\s*\/(\w+)/.exec(descendant?.dict ?? "")?.[1] ?? null;
      const widths = /\/W\s*\[([\s\S]*)\]/.exec(descendant?.dict ?? "")?.[1];
      if (widths) {
        entry.subsetGlyphs = [...widths.matchAll(/\d+\s*\[([^\]]*)\]/g)].reduce(
          (total, run) => total + run[1].trim().split(/\s+/).filter(Boolean).length,
          0,
        );
      }
      const descriptor = pdf.objects.get(
        Number(/\/FontDescriptor\s+(\d+)\s+0\s+R/.exec(descendant?.dict ?? "")?.[1] ?? -1),
      );
      for (const key of ["FontFile2", "FontFile3", "FontFile"]) {
        const ref = new RegExp("\\/" + key + "\\s+(\\d+)\\s+0\\s+R").exec(descriptor?.dict ?? "");
        if (!ref) continue;
        const file = pdf.objects.get(Number(ref[1]));
        entry.embedded = key;
        entry.embeddedBytes = file?.stream?.length ?? 0;
        entry.fontFileSubtype = /\/Subtype\s*\/(\w+)/.exec(file?.dict ?? "")?.[1] ?? null;
        break;
      }
    }
    fonts.set(object.num, entry);
  }
  return fonts;
}

function pageObjects(pdf) {
  const pages = [];
  for (const object of pdf.objects.values()) {
    if (/\/Type\s*\/Page\b/.test(object.dict)) pages.push(object);
  }
  return pages.sort((a, b) => a.num - b.num);
}

/** /Resources 可以是内联字典或间接对象（pdfkit 用间接），两种都必须解析。 */
function resourceDict(pdf, page) {
  const inline = /\/Resources\s*<<([\s\S]*)>>/.exec(page.dict)?.[1];
  if (inline !== undefined) return inline;
  const ref = /\/Resources\s+(\d+)\s+0\s+R/.exec(page.dict)?.[1];
  if (ref === undefined) return "";
  return pdf.objects.get(Number(ref))?.dict ?? "";
}

function fontResourceMap(pdf, page) {
  const dict = resourceDict(pdf, page);
  // /Font 既可能是内联字典，也可能是间接对象（Ghostscript/qpdf 产物两种都出现过）
  const indirect = /\/Font\s+(\d+)\s+0\s+R/.exec(dict)?.[1];
  const fontsDict =
    /\/Font\s*<<([^>]*)>>/.exec(dict)?.[1] ??
    (indirect === undefined ? undefined : pdf.objects.get(Number(indirect))?.dict);
  const map = new Map();
  if (fontsDict === undefined) return map;
  for (const entry of fontsDict.matchAll(/\/([A-Za-z0-9+._-]+)\s+(\d+)\s+0\s+R/g))
    map.set(entry[1], Number(entry[2]));
  return map;
}

function mediaBox(page) {
  const box = /\/MediaBox\s*\[([^\]]+)\]/.exec(page.dict)?.[1];
  if (!box) return null;
  const [x0, y0, x1, y1] = box.trim().split(/\s+/).map(Number);
  return { width: Math.round((x1 - x0) * 100) / 100, height: Math.round((y1 - y0) * 100) / 100 };
}

export {
  bytesToText,
  collectFonts,
  fontResourceMap,
  mediaBox,
  pageObjects,
  parseToUnicode,
  readShownStrings,
  resourceDict,
};
