#!/usr/bin/env node
/**
 * 校验器对**真实办公库产物**与**命名空间声明顺序**的回归测试（FIX-DOCX / task-76）。
 *
 * 为什么需要这组测试：既有 checkOffice.test.mjs 的 13 个夹具全部是「Python zipfile 手写
 * 的小 XML」，**没有一个来自真实办公库产物**，也**没有一个含 `mc:Ignorable`**。
 * 于是 `check_office.mjs` 把 docx 库自己产出的文档判成 fail（`unbound prefix`）时，
 * 整组测试仍然是绿的 —— 这是「验证停在人造输入」的盲区，与「验证停在中间产物」同型。
 *
 * 本文件补的三类用例（对应任务书的 ①②③）：
 *  1. **真实库产物往返**：用随包分发的 `docx`（插件自己的 dependency，与
 *     `scripts/office-node/docx.cjs` 同源同版本）真生成一份 .docx，再用技能正文调用的
 *     `scripts/check_office.mjs` 校验，必须 pass —— 打到**最终消费点**而不是自造夹具。
 *  2. **`mc:Ignorable` 顺序夹具**：把「先使用前缀、后声明 xmlns」的形状单独锁死
 *     （这是 docx 库产出的真实顺序，也是本缺陷的直接触发条件）。
 *  3. **反向用例**：真的未声明前缀、重复声明、保留前缀等**仍然必须 fail** ——
 *     防止修复「修过头」把校验器变成放行非法输入。
 *
 * 第 3 类不是可选项：本修复把「按属性文档序解析」改成「先收集本元素 xmlns 再解析」，
 * 如果只测第 1、2 类，一个「干脆不做前缀校验」的实现同样能全绿。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import test from "node:test";

const testDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(testDir, "..");
const scriptsDir = join(pluginRoot, "scripts");
const checker = join(scriptsDir, "check_office.mjs");

// ===== 最小 ZIP 写入器（只为造夹具，不复用校验器的只读实现） =====

const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_VERSION = 20;
const ZIP_METHOD_DEFLATED = 8;
const ZIP_FLAG_UTF8 = 0x0800;

/** 用 node:zlib 的 crc32 + deflateRaw 拼一个最小可读 ZIP；只支持 deflate。 */
function writeZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const raw = Buffer.from(text, "utf8");
    const deflated = deflateRawSync(raw);
    const crc = crc32(raw) >>> 0;
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(ZIP_LOCAL_SIGNATURE, 0);
    localHeader.writeUInt16LE(ZIP_VERSION, 4);
    localHeader.writeUInt16LE(ZIP_FLAG_UTF8, 6);
    localHeader.writeUInt16LE(ZIP_METHOD_DEFLATED, 8);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(deflated.length, 18);
    localHeader.writeUInt32LE(raw.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    local.push(localHeader, nameBytes, deflated);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(ZIP_CENTRAL_SIGNATURE, 0);
    centralHeader.writeUInt16LE(ZIP_VERSION, 4);
    centralHeader.writeUInt16LE(ZIP_VERSION, 6);
    centralHeader.writeUInt16LE(ZIP_FLAG_UTF8, 8);
    centralHeader.writeUInt16LE(ZIP_METHOD_DEFLATED, 10);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(deflated.length, 20);
    centralHeader.writeUInt32LE(raw.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, nameBytes);

    offset += localHeader.length + nameBytes.length + deflated.length;
  }
  const centralStart = offset;
  const centralBytes = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(ZIP_EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...local, centralBytes, eocd]);
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-' +
  'officedocument.wordprocessingml.document.main+xml"/></Types>';

/**
 * 造一份最小 docx；`rootAttrs` 原样拼进 `<w:document>` 开始标签，用来精确控制属性顺序。
 *
 * 属性顺序是本缺陷的**唯一变量**，所以夹具必须能逐字控制它，不能靠某个库「恰好」产出。
 */
function docxWithRootAttributes(rootAttrs) {
  const document =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    "<w:document " +
    rootAttrs +
    "><w:body><w:p><w:r><w:t>hello</w:t></w:r></w:p></w:body></w:document>";
  return writeZip([
    ["[Content_Types].xml", CONTENT_TYPES],
    ["word/document.xml", document],
  ]);
}

const MC_URI = "http://schemas.openxmlformats.org/markup-compatibility/2006";
const W_URI = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

let workdir = null;
function workDir() {
  if (workdir === null) workdir = mkdtempSync(join(tmpdir(), "zcode-checkoffice-prefix-"));
  return workdir;
}

/** 跑校验器，返回 { rc, report }。 */
function runChecker(file) {
  const result = spawnSync(process.execPath, [checker, file], { encoding: "utf8" });
  let report = null;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    report = null;
  }
  return { rc: result.status, report, stdout: result.stdout, stderr: result.stderr };
}

/**
 * 从 ZIP 里取出 `word/document.xml` 的开始标签（只读本地头 + inflateRaw）。
 *
 * 用途是**自检夹具**：断言真实库产物确实带 `mc:Ignorable` 且声明顺序满足触发条件，
 * 避免「夹具退化成又一个人造输入」而测试仍然绿（本缺陷漏网的正是这个形态）。
 * 纯 node:zlib，不引入 python3 依赖。
 */
function rootTagOf(file) {
  const buffer = readFileSync(file);
  const nameBytes = Buffer.from("word/document.xml", "utf8");
  for (let cursor = 0; cursor + 30 <= buffer.length; cursor += 1) {
    if (buffer.readUInt32LE(cursor) !== ZIP_LOCAL_SIGNATURE) continue;
    const nameLength = buffer.readUInt16LE(cursor + 26);
    const extraLength = buffer.readUInt16LE(cursor + 28);
    if (buffer.subarray(cursor + 30, cursor + 30 + nameLength).compare(nameBytes) !== 0) continue;
    const dataStart = cursor + 30 + nameLength + extraLength;
    const compressed = buffer.readUInt32LE(cursor + 18);
    const text = inflateRawSync(buffer.subarray(dataStart, dataStart + compressed)).toString(
      "utf8",
    );
    const match = /<w:document[^>]*>/.exec(text);
    return match === null ? "" : match[0];
  }
  throw new Error("word/document.xml not found in " + file);
}

/** 造一个夹具文件并校验。 */
function checkFixture(name, rootAttrs) {
  const file = join(workDir(), name + ".docx");
  writeFileSync(file, docxWithRootAttributes(rootAttrs));
  return runChecker(file);
}

test.after(() => {
  if (workdir !== null) rmSync(workdir, { recursive: true, force: true });
});

// ===== ① 真实办公库产物往返（打到最终消费点） =====

/**
 * 用**真实的 docx 库**生成文档再校验。
 *
 * 为什么用插件自己的 `docx` 依赖而不是仓库里手写的 XML：既有夹具全是人造输入，
 * 正是本缺陷漏网的原因。这里生成的是「用户用 docx 技能产出文档」的真实形状，
 * 包括 docx 库固定的 `mc:Ignorable` 前置属性顺序。
 *
 * 为什么不直接用 `scripts/office-node/docx.cjs`：那是**构建产物**（stage 到
 * `cli/dist/` 下、被 .gitignore 忽略），在干净检出上不存在；`docx@9.7.1` 是
 * 本插件 package.json 里声明的同一个库，两者同源同版本，测试里用它才能在任何检出上跑。
 */
test("真实 docx 库产物往返：生成 → 校验 → 必须 pass（FIX-DOCX 主用例）", async () => {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import("docx");
  const document = new Document({
    sections: [
      {
        properties: {},
        children: [
          new Paragraph({ text: "Roundtrip", heading: HeadingLevel.HEADING_1 }),
          new Paragraph({ children: [new TextRun({ text: "generated by the docx library" })] }),
        ],
      },
    ],
  });
  const file = join(workDir(), "library-roundtrip.docx");
  writeFileSync(file, await Packer.toBuffer(document));

  const { rc, report } = runChecker(file);
  assert.equal(
    report?.verdict,
    "pass",
    `docx 库自己产出的文档必须判 pass；实际 rc=${rc} stdout=${report === null ? "(非 JSON)" : JSON.stringify(report)}`,
  );
  assert.equal(rc, 0, "verdict=pass 时退出码应为 0");
  // 夹具必须真的含 mc:Ignorable，否则这条用例会退化成「又一个人造输入」。
  const rootTag = rootTagOf(file);
  const ignorableAt = rootTag.indexOf("mc:Ignorable=");
  const declarationAt = rootTag.indexOf("xmlns:mc=");
  assert.ok(declarationAt !== -1, "夹具应声明 xmlns:mc");
  assert.ok(
    ignorableAt < declarationAt,
    `docx 库的属性顺序应是「先 mc:Ignorable 后 xmlns:mc」（这正是缺陷触发条件），实际: ${rootTag}`,
  );
});

// ===== ② mc:Ignorable 顺序夹具（顺序无关） =====

test("mc:Ignorable 在前、xmlns:mc 在后仍然 pass（命名空间声明与属性顺序无关）", () => {
  const { rc, report } = checkFixture(
    "ignorable-before-decl",
    `mc:Ignorable="w14 w15" xmlns:mc="${MC_URI}" xmlns:w="${W_URI}"`,
  );
  assert.equal(
    report?.verdict,
    "pass",
    "先使用前缀、后声明 xmlns 是合法的（Namespaces in XML 1.0 §6.2），必须 pass",
  );
  assert.equal(rc, 0);
});

test("普通前缀在前、其 xmlns 声明在后仍然 pass（不止 mc 这一种前缀）", () => {
  const { rc, report } = checkFixture(
    "prefix-before-decl",
    `w:space="preserve" xmlns:w="${W_URI}"`,
  );
  assert.equal(report?.verdict, "pass", "任意前缀都不应受属性顺序影响");
  assert.equal(rc, 0);
});

test("声明在前、使用在后仍然 pass（原路径不得被两遍解析改坏）", () => {
  const { rc, report } = checkFixture(
    "decl-before-use",
    `xmlns:w="${W_URI}" xmlns:mc="${MC_URI}" mc:Ignorable="w14"`,
  );
  assert.equal(report?.verdict, "pass", "声明在前是原路径，修复后必须仍然 pass");
  assert.equal(rc, 0);
});

// ===== ③ 反向用例：真非法仍必须 fail（防止修过头） =====

const MUST_FAIL = [
  {
    name: "truly-unbound-prefix",
    label: "真的未声明前缀（同元素内也没有声明）",
    attrs: `zz:x="1" xmlns:w="${W_URI}"`,
    detail: /unbound prefix/,
  },
  {
    name: "unbound-after-decl",
    label: "声明了别的前缀，但该前缀仍未声明",
    attrs: `xmlns:w="${W_URI}" zz:x="1"`,
    detail: /unbound prefix/,
  },
  {
    name: "unbound-before-and-after",
    label: "未声明前缀夹在合法声明之间",
    attrs: `zz:x="1" xmlns:w="${W_URI}" yy:y="2"`,
    detail: /unbound prefix/,
  },
  {
    name: "duplicate-prefix-declaration",
    label: "同一前缀重复声明（expat 报 duplicate attribute）",
    attrs: `xmlns:w="${W_URI}" xmlns:w="urn:other"`,
    detail: /duplicate attribute/,
  },
  {
    name: "reserved-xmlns-prefix",
    label: "保留前缀 xmlns 被声明",
    attrs: `xmlns:xmlns="urn:x" xmlns:w="${W_URI}"`,
    detail: /reserved prefix \(xmlns\)/,
  },
  {
    name: "duplicate-plain-attribute",
    label: "普通属性重名",
    attrs: `xmlns:w="${W_URI}" w:val="1" w:val="2"`,
    detail: /duplicate attribute/,
  },
  {
    name: "unbound-prefix-before-syntax-error",
    label: "未声明前缀 + 后续语法错误（仍须 fail，不得因两遍解析而放行）",
    attrs: `zz:x="1" xmlns:w="${W_URI}" bogus`,
    detail: /not well-formed|unbound prefix/,
  },
];

for (const fixture of MUST_FAIL) {
  test(`反向用例：${fixture.label} 必须 fail`, () => {
    const { rc, report } = checkFixture(fixture.name, fixture.attrs);
    assert.equal(report?.verdict, "fail", `${fixture.label} 必须判 fail（修复不得放松检查）`);
    assert.equal(rc, 1, "verdict=fail 时退出码应为 1");
    const failed = report.checks.find((check) => check.status === "fail");
    assert.ok(failed, "必须有 status=fail 的 check");
    assert.ok(
      typeof failed.detail === "string" && failed.detail.trim().length > 0,
      "fail 必须带非空 detail",
    );
    assert.match(failed.detail, fixture.detail, `detail 文案不符：${failed.detail}`);
  });
}
