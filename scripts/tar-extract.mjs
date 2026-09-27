// 纯 Node 的 tar.gz 解包（只支持 ustar/pax 常规条目，够本仓库的发行包用）。
//
// 为什么不用外部 `tar`：Windows runner 上 `tar` 是 GNU tar，它把 `D:\a\...` 当成
// **远程归档**语法（`host:path`）⇒ stdin 为空 ⇒ `gzip: stdin: unexpected end of file`。
// 实测（run 36333516677）：发行包的 smoke 在 Windows 上正是红在这里。
// 用 Node 原生 zlib 解包既跨平台又零外部依赖，且与本仓「核心能力零外部依赖」的口径一致。
//
// 有意不做的事：不支持符号链接以外的特殊条目（设备文件、FIFO）、不支持 GNU 长名扩展的
// 全部变体。发行包由 scripts/deterministic-tar-archive.mjs 产出，只含常规文件与目录。
import { createGunzip } from "node:zlib";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Writable } from "node:stream";

const BLOCK = 512;

/** 把整个 .tar.gz 读成解压后的 Buffer（发行包约 200 MB 级，可接受）。 */
async function gunzipAll(archivePath) {
  const compressed = await readFile(archivePath);
  const chunks = [];
  await pipeline(
    Readable.from(compressed),
    createGunzip(),
    new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
    }),
  );
  return Buffer.concat(chunks);
}

/** 读一个 NUL 结尾的字符串字段。 */
function readString(buffer, offset, length) {
  const end = buffer.indexOf(0, offset);
  const stop = end === -1 || end > offset + length ? offset + length : end;
  return buffer.toString("utf8", offset, stop);
}

/** 八进制字段（tar 用 NUL 或空格结尾）。 */
function readOctal(buffer, offset, length) {
  const raw = readString(buffer, offset, length).trim();
  if (raw === "") return 0;
  const value = Number.parseInt(raw, 8);
  return Number.isFinite(value) ? value : 0;
}

/**
 * 解包到 targetDirectory。
 *
 * 路径安全：拒绝绝对路径与 `..` 越界（tar 里可以写 `../../etc/x`），
 * 这与本仓「外部输入一律 fail-closed」的口径一致。
 */
export async function extractTarGz(archivePath, targetDirectory) {
  const buffer = await gunzipAll(archivePath);
  let offset = 0;
  let entries = 0;
  /** `L` 条目（GNU 长名）携带的、属于**下一个**条目的真实名字。 */
  let pendingLongName = null;

  while (offset + BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK);
    // 全零块 = 归档结束。
    if (header.every((byte) => byte === 0)) break;

    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155); // ustar 的路径前缀
    const fullName = prefix ? `${prefix}/${name}` : name;
    const size = readOctal(header, 124, 12);
    // 权限位：tar 记录的是 12 位八进制（含 setuid/setgid/sticky），取低 9 位（rwxrwxrwx）。
    const mode = readOctal(header, 100, 8) & 0o777;
    const typeFlag = String.fromCharCode(header[156] ?? 0);
    const linkName = readString(header, 157, 100);
    offset += BLOCK;

    const dataStart = offset;
    const dataEnd = dataStart + size;
    // 条目数据按 512 对齐。
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (typeFlag === "x" || typeFlag === "g") {
      // pax 扩展头：本仓库的打包器不产出（实测 tar 里 0 条）。
      continue;
    }
    if (typeFlag === "L") {
      // GNU 长名：本条目的**数据体**是下一个条目真实的名字（超过 ustar 的 100 字节上限时使用）。
      // 实测：发行包里有 13 条（数量正好等于首版实现"缺失"的文件数）—— 我第一版误以为
      // 「本仓库不产出」而直接跳过，于是那 13 个超长路径文件被静默丢弃。
      // 这正是本仓反复记的形态：**未验证的假设写成注释，然后照着它跳过**。
      // 去掉尾部 NUL 填充：**不用正则** —— 匹配 NUL 会触发 lint 的
      // `no-control-regex`（本仓基线是「0 error / 84 warning」，新代码不该加 warning）。
      // 按码点从尾部裁更直白，也不依赖正则语义。
      const rawLongName = buffer.toString("utf8", dataStart, dataEnd);
      let longNameEnd = rawLongName.length;
      while (longNameEnd > 0 && rawLongName.charCodeAt(longNameEnd - 1) === 0) longNameEnd -= 1;
      pendingLongName = rawLongName.slice(0, longNameEnd);
      continue;
    }

    const effectiveName = pendingLongName ?? fullName;
    pendingLongName = null;
    const normalized = normalize(effectiveName).split(sep).join("/");
    if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
      throw new Error(`tar 条目路径越界，拒绝解包：${effectiveName}`);
    }
    const destination = join(targetDirectory, normalized);

    if (typeFlag === "5") {
      await mkdir(destination, { recursive: true });
      entries += 1;
      continue;
    }
    if (typeFlag === "2") {
      await mkdir(dirname(destination), { recursive: true });
      await symlink(linkName, destination);
      entries += 1;
      continue;
    }
    if (typeFlag !== "0" && typeFlag !== "" && typeFlag !== "\0") {
      // 未知类型一律跳过（而不是猜）—— 发行包不该有它们，真出现时由上层断言暴露。
      continue;
    }

    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, buffer.subarray(dataStart, dataEnd));
    // 恢复 tar 里记录的权限位 —— 这一步不可省：smoke 会断言解包产物的
    // bin/zcode.mjs 是 755（旁路模块 644），而 writeFile 只给默认 644。
    // 实测踩过：漏掉 chmod 时该断言会**假红**（我第一版实现就是这样）。
    await chmod(destination, mode);
    entries += 1;
  }

  return { entries };
}
