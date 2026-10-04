#!/usr/bin/env node
// e2e 夹具：PATH 注入的假 pdftoppm（空白渲染注入）。只被测试复制到临时工作区的 bin/ 下，
// 不是插件的运行时资产（seed 顶层白名单不含 test/，它不会进用户缓存）。
//
// 实现三种形态：
//   pdftoppm -v                                     （Read 工具 Poppler 可用性探测）
//   pdftoppm -png [-r N] [-f N] [-l N] <pdf> <prefix>   （技能两步链的取页命令）
//   pdftoppm -jpeg [-r N] [-f N] [-l N] <pdf> <prefix>  （Read 直读 PDF 时适配器的调用）
// 行为：-png 写全透明 800x600 PNG（与技能「空白/全透明 = 渲染失败」判据同源）；
// -jpeg 写 1x1 纯白 JPEG。每次调用追加一行 JSON 到同目录 calls.jsonl。
//
// 为什么 -png 用真尺寸透明图而不是 1x1：模型与 visual-judge 子代理读图时会看到
// 「整版透明」，与真实空白渲染故障的观感一致，避免「图小得可疑」的旁路推理。

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const argv = process.argv.slice(2);
const logPath = path.join(__dirname, "calls.jsonl");

function log(entry) {
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
}

function fail(error) {
  const message = error && error.message ? error.message : String(error);
  log({ tool: "pdftoppm", argv, status: 1, error: message });
  process.stderr.write(message + "\n");
  process.exit(1);
}

/** 1x1 纯白 JPEG：合法 JPEG，任何图像读取器都看到「纯白单像素」= 空白。 */
const BLANK_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAB//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==",
  "base64",
);

const TRANSPARENT_PNG_WIDTH = 800;
const TRANSPARENT_PNG_HEIGHT = 600;

function crc32Table() {
  const table = new Array(256);
  for (let index = 0; index < 256; index += 1) {
    let current = index;
    for (let round = 0; round < 8; round += 1) {
      current = current & 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
    }
    table[index] = current >>> 0;
  }
  return table;
}

/** 全透明 RGBA PNG：所有像素 RGBA(0,0,0,0)。 */
function transparentPng(width, height) {
  const table = crc32Table();
  const crc32 = (buffer) => {
    let current = ~0;
    for (const byte of buffer) {
      current = table[(current ^ byte) & 0xff] ^ (current >>> 8);
    }
    return (~current) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // color type: RGBA
  header[10] = 0; // compression
  header[11] = 0; // filter
  header[12] = 0; // interlace
  const row = Buffer.alloc(1 + width * 4); // filter byte 0 + RGBA(0,0,0,0)
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const pixels = zlib.deflateSync(raw, { level: 9 });
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk("IHDR", header), chunk("IDAT", pixels), chunk("IEND", Buffer.alloc(0))]);
}

try {
  if (argv[0] === "-v") {
    process.stdout.write("pdftoppm 25.03.0 (e2e fixture: renders blank pages)\n");
    log({ tool: "pdftoppm", argv, status: 0, probe: true });
    process.exit(0);
  }
  const values = new Map();
  let format = null;
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-png") {
      format = "png";
      continue;
    }
    if (arg === "-jpeg" || arg === "-jpg") {
      format = "jpg";
      continue;
    }
    if (arg === "-r" || arg === "-f" || arg === "-l" || arg === "-rx" || arg === "-ry") {
      const next = argv[index + 1];
      if (typeof next !== "string" || next.length === 0) {
        fail("fake pdftoppm: " + arg + " requires a value");
      }
      values.set(arg, next);
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue; // 容忍未识别开关（如 -gray），不当成文件名
    positional.push(arg);
  }
  if (format === null) {
    fail("fake pdftoppm only implements -png or -jpeg output");
  }
  if (positional.length < 2) {
    fail("fake pdftoppm expects <pdf> <output-prefix>");
  }
  const prefix = positional[positional.length - 1];
  const first = Number(values.get("-f") ?? 1);
  const last = Number(values.get("-l") ?? 1);
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first) {
    fail("fake pdftoppm: invalid page range -f " + values.get("-f") + " -l " + values.get("-l"));
  }
  for (let page = first; page <= last; page += 1) {
    const target = prefix + "-" + page + "." + format;
    if (format === "png") {
      fs.writeFileSync(target, transparentPng(TRANSPARENT_PNG_WIDTH, TRANSPARENT_PNG_HEIGHT));
    } else {
      fs.writeFileSync(target, BLANK_JPEG);
    }
  }
  log({ tool: "pdftoppm", argv, status: 0, pages: last - first + 1 });
  process.exit(0);
} catch (error) {
  fail(error);
}
