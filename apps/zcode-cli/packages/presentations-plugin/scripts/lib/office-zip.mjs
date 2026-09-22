import { readFileSync, readSync } from "node:fs";
import { createInflateRaw } from "node:zlib";

import {
  BadZipFileError,
  CheckError,
  MAX_MEMBER_BYTES,
  MAX_TOTAL_BYTES,
  PARSE_CHUNK_BYTES,
  isXmlMember,
} from "./office-spec.mjs";

// --- 来源与归属（改本文件前先读 docs/development/office-plugins.md） ---
// 归属:      ZCode-CE 自研（self）—— 不是 DSH 上游文件，不回写上游，不跟 DSH 发版
// 由来:      scripts/check_office.py（derived-from-dsh，MIT）的 Node 重写，按职责拆分。
// 本模块:    ZIP 只读子集（中央目录 + inflateRaw + CRC32，按需从 fd 读）
// 同名副本:  三份（documents/presentations/spreadsheets）必须逐字节相同，改一处同步三处
// 回归测试:  apps/zcode-cli/packages/documents-plugin/test/checkOffice.test.mjs
// ---------------------------------------------------------------------------

// ===== ZIP：中央目录 + inflateRaw + CRC32（自研，等价于 zipfile 的只读子集） =====
//
// 为什么按需从文件描述符读，而不是 readFileSync 整个包：包体积不受 MAX_* 预算约束
// （图片、嵌入对象不读内存也不计入预算），一份 160 MB 的扫描件文档若整包读进来，
// 光是这一个动作就吃掉 160 MB —— 实测峰值 RSS 381 MiB（.py 为 21 MiB）。
// 这里只读中央目录与当前成员所需的字节，其余留在磁盘上。

const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP_EOCD_SIZE = 22;
const ZIP_MAX_COMMENT = 0xffff;
const ZIP_CENTRAL_HEADER_SIZE = 46;
const ZIP_LOCAL_HEADER_SIZE = 30;
const ZIP_METHOD_STORED = 0;
const ZIP_METHOD_DEFLATED = 8;
const ZIP_FLAG_ENCRYPTED = 0x0001;
const ZIP_FLAG_UTF8 = 0x0800;
const UINT32_MAX = 0xffffffff;
const UINT16_MAX = 0xffff;
// 分块粒度复用契约里的 PARSE_CHUNK_BYTES（1 MiB）：边读边解、边解边扫，
// 元素预算一超就停，不需要把整个成员读进内存。
const IO_CHUNK_BYTES = PARSE_CHUNK_BYTES;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();
const CRC_INIT = 0xffffffff;

function crc32Update(state, buffer) {
  let value = state;
  for (let index = 0; index < buffer.length; index += 1) {
    value = CRC_TABLE[(value ^ buffer[index]) & 0xff] ^ (value >>> 8);
  }
  return value >>> 0;
}

function crc32Final(state) {
  return (state ^ 0xffffffff) >>> 0;
}

/** cp437 的 0x80-0xFF 段；ZIP 未置 UTF-8 标志位时的历史编码，同 zipfile 的默认。 */
const CP437_HIGH =
  "\u00c7\u00fc\u00e9\u00e2\u00e4\u00e0\u00e5\u00e7\u00ea\u00eb\u00e8\u00ef\u00ee\u00ec\u00c4\u00c5" +
  "\u00c9\u00e6\u00c6\u00f4\u00f6\u00f2\u00fb\u00f9\u00ff\u00d6\u00dc\u00a2\u00a3\u00a5\u20a7\u0192" +
  "\u00e1\u00ed\u00f3\u00fa\u00f1\u00d1\u00aa\u00ba\u00bf\u2310\u00ac\u00bd\u00bc\u00a1\u00ab\u00bb" +
  "\u2591\u2592\u2593\u2502\u2524\u2561\u2562\u2556\u2555\u2563\u2551\u2557\u255d\u255c\u255b\u2510" +
  "\u2514\u2534\u252c\u251c\u2500\u253c\u255e\u255f\u255a\u2554\u2569\u2566\u2560\u2550\u256c\u2567" +
  "\u2568\u2564\u2565\u2559\u2558\u2552\u2553\u256b\u256a\u2518\u250c\u2588\u2584\u258c\u2590\u2580" +
  "\u03b1\u00df\u0393\u03c0\u03a3\u03c3\u00b5\u03c4\u03a6\u0398\u03a9\u03b4\u221e\u03c6\u03b5\u2229" +
  "\u2261\u00b1\u2265\u2264\u2320\u2321\u00f7\u2248\u00b0\u2219\u00b7\u221a\u207f\u00b2\u25a0\u00a0";

function decodeCp437(buffer) {
  let out = "";
  for (const byte of buffer) {
    out += byte < 0x80 ? String.fromCharCode(byte) : CP437_HIGH[byte - 0x80];
  }
  return out;
}

/** 只读的 ZIP 包：按需从文件描述符取字节，不把整包读进内存。 */
class ZipArchive {
  constructor(fd, size) {
    this.fd = fd;
    this.size = size;
    this.entries = null;
  }

  /** 从任意偏移读 length 字节；越界部分按实际长度返回。 */
  readAt(offset, length) {
    if (length <= 0 || offset >= this.size) return Buffer.alloc(0);
    const buffer = Buffer.allocUnsafe(Math.min(length, this.size - offset));
    let filled = 0;
    while (filled < buffer.length) {
      const read = readSync(this.fd, buffer, filled, buffer.length - filled, offset + filled);
      if (read <= 0) break;
      filled += read;
    }
    return filled === buffer.length ? buffer : buffer.subarray(0, filled);
  }

  /**
   * 定位并解析 ZIP 尾部记录（EOCD），必要时升级到 ZIP64。
   *
   * 对应 zipfile._EndRecData：先试「EOCD 正好在文件末尾」的快路径，否则在最后 64 KiB
   * 注释窗口里从后往前找签名。
   */
  readEndOfCentralDirectory() {
    const size = this.size;
    if (size < ZIP_EOCD_SIZE) return null;
    const windowLength = Math.min(size, ZIP_MAX_COMMENT + ZIP_EOCD_SIZE);
    const windowStart = size - windowLength;
    const window = this.readAt(windowStart, windowLength);
    if (window.length < ZIP_EOCD_SIZE) return null;
    let offset = window.length - ZIP_EOCD_SIZE;
    const tail = window.subarray(offset);
    if (tail.readUInt32LE(0) !== ZIP_EOCD_SIGNATURE || tail.readUInt16LE(ZIP_EOCD_SIZE - 2) !== 0) {
      const found = window.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
      if (found < 0) return null;
      offset = found;
      if (offset + ZIP_EOCD_SIZE > window.length) return null;
    }
    const record = window.subarray(offset, offset + ZIP_EOCD_SIZE);
    let entries = record.readUInt16LE(10);
    let cdSize = record.readUInt32LE(12);
    let cdOffset = record.readUInt32LE(16);
    if (entries === UINT16_MAX || cdSize === UINT32_MAX || cdOffset === UINT32_MAX) {
      // ZIP64：定位器紧挨在 EOCD 之前，其 8 字节字段给出 Zip64 EOCD 的位置。
      const locator = windowStart + offset - 20;
      if (locator >= 0) {
        const locatorBytes = this.readAt(locator, 20);
        if (
          locatorBytes.length === 20 &&
          locatorBytes.readUInt32LE(0) === ZIP64_LOCATOR_SIGNATURE
        ) {
          const zip64Offset = Number(locatorBytes.readBigUInt64LE(8));
          const zip64 = this.readAt(zip64Offset, 56);
          if (zip64.length === 56 && zip64.readUInt32LE(0) === ZIP64_EOCD_SIGNATURE) {
            entries = Number(zip64.readBigUInt64LE(32));
            cdSize = Number(zip64.readBigUInt64LE(40));
            cdOffset = Number(zip64.readBigUInt64LE(48));
          }
        }
      }
    }
    return { entries, cdSize, cdOffset };
  }

  /** 读取中央目录，返回按存储顺序排列的成员表（同 ZipFile.infolist()）。 */
  readCentralDirectory() {
    const end = this.readEndOfCentralDirectory();
    if (end === null) throw new BadZipFileError("File is not a zip file");
    if (end.cdOffset < 0 || end.cdSize < 0 || end.cdOffset + end.cdSize > this.size) {
      throw new BadZipFileError("Bad offset for central directory");
    }
    const cd = this.readAt(end.cdOffset, end.cdSize);
    const entries = [];
    let total = 0;
    let cursor = 0;
    while (total < end.cdSize) {
      if (cursor + ZIP_CENTRAL_HEADER_SIZE > cd.length) {
        throw new BadZipFileError("Truncated central directory");
      }
      if (cd.readUInt32LE(cursor) !== ZIP_CENTRAL_SIGNATURE) {
        throw new BadZipFileError("Bad magic number for central directory");
      }
      const flags = cd.readUInt16LE(cursor + 8);
      const nameLength = cd.readUInt16LE(cursor + 28);
      const extraLength = cd.readUInt16LE(cursor + 30);
      const commentLength = cd.readUInt16LE(cursor + 32);
      const nameBytes = cd.subarray(cursor + 46, cursor + 46 + nameLength);
      const entry = {
        name: flags & ZIP_FLAG_UTF8 ? nameBytes.toString("utf8") : decodeCp437(nameBytes),
        flags,
        method: cd.readUInt16LE(cursor + 10),
        crc: cd.readUInt32LE(cursor + 16),
        compressedSize: cd.readUInt32LE(cursor + 20),
        fileSize: cd.readUInt32LE(cursor + 24),
        localOffset: cd.readUInt32LE(cursor + 42),
      };
      const extra = cd.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength);
      applyZip64Extra(entry, extra);
      entries.push(entry);
      const step = ZIP_CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength;
      total += step;
      cursor += step;
    }
    this.entries = entries;
    return entries;
  }

  /** 成员压缩数据的起始偏移（跳过局部头，用局部头自己的长度字段，同 ZipFile.open）。 */
  dataOffset(entry) {
    const start = entry.localOffset;
    const header = this.readAt(start, ZIP_LOCAL_HEADER_SIZE);
    if (header.length !== ZIP_LOCAL_HEADER_SIZE) throw new BadZipFileError("Truncated file header");
    if (header.readUInt32LE(0) !== ZIP_LOCAL_SIGNATURE) {
      throw new BadZipFileError("Bad magic number for file header");
    }
    const nameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);
    const offset = start + ZIP_LOCAL_HEADER_SIZE + nameLength + extraLength;
    if (offset + entry.compressedSize > this.size) {
      throw new BadZipFileError("Truncated file data for " + entry.name);
    }
    return offset;
  }

  /** 按 IO_CHUNK_BYTES 分块产出成员的压缩数据；调用方不需要整段进内存。 */
  *compressedChunks(entry) {
    const start = this.dataOffset(entry);
    let remaining = entry.compressedSize;
    let offset = start;
    while (remaining > 0) {
      const size = Math.min(remaining, IO_CHUNK_BYTES);
      const chunk = this.readAt(offset, size);
      if (chunk.length === 0) break;
      remaining -= chunk.length;
      offset += chunk.length;
      yield chunk;
    }
  }
}

/** 解析 ZIP64 扩展字段：只取本脚本用得到的三项（体积 / 压缩体积 / 局部头偏移）。 */
function applyZip64Extra(entry, extra) {
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const tag = extra.readUInt16LE(offset);
    const length = extra.readUInt16LE(offset + 2);
    if (offset + 4 + length > extra.length) {
      throw new BadZipFileError(
        "Corrupt extra field " + tag.toString(16) + " (size=" + length + ")",
      );
    }
    if (tag === 0x0001) {
      const data = extra.subarray(offset + 4, offset + 4 + length);
      let cursor = 0;
      if (entry.fileSize === UINT32_MAX) {
        if (cursor + 8 > data.length) {
          throw new BadZipFileError("Corrupt zip64 extra field. File size not found.");
        }
        entry.fileSize = Number(data.readBigUInt64LE(cursor));
        cursor += 8;
      }
      if (entry.compressedSize === UINT32_MAX) {
        if (cursor + 8 > data.length) {
          throw new BadZipFileError("Corrupt zip64 extra field. Compress size not found.");
        }
        entry.compressedSize = Number(data.readBigUInt64LE(cursor));
        cursor += 8;
      }
      if (entry.localOffset === UINT32_MAX) {
        if (cursor + 8 > data.length) {
          throw new BadZipFileError("Corrupt zip64 extra field. Header offset not found.");
        }
        entry.localOffset = Number(data.readBigUInt64LE(cursor));
      }
    }
    offset += 4 + length;
  }
}

/** 写一块压缩数据，等它被消费（背压），避免 inflate 内部把整段缓冲起来。 */
function writeChunk(inflater, chunk) {
  return new Promise((resolvePromise, rejectPromise) => {
    inflater.write(chunk, (error) => (error ? rejectPromise(error) : resolvePromise()));
  });
}

/**
 * 解压一个成员，边解边算 CRC，最多接受 limit 字节。
 *
 * 为什么不用 zlib.inflateRawSync：它会一次性把整个成员解进内存，而「声明体积」是不可信
 * 输入 —— 这正是原版无界解压的形态。这里按 IO_CHUNK_BYTES 边读边解，读满 limit 就
 * destroy()，与 Python 侧 ZipExtFile 的 data[:self._left] 截断语义对齐（实测：声明体积
 * 就是单个成员真正能被读进内存的上限；谎报更小的体积只会让成员读不全并在 CRC 上失败，
 * 不会绕过预算）。
 *
 * collect=false 时只算 CRC、不留数据（对应 zipfile.testzip）：160 MB 的 media 成员
 * 走这条路径，峰值内存只有一个 chunk。
 */
async function inflateMember(archive, entry, collect) {
  const limit = entry.fileSize;
  const inflater = createInflateRaw();
  const chunks = collect ? [] : null;
  let total = 0;
  let crc = CRC_INIT;
  let failure = null;
  let settled = false;
  const done = new Promise((resolvePromise, rejectPromise) => {
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) rejectPromise(error);
      else resolvePromise({ chunks, total, crc: crc32Final(crc) });
    };
    inflater.on("data", (chunk) => {
      if (settled) return;
      const room = limit - total;
      const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
      total += piece.length;
      crc = crc32Update(crc, piece);
      if (chunks !== null) chunks.push(piece);
      if (total >= limit) {
        // 与 ZipExtFile 一致：声明体积即读取上限，读满就停，剩下的字节不解压。
        inflater.destroy();
        finish(null);
      }
    });
    inflater.on("error", (error) => finish(error));
    inflater.on("end", () => finish(null));
    inflater.on("close", () => {
      if (!settled) finish(failure ?? new BadZipFileError("unexpected end of compressed data"));
    });
  });
  try {
    for (const chunk of archive.compressedChunks(entry)) {
      if (settled) break;
      await writeChunk(inflater, chunk);
    }
    if (!settled) inflater.end();
  } catch (error) {
    failure = error;
    inflater.destroy();
  }
  return done;
}

/** 把一个成员完整解出来并校验（CRC32 + 声明体积），返回解压后的字节。 */
async function readMemberBytes(archive, entry) {
  assertReadable(entry);
  if (entry.method === ZIP_METHOD_STORED) {
    const data = archive.readAt(archive.dataOffset(entry), entry.compressedSize);
    if (data.length !== entry.fileSize) {
      throw new BadZipFileError(
        "ZIP member " +
          entry.name +
          ": declared size " +
          entry.fileSize +
          " bytes, read " +
          data.length +
          " bytes",
      );
    }
    if (crc32Final(crc32Update(CRC_INIT, data)) !== entry.crc) {
      throw new BadZipFileError("ZIP member " + entry.name + " failed its CRC check");
    }
    return data;
  }
  const result = await inflateMember(archive, entry, true);
  if (result.total !== entry.fileSize) {
    throw new BadZipFileError(
      "ZIP member " +
        entry.name +
        ": declared size " +
        entry.fileSize +
        " bytes, decompressed " +
        result.total +
        " bytes",
    );
  }
  if (result.crc !== entry.crc) {
    throw new BadZipFileError("ZIP member " + entry.name + " failed its CRC check");
  }
  return Buffer.concat(result.chunks, result.total);
}

/**
 * 只做完整性校验、不保留解压结果（同 zipfile.testzip）。
 *
 * 为什么单独一趟：Python 侧的顺序是「体积预算 → testzip（全部成员 CRC）→ 逐个解析 XML」，
 * 这一趟对应 testzip，解压结果不累积，所以 160 MB 的 media 成员不会被读进内存。
 */
async function verifyMemberIntegrity(archive, entry) {
  assertReadable(entry);
  if (entry.method === ZIP_METHOD_STORED) {
    let crc = CRC_INIT;
    let total = 0;
    const start = archive.dataOffset(entry);
    let offset = start;
    let remaining = entry.compressedSize;
    while (remaining > 0) {
      const chunk = archive.readAt(offset, Math.min(remaining, IO_CHUNK_BYTES));
      if (chunk.length === 0) break;
      crc = crc32Update(crc, chunk);
      total += chunk.length;
      remaining -= chunk.length;
      offset += chunk.length;
    }
    if (total !== entry.fileSize || crc32Final(crc) !== entry.crc) {
      throw new BadZipFileError("ZIP member " + entry.name + " failed its CRC check");
    }
    return;
  }
  const result = await inflateMember(archive, entry, false);
  if (result.total !== entry.fileSize || result.crc !== entry.crc) {
    throw new BadZipFileError("ZIP member " + entry.name + " failed its CRC check");
  }
}

/** 压缩方法与加密位：不支持的组合要在读任何数据之前就报出来。 */
function assertReadable(entry) {
  if (entry.flags & ZIP_FLAG_ENCRYPTED) {
    throw new BadZipFileError(
      "File " + entry.name + " is encrypted, password required for extraction",
    );
  }
  if (entry.method !== ZIP_METHOD_STORED && entry.method !== ZIP_METHOD_DEFLATED) {
    throw new CheckError(compressionMessage(entry.method));
  }
}

/** 不支持的压缩方法：文案对齐 zipfile._get_decompressor（bzip2/lzma/zstd 已识别）。 */
function compressionMessage(method) {
  const names = { 12: "bzip2", 14: "lzma", 93: "zstd" };
  const name = names[method];
  return name
    ? "compression type " + method + " (" + name + ") is not supported"
    : "That compression method is not supported (" + method + ")";
}

/**
 * 在任何内容被读进内存之前，按声明体积拒收超预算的包。
 *
 * 为什么先算总量再读：ZIP 放大比可达 1000:1 以上，等成员已经进内存再判断就已经 OOM 了，
 * 所以这条检查必须排在 CRC 校验与所有解压之前。
 * 为什么逐成员也要判：总量不超时，单个巨型部件仍可独占全部内存。
 * 为什么只统计 XML 成员：见 isXmlMember 的说明 —— 把图片算进来会误伤正常的大文档。
 * 为什么按声明体积判断是安全的：解压被 file_size 硬截断（见 inflateMember），所以
 * 「声明体积」就是单个成员真正能被读进内存的上限；谎报更小的体积只会让成员读不全，
 * 并在 CRC 校验上失败，不会绕过预算。
 */
function assertWithinByteBudget(entries) {
  let total = 0;
  for (const entry of entries) {
    if (!isXmlMember(entry.name)) continue;
    if (entry.fileSize > MAX_MEMBER_BYTES) {
      throw new CheckError(
        "ZIP member " +
          entry.name +
          " declares " +
          entry.fileSize +
          " bytes, over the " +
          MAX_MEMBER_BYTES +
          " byte per-member limit",
      );
    }
    total += entry.fileSize;
  }
  if (total > MAX_TOTAL_BYTES) {
    throw new CheckError(
      "ZIP XML members declare " +
        total +
        " bytes in total, over the " +
        MAX_TOTAL_BYTES +
        " byte decompression budget",
    );
  }
}

export { CP437_HIGH };
export { CRC_INIT };
export { CRC_TABLE };
export { IO_CHUNK_BYTES };
export { UINT16_MAX };
export { UINT32_MAX };
export { ZIP64_EOCD_SIGNATURE };
export { ZIP64_LOCATOR_SIGNATURE };
export { ZIP_CENTRAL_HEADER_SIZE };
export { ZIP_CENTRAL_SIGNATURE };
export { ZIP_EOCD_SIGNATURE };
export { ZIP_EOCD_SIZE };
export { ZIP_FLAG_ENCRYPTED };
export { ZIP_FLAG_UTF8 };
export { ZIP_LOCAL_HEADER_SIZE };
export { ZIP_LOCAL_SIGNATURE };
export { ZIP_MAX_COMMENT };
export { ZIP_METHOD_DEFLATED };
export { ZIP_METHOD_STORED };
export { ZipArchive };
export { applyZip64Extra };
export { assertReadable };
export { assertWithinByteBudget };
export { compressionMessage };
export { crc32Final };
export { crc32Update };
export { decodeCp437 };
export { inflateMember };
export { readMemberBytes };
export { verifyMemberIntegrity };
export { writeChunk };
