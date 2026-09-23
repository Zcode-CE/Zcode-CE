// --- 来源与归属 ---
// 归属:      ZCode-CE 自研（self）。无上游来源，不回写任何上游。
// 由来:      原型阶段的实测结论固化：① Linux/macOS 主流中文正文字体是 **.ttc 集合**，
//            而 pdfkit 的 registerFont(path) 在集合上会抛 "this.font.createSubset is not a function"
//            —— 必须给出 **PostScript 面名**（familyName 不行：实测 fontkit 按 family 查集合返回 null）；
//            ② 无差别遍历全系统字体（本机 1,569 个字体文件 / 1,016 个面）找 CJK 覆盖要 752 ms 且
//            会选中 **JP/Black** 这种错面；先按文件名筛候选 + 偏好排序后 13 个候选、83 ms；
//            ③ 可变字体注册必抛（Variation settings must be ...），直接排除。
// 本模块:    字体发现与面解析。返回 { file, postscriptName } 供 pdfkit 注册；
//            覆盖不全时返回 missing 列表，由调用方**失败关闭**（本模块不抛，因为"缺哪些字"是要报给
//            用户的关键信息，见 .reverse/38-pdf/PDF-FEASIBILITY.md §4）。
// 依赖:      随包载荷 fontkit（scripts/pdf-node/fontkit.cjs，由打包链 stage）。
//            **载荷缺失时必须报错，不许静默降级成「用某个拉丁字体凑合」**——那会产出豆腐 PDF。
// ---------------------------------------------------------------------------
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);

/** 载荷路径：与本模块同级的 scripts/pdf-node/（打包链 stage，不入库）。 */
const FONTKIT_PAYLOAD = new URL("./pdf-node/fontkit.cjs", import.meta.url);

/** 系统字体目录（跨平台；只列常规位置，不做全盘扫描）。 */
export function fontDirectories() {
  if (platform() === "win32") {
    return [
      join(process.env.WINDIR ?? "C:\\Windows", "Fonts"),
      join(process.env.LOCALAPPDATA ?? homedir(), "Microsoft", "Windows", "Fonts"),
    ];
  }
  if (platform() === "darwin") {
    return ["/System/Library/Fonts", "/Library/Fonts", join(homedir(), "Library", "Fonts")];
  }
  return [
    "/usr/share/fonts",
    "/usr/local/share/fonts",
    join(homedir(), ".local", "share", "fonts"),
    join(homedir(), ".fonts"),
  ];
}

/** 偏好表：越靠前越优先。**简体优先于繁体/日文/韩文**（同源泛 CJK 字体里 JP 面会把汉字写成日文字形）。 */
const FAMILY_PREFERENCES = [
  {
    role: "sans",
    patterns: [
      /NotoSansCJK|NotoSansSC|NotoSansHans|SourceHanSans|SarasaGothic|Sarasa-SC|WenQuanYi|MicrosoftYaHei|msyh|PingFang|HiraginoSans|SimHei|DroidSansFallback/i,
    ],
  },
  { role: "serif", patterns: [/NotoSerifCJK|NotoSerifSC|SourceHanSerif|Songti|SimSun|STSong/i] },
];
const SCRIPT_PREFERENCES = [/sc\.|-SC-|SC-|Hans/i, /tc\.|-TC-|TC-|Hant/i, /kr\.|-KR-/i, /jp\.|-JP-/i];
const WEIGHT_PREFERENCES = [
  /Regular/i,
  /Book|Normal/i,
  /Medium|DemiLight/i,
  /SemiBold|Bold/i,
  /Light|Thin|Black/i,
];
const BOLD_FACE_PATTERN = /Bold|SemiBold|Heavy|Black/i;
const FONT_FILE_PATTERN = /\.(ttf|ttc|otf|otc)$/i;
const MAX_DEPTH = 3;
const MONO_PENALTY = /Mono/i;

function listFontFiles() {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (FONT_FILE_PATTERN.test(entry.name)) found.push(full);
    }
  };
  for (const dir of fontDirectories()) walk(dir, 0);
  return found;
}

function loadFontkit() {
  if (!existsSync(FONTKIT_PAYLOAD)) {
    throw new Error(
      "font payload is missing: " +
        FONTKIT_PAYLOAD.pathname +
        " (the plugin was installed without its staged payload; this is a broken build, not a missing package - do not install anything)",
    );
  }
  const loaded = require(FONTKIT_PAYLOAD.pathname);
  // esbuild 的 CJS 互操作可能把 ESM 命名导出挂在 default 上，两种形状都认；
  // 都认不出就**响亮失败** —— 否则解析循环里的 per-file try/catch 会把它吞成
  // "本机没有可用字体"，用户拿到的是假诊断（task-9 实测踩过：bundle 打进了浏览器入口）。
  const api = typeof loaded?.openSync === "function" ? loaded : loaded?.default;
  if (typeof api?.openSync !== "function") {
    throw new Error(
      "font payload does not expose openSync(): " + FONTKIT_PAYLOAD.pathname +
        "（构建产物选错了入口或损坏；这是构建缺陷，不要安装任何包）",
    );
  }
  return api;
}

/** 面名打分：语言优先级 ×10，字重优先级 ×1，等宽 −20（等宽覆盖汉字但不适合正文）。 */
function scoreFace(postscriptName) {
  let score = 0;
  SCRIPT_PREFERENCES.forEach((pattern, index) => {
    if (pattern.test(postscriptName)) score += (SCRIPT_PREFERENCES.length - index) * 10;
  });
  WEIGHT_PREFERENCES.forEach((pattern, index) => {
    if (pattern.test(postscriptName)) score += WEIGHT_PREFERENCES.length - index;
  });
  if (MONO_PENALTY.test(postscriptName)) score -= 20;
  return score;
}

function neededCodePoints(text) {
  return [...new Set([...text].map((char) => char.codePointAt(0)))].filter((code) => code > 0x7f);
}

/** 打开一个字体文件，返回可用的面（排除可变字体：pdfkit 注册会抛，实测）。 */
function openFaces(fontkit, file) {
  let opened;
  try {
    opened = fontkit.openSync(file);
  } catch {
    return [];
  }
  return (opened.fonts ?? [opened]).filter(
    (face) => face.postscriptName && Object.keys(face.variationAxes ?? {}).length === 0,
  );
}

/** 在给定文件列表里扫描"能覆盖全部 needed 码点"的面，按 score 降序返回。 */
function scanCoveringFaces({ fontkit, files, needed, faceFilter }) {
  const scanned = [];
  for (const file of files) {
    for (const face of openFaces(fontkit, file)) {
      if (faceFilter && !faceFilter(face.postscriptName)) continue;
      if (needed.length > 0 && !needed.every((code) => face.hasGlyphForCodePoint(code))) continue;
      scanned.push({
        familyName: face.familyName,
        face: face.postscriptName,
        file,
        score: scoreFace(face.postscriptName),
      });
    }
  }
  return scanned.sort((a, b) => b.score - a.score);
}

function toResult(best, needed, extra = {}) {
  return {
    boldFallback: false,
    candidates: [],
    file: best.file,
    familyName: best.familyName,
    missing: [],
    postscriptName: best.face,
    ...extra,
  };
}

function toMissingResult(needed) {
  return {
    boldFallback: false,
    candidates: [],
    file: null,
    familyName: null,
    missing: needed.map((code) => String.fromCodePoint(code)),
    postscriptName: null,
  };
}

function filesForRole(role, files) {
  const wanted = FAMILY_PREFERENCES.find((entry) => entry.role === role) ?? FAMILY_PREFERENCES[0];
  return files.filter((file) => wanted.patterns.some((pattern) => pattern.test(file)));
}

/**
 * 从指定字体文件里挑一个面（用户指定路径的逃生通道）。
 *
 * `preferName` 给定时精确匹配该面名；不给定时按覆盖度 + 打分挑，挑不到就返回 missing。
 */
export function resolveFaceFromFile(file, text, options = {}) {
  if (!existsSync(file)) throw new Error("font file not found: " + file);
  const fontkit = loadFontkit();
  const needed = neededCodePoints(text);
  const faces = openFaces(fontkit, file);
  if (faces.length === 0) throw new Error("no usable face in font file: " + file);
  if (options.preferName) {
    const match = faces.find((face) => face.postscriptName === options.preferName);
    if (!match) {
      throw new Error(
        "font face not found in " + file + ": " + options.preferName +
          " (available: " + faces.map((face) => face.postscriptName).join(", ") + ")",
      );
    }
    const missing = needed.filter((code) => !match.hasGlyphForCodePoint(code));
    return {
      boldFallback: false,
      candidates: [],
      file,
      familyName: match.familyName,
      missing: missing.map((code) => String.fromCodePoint(code)),
      postscriptName: match.postscriptName,
    };
  }
  const scanned = [];
  for (const face of faces) {
    if (needed.length > 0 && !needed.every((code) => face.hasGlyphForCodePoint(code))) continue;
    scanned.push({ face: face.postscriptName, familyName: face.familyName, file, score: scoreFace(face.postscriptName) });
  }
  scanned.sort((a, b) => b.score - a.score);
  if (scanned.length === 0) return toMissingResult(needed);
  return toResult(scanned[0], needed, { candidates: scanned.slice(0, 5) });
}

/**
 * 找到能覆盖 `text` 的字体面。
 *
 * role: "sans"（默认）| "serif" | "bold"。
 * `bold` 只在**确实存在覆盖全部码点的粗体面**时返回它；否则退回 sans 面并置
 * `boldFallback: true` —— 这是**如实声明**（合成粗体不在 PDFKit 的能力里），不是静默降级：
 * 调用方必须把该标志写进交付说明。
 */
export function resolveFontFace(text, options = {}) {
  const role = options.role ?? "sans";
  const fontkit = loadFontkit();
  const needed = neededCodePoints(text);
  const files = listFontFiles();
  if (role === "bold") {
    const bold = scanCoveringFaces({
      faceFilter: (name) => BOLD_FACE_PATTERN.test(name),
      files: filesForRole("sans", files),
      fontkit,
      needed,
    });
    if (bold.length > 0) return toResult(bold[0], needed, { candidates: bold.slice(0, 5) });
    const sans = resolveFontFace(text, { ...options, role: "sans" });
    return { ...sans, boldFallback: true };
  }
  const scanned = scanCoveringFaces({ files: filesForRole(role, files), fontkit, needed });
  if (scanned.length === 0) return toMissingResult(needed);
  return toResult(scanned[0], needed, { candidates: scanned.slice(0, 5) });
}

/**
 * 只做覆盖检查（不选面）：给定字体文件与面名，返回缺失码点字符。
 *
 * 生成器在**渲染前**用它对最终选定的面复核一遍；渲染后再用 check_pdf --text 从产物复核。
 * 两道都要有：前者拦在写文件之前，后者打到最终消费点（用户拿到的那个 PDF）。
 */
export function findMissingGlyphs({ file, postscriptName, text }) {
  const fontkit = loadFontkit();
  const faces = openFaces(fontkit, file);
  const face = postscriptName ? faces.find((item) => item.postscriptName === postscriptName) : faces[0];
  if (!face) throw new Error("font face not found: " + file + " (" + postscriptName + ")");
  return neededCodePoints(text).filter((code) => !face.hasGlyphForCodePoint(code)).map((code) => String.fromCodePoint(code));
}

/** 各平台安装 CJK 字体的建议命令（只给命令，不代跑：见 docs/development/pdf-plugins.md）。 */
export function fontInstallHints() {
  if (platform() === "win32") {
    return ["Windows：从字体上游安装（例如 Noto Sans CJK SC），安装后重新运行本命令"];
  }
  if (platform() === "darwin") {
    return ["macOS：brew install --cask font-noto-sans-cjk-sc（或从上游安装后重新运行本命令）"];
  }
  return [
    "Debian/Ubuntu：sudo apt install fonts-noto-cjk",
    "Fedora：sudo dnf install google-noto-sans-cjk-fonts",
    "Arch：sudo pacman -S noto-fonts-cjk",
  ];
}

if (import.meta.url === "file://" + process.argv[1]) {
  const text = process.argv.slice(2).join(" ") || "中文测试";
  console.log(JSON.stringify(resolveFontFace(text), null, 2));
}
