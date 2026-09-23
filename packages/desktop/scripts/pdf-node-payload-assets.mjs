// pdf 插件的 Node 运行时载荷：把两个 MIT 纯 JS 库（pdfkit / fontkit）用 esbuild 打成
// **自包含 CJS bundle**，stage 到 `<插件根>/scripts/pdf-node/<库>.cjs`。
//
// ## 为什么需要载荷
// 技能正文（skills/pdf/SKILL.md）要"从零制作 PDF"：流式排版、表格、页码、字体子集嵌入。
// pdfkit 提供排版与 PDF 写出（内建自动断行/自动分页/两遍页码），fontkit 用来**解析系统字体文件**
// —— 这是本能力最硬的一环：Linux/macOS 上的中文正文字体基本都是 `.ttc` 集合，pdfkit 的
// `registerFont(path)` 在集合上会抛 `this.font.createSubset is not a function`，必须给出
// **PostScript 面名**，而面名只能通过解析集合得到（实测见 .reverse/38-pdf/PDF-FEASIBILITY.md §4）。
// 两个库都是纯 JS（0 原生模块、0 install 脚本），因此可以随包分发、完全离线。
//
// ## 为什么不放 node_modules
// 与 office 三库同因：seed 阶段的 `shouldSkipDirectory`（bundled-plugins.ts）只在
// 「插件根直属 + 顶层白名单含 node_modules」时保留 node_modules，**任何嵌套层一律丢弃**；
// bundle 里没有 node_modules 目录，从根上不受该规则与 electron-builder `util/filter.js`
// 同款特判的影响。`scripts` 本来就在三份顶层白名单里，所以落点选它。
//
// ## 复用而不是复制
// CJS 入口解析、自包含三条断言、进程内打包缓存全部复用 office-node-payload-assets.mjs 的导出
// （见那边的 `export { … }` 注释）：那些坑是踩出来的，复制一份就是重挖一遍。
// 与 office 的差异只有三处：不需要 S3 stub、没有禁止分发的包、**pdfkit 必须内联 fontkit**。
//
// ## 顺序约束（两处调用点都不可颠倒）
// 必须在 `stageOfficialPlugins()` / `stageRemoteOfficialPlugins()` **之后**调用：那一步会
// cpSync 插件的 `scripts` 目录，而载荷落点就在 `<plugin>/scripts/pdf-node/`，顺序反了会被覆盖。
//
// ## 与"不注册半成品"的关系
// 载荷落盘是构建期的一半；运行期的另一半是 bootstrap 的 `requiredSeedPaths`（那里钉住了
// `scripts/pdf-node/*.cjs`）。两层都在的理由：构建期拦住"忘了打包"，运行期拦住"seed 后文件丢了"
// 或"从源树运行但没跑过 staging"—— 后者正是 task-6 实测到的失效形态（插件已启用、载荷不在）。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { buildLibraryBundle, resolveInstalledPackage } from "./office-node-payload-assets.mjs";

const require = createRequire(import.meta.url);

/**
 * 库 → 插件 → 产物文件名。
 *
 * `fontkit.cjs` 单独出一份而不是"从 pdfkit 的产物里再导出一遍"：`scripts/pdf-fonts.mjs` 需要
 * 直接读字体集合（列面、判可变字体、测字形覆盖），走 pdfkit 内部的内联 fontkit 拿不到这些 API。
 */
export const PDF_NODE_BUNDLES = [
  { file: "pdfkit.cjs", library: "pdfkit", plugin: "pdf-plugin" },
  { file: "fontkit.cjs", library: "fontkit", plugin: "pdf-plugin" },
];

/** 载荷在插件目录内的相对落点（技能、生成器与字体助手按它 require）。 */
const PDF_NODE_PAYLOAD_DIR = "scripts/pdf-node";

export const PDF_NODE_PAYLOAD_RELATIVE_DIR = PDF_NODE_PAYLOAD_DIR;

/**
 * 必须内联的包（正向护栏，语义同 office 的 REQUIRED_BUNDLED_PACKAGES）。
 *
 * pdfkit 的字体能力由 fontkit 承担（子集化、CFF 处理、字符覆盖查询）。如果哪天 fontkit 被
 * external 掉，产物仍然是"自包含"（没有裸 require）—— 因为它会变成 require("fontkit") 这种
 * 我们断言能抓到的形态；但若有人把它 stub 成空实现，构建期只有这条正向断言能发现
 * "能力被静默 stub 掉"（office 的 `unzipper` 就是这样丢过一次）。
 */
const REQUIRED_PDF_BUNDLED_PACKAGES = {
  pdfkit: ["fontkit"],
  fontkit: [],
};

const PAYLOAD_LABEL = "pdf-node-payload";

/**
 * 每个产物在**运行时必须真的具备**的 API —— 构建期直接 require 产物来断言。
 *
 * 为什么这条不能省（task-9 实测教训）：fontkit@2.0.4 同时有
 * `exports.node.require`（Node 构建）与顶层 `exports.require`（浏览器构建），
 * 取错一个仍能打包成功、也能 require 成功，但产物里**没有 openSync/open** ——
 * 字体发现于是永远返回"没有可用字体"，用户看到的是一句"系统缺中文字体"的假诊断，
 * 而真实原因是打包选错了入口。静态自包含断言（非内置 require / 动态 require）抓不到这类问题。
 */
const REQUIRED_BUNDLE_API = {
  fontkit: (api) => typeof api?.openSync === "function" && typeof api?.create === "function",
  // pdfkit 的 CJS 产物把构造器本身作为 module.exports（实测：typeof === "function"，
  // 上面挂着 LineWrapper），所以"是函数"就算合格；ESM 互操作形状也一并接受。
  pdfkit: (api) => typeof api === "function" || typeof api?.PDFDocument === "function",
};

/** require 一份刚落盘的 bundle 并断言它的 API（两种 CJS 互操作形状都认）。 */
function assertBundleApi({ library, target }) {
  const loaded = require(target);
  const api = REQUIRED_BUNDLE_API[library]?.(loaded) ? loaded : loaded?.default;
  if (!REQUIRED_BUNDLE_API[library]?.(api)) {
    throw new Error(
      `[${PAYLOAD_LABEL}] ${library} 产物缺少必需 API（${Object.keys(loaded).join(",")}）：` +
        "多半打进了浏览器/中性入口（如 fontkit 的 dist/browser.cjs 没有 openSync）。" +
        "这属于「能打包、能 require，但能力不在」的静默失效，必须在构建期拦下。",
    );
  }
}

/** 逐库打包（复用 office 的实现：入口解析 + 三条自包含断言 + 进程内缓存）。 */
async function buildPdfBundle({ library, lookupRoots }) {
  return buildLibraryBundle({
    esbuildPlugins: [],
    label: PAYLOAD_LABEL,
    library,
    lookupRoots,
    requiredPackages: REQUIRED_PDF_BUNDLED_PACKAGES[library] ?? [],
  });
}

/**
 * 把 pdfkit / fontkit 的 bundle stage 到 `<glmDir>/packages/pdf-plugin/scripts/pdf-node/`。
 *
 * 返回逐库的版本/体积/内联包清单（构建日志、出包前校验与许可登记都用它）；任一库缺失或产物
 * 不自包含即抛错 —— 宁可让构建失败，也不要产出一个"插件在、能力不在"的分发物。
 */
export async function stagePdfNodePayloads({ lookupRoots, glmDir }) {
  const staged = [];
  for (const payload of PDF_NODE_BUNDLES) {
    const built = await buildPdfBundle({ library: payload.library, lookupRoots });
    const pluginRoot = resolve(glmDir, "packages", payload.plugin);
    if (!existsSync(pluginRoot)) {
      throw new Error(
        `[${PAYLOAD_LABEL}] 插件目录不存在：${pluginRoot}；stagePdfNodePayloads() 必须在 stageOfficialPlugins() 之后调用`,
      );
    }
    const targetRoot = resolve(pluginRoot, PDF_NODE_PAYLOAD_DIR);
    mkdirSync(targetRoot, { recursive: true });
    const target = resolve(targetRoot, payload.file);
    // 先删再写：同一个 glm 目录连续 stage（桌面 → 远端）时，避免上一次构建留下、本次已不再产出的
    // 旧文件被 seed 进缓存（office 同款处理）。
    rmSync(target, { force: true });
    writeFileSync(target, built.code);
    if (!existsSync(target) || statSync(target).size !== built.bytes) {
      throw new Error(`[${PAYLOAD_LABEL}] ${payload.library} bundle 落盘校验失败：${target}`);
    }
    assertBundleApi({ library: payload.library, target });
    staged.push({
      bytes: built.bytes,
      file: payload.file,
      library: payload.library,
      packages: built.packages,
      plugin: payload.plugin,
      sha256: built.sha256,
      target,
      version: built.version,
    });
  }
  return staged;
}

/**
 * 出包前的"载荷与许可登记同源"自检：把 stage 出的产物哈希与内联包清单交给调用方核对。
 *
 * 存在的理由与 office 的 `bundleSha256` 口径一致：许可门禁管的是**仓库安装树**，而分发物是
 * bundle —— 两者可能分叉（office 的 unzipper 就是这么分叉过一次）。调用方拿到这些哈希后可以在
 * 日志里留痕，出问题时能对上"用户装的那份到底是哪次构建"。
 */
export function describeStagedPdfPayloads(staged) {
  return staged.map((item) => ({
    library: `${item.library}@${item.version}`,
    sha256: createHash("sha256").update(item.sha256).digest("hex").slice(0, 16),
    packages: item.packages,
  }));
}

/** 仅用于诊断：确认某个库真的能被解析到（错误信息里给出"先 pnpm install"的可操作提示）。 */
export function resolvePdfLibraryRoot(library, lookupRoots) {
  return resolveInstalledPackage(library, lookupRoots);
}
