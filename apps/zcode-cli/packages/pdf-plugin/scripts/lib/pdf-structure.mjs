// --- 来源与归属 ---
// 归属:      ZCode-CE 自研（self）。无上游来源，不回写任何上游。
// 由来:      check_pdf.mjs 的按职责拆分（依赖方向单向：structure → text → checks → 入口，无循环依赖）。
// 本模块:    预算常量、交叉引用表与对象解析、流解码、PdfFormatError
// 行为基准:  与拆分前的单文件实现逐项一致（回归测试见 test/checkPdf.test.mjs）。
// ---------------------------------------------------------------------------
import { inflateSync } from "node:zlib";

// ===== 资源预算（对齐 check_office 的 MAX_* 口径：读不可信输入必须有界） =====
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_STREAM_DECOMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_OBJECTS = 200_000;

class PdfFormatError extends Error {}

// ===== 结构解析（经典交叉引用表；PDF 1.3+ 的 xref 流不在本工具的支持范围内，明确报错） =====

function parseXref(s, offset) {
  const tail = s.slice(offset);
  if (!/^xref\b/.test(tail))
    throw new PdfFormatError("startxref does not point at a classic xref table");
  const match = /^xref\s+([\s\S]*?)trailer\s*<<([\s\S]*?)>>/.exec(tail);
  if (!match) throw new PdfFormatError("malformed xref/trailer section");
  const tokens = match[1].trim().split(/\s+/);
  const offsets = [];
  let index = 0;
  let subsections = 0;
  while (index < tokens.length) {
    const first = Number(tokens[index]);
    const count = Number(tokens[index + 1]);
    if (!Number.isInteger(first) || !Number.isInteger(count))
      throw new PdfFormatError("bad xref subsection header");
    subsections += 1;
    index += 2;
    for (let k = 0; k < count; k += 1, index += 3) {
      const entryOffset = Number(tokens[index]);
      const flag = tokens[index + 2];
      if (flag !== "n" && flag !== "f") throw new PdfFormatError("bad xref entry flag: " + flag);
      offsets[first + k] = flag === "n" ? entryOffset : null;
    }
  }
  if (index !== tokens.length) throw new PdfFormatError("trailing tokens in xref table");
  const size = Number(/\/Size\s+(\d+)/.exec(match[2])?.[1] ?? -1);
  const root = Number(/\/Root\s+(\d+)\s+0\s+R/.exec(match[2])?.[1] ?? -1);
  return { offsets, subsections, size, root };
}

function parsePdf(buf) {
  if (buf.subarray(0, 5).toString("latin1") !== "%PDF-")
    throw new PdfFormatError("missing %PDF- header");
  const s = buf.toString("latin1");
  const startxref = /startxref\s+(\d+)/.exec(s);
  if (!startxref) throw new PdfFormatError("missing startxref trailer keyword");
  const xref = parseXref(s, Number(startxref[1]));
  if (xref.offsets.length > MAX_OBJECTS)
    throw new PdfFormatError("too many objects: " + xref.offsets.length);
  const objects = new Map();
  for (let num = 0; num < xref.offsets.length; num += 1) {
    const offset = xref.offsets[num];
    if (offset == null) continue;
    const head = /^(\d+)\s+(\d+)\s+obj\b/.exec(s.slice(offset, offset + 40));
    if (!head) throw new PdfFormatError("object " + num + " is not at its xref offset");
    if (Number(head[1]) !== num)
      throw new PdfFormatError("xref entry " + num + " points at object " + head[1]);
    const bodyStart = offset + head[0].length;
    const streamIdx = s.indexOf("stream", bodyStart);
    const endObj = s.indexOf("endobj", bodyStart);
    const hasStream = streamIdx !== -1 && streamIdx < endObj;
    const dict = s.slice(bodyStart, hasStream ? streamIdx : endObj);
    let stream = null;
    if (hasStream) {
      let start = streamIdx + 6;
      if (s[start] === "\r") start += 1;
      if (s[start] === "\n") start += 1;
      const length = /\/Length\s+(\d+)(?!\s+0\s+R)/.exec(dict);
      if (!length)
        throw new PdfFormatError("object " + num + ": indirect /Length is not supported");
      stream = buf.subarray(start, start + Number(length[1]));
    }
    objects.set(num, { num, dict, stream });
  }
  return { version: s.slice(0, 8).trim(), xref, objects };
}

function decodeStream(object) {
  if (!object?.stream) return null;
  const filter = /\/Filter\s*\/?(\w+)/.exec(object.dict)?.[1];
  if (object.stream.length > MAX_STREAM_DECOMPRESSED_BYTES)
    throw new PdfFormatError("stream too large");
  if (filter === undefined || filter === "FlateDecode") {
    const raw = filter === undefined ? object.stream : inflateSync(object.stream);
    if (raw.length > MAX_STREAM_DECOMPRESSED_BYTES)
      throw new PdfFormatError("decompressed stream too large");
    return raw;
  }
  throw new PdfFormatError("unsupported stream filter: " + filter);
}

export {
  MAX_INPUT_BYTES,
  MAX_OBJECTS,
  MAX_STREAM_DECOMPRESSED_BYTES,
  PdfFormatError,
  decodeStream,
  parsePdf,
  parseXref,
};
