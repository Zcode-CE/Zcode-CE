// 办公插件的 Node 运行时载荷：把三个 MIT 纯 JS 库（docx / pptxgenjs / exceljs）
// 按「运行时可达闭包」裁剪后 stage 进 glm，供 skills/docx|pptx|xlsx 在 Electron 自带 Node 上直接 require。
//
// 为什么要它：三个办公插件原先依赖系统 python3 + pip 包（python-docx / python-pptx / openpyxl），
// 用户没装就完全不可用。Electron 必然自带 Node，所以改用 Node 库做打底；三库都是纯 JS（0 原生模块、
// 0 install 脚本），裁剪后合计约 4.4 MB（task-58 §8 实测）。
//
// 为什么不是「手工拷一份进仓库」：载荷必须能从已安装的 node_modules 重新生成，否则版本/依赖漂移无感。
// 本模块就是那个构建步骤，落点与 CUA 驱动、koffi 一致（glm/packages/<plugin>/...）。
//
// 裁剪判据（task-58 §8 已验证可复现）：
//   入口 = 三库各自的 CJS 主入口 → 跟随 require()/import()/from 做传递闭包；
//   相对 specifier 按 Node 候选（+.js/.cjs/.mjs/.json、index.*）解析；
//   裸 specifier 按 Node 的 node_modules **逐级向上**查找，并支持 exports 子路径；
//   保留可达文件 + 每个被用到包的 package.json + LICENSE*；
//   丢弃 types/maps/ts/README/docs/tests、@types/*、以及未被入口引用的另一套 dist 变体。
//
// **落点规则（真实成因：hoisted 布局 + 同名多版本嵌套，已由 Lead 实证）**：
// 本仓库 `.npmrc` 是 `node-linker=hoisted`（顶层 0 个符号链接、全是真实目录），所以问题**不是**
// pnpm 符号链接，而是同一包名在树里存在多个版本：根 `node_modules/uuid` = 11.1.0，而
// `node_modules/exceljs/node_modules/uuid` = 8.3.2（exceljs 声明 `uuid: ^8.3.0`）；
// 同理 `archiver-utils/node_modules/{readable-stream,string_decoder}`。
// 按包名扁平落盘会丢掉嵌套版本 → 引用方 require 到根上的另一个版本，或直接 MODULE_NOT_FOUND
// （实测 exceljs 的 `cf-rule-ext-xform.js` 找 `uuid`）。因此：同名只保留一个扁平副本
// （首次出现者胜），版本冲突者按「引用方 → 被引用包」的边嵌套在引用方包下。
// 静态可达性对动态 require 仍是盲区：改裁剪/落点后**必须**用真实仓库根 stage 的载荷跑 smoke。
// 以下为历史说明（假设已被上面这段取代，保留以记录踩坑过程）：
// **已知缺口（当前实现只覆盖 npm 式扁平 hoisted 布局）**：pnpm 的 `node_modules/<pkg>` 是符号链接，
// 真实包体在 `node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>`；跨包依赖因此会解析到 `.pnpm` 里。
// 当前实现按「安装树里 node_modules 之后的那段路径」原样落盘，于是跨包依赖被放进
// `node_modules/.pnpm/...`，而引用方位于 `node_modules/<pkg>/...`，Node 向上查找**找不到**它 ——
// 实测在仓库根（pnpm 布局）stage 出来的载荷，exceljs 读路径会 MODULE_NOT_FOUND。
// 修法（已留 hooks：`collectRuntimeClosure` 返回的 `edges`）：同名多版本时按「引用方 → 被引用包」
// 的边嵌套落盘（`node_modules/<requirer>/node_modules/<dep>`），单一版本才扁平放置。
// 在此之前，载荷构建步骤只对 npm 式扁平树（含 `pnpm node-linker=hoisted`）可用。
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/** plugin 目录名 → 它需要的库、入口、落点目录。 */
const OFFICE_NODE_PAYLOADS = [
  { library: "docx", plugin: "documents-plugin", entry: "dist/index.cjs" },
  { library: "pptxgenjs", plugin: "presentations-plugin", entry: "dist/pptxgen.cjs.js" },
  { library: "exceljs", plugin: "spreadsheets-plugin", entry: "excel.js" },
];

/** 载荷在插件目录内的相对落点（skills 里按这个路径 require）。 */
const OFFICE_NODE_PAYLOAD_DIR = "vendor/office-node";

const SPEC_PATTERNS = [
  /require\(\s*["']([^"']+)["']\s*\)/g,
  /import\s*\(\s*["']([^"']+)["']\s*\)/g,
  /from\s*["']([^"']+)["']/g,
];
const RESOLVE_SUFFIXES = ["", ".js", ".cjs", ".mjs", ".json"];
const RESOLVE_INDEXES = ["index.js", "index.cjs", "index.mjs", "index.json"];

function toPosix(value) {
  return value.split(sep).join("/");
}

/** 在 node_modules 里定位一个已安装包（pnpm hoisted + .pnpm 虚拟 store 两处都找）。 */
function resolveInstalledPackage(packageName, lookupRoots) {
  for (const root of lookupRoots) {
    const direct = resolve(root, "node_modules", packageName);
    if (existsSync(resolve(direct, "package.json"))) return direct;
    const virtualStore = resolve(root, "node_modules", ".pnpm");
    if (!existsSync(virtualStore)) continue;
    const encoded = packageName.replace("/", "+");
    for (const entry of readdirSync(virtualStore)) {
      if (!entry.startsWith(`${encoded}@`)) continue;
      const nested = resolve(virtualStore, entry, "node_modules", packageName);
      if (existsSync(resolve(nested, "package.json"))) return nested;
    }
  }
  throw new Error(
    `[office-node-payload] 找不到已安装的 ${packageName}；请先在仓库根执行 pnpm install（三个库声明在对应插件的 package.json 里）`,
  );
}

function pickFile(base) {
  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = base + suffix;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  for (const index of RESOLVE_INDEXES) {
    const candidate = join(base, index);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

function exportsLeaf(packageRoot, value) {
  if (typeof value === "string") {
    return pickFile(join(packageRoot, value.replace(/^\.\//, "")));
  }
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) {
      const leaf = exportsLeaf(packageRoot, nested);
      if (leaf) return leaf;
    }
  }
  return undefined;
}

/** 解析包入口或 exports 子路径；subpath 为空表示主入口。 */
function packageEntryFile(packageRoot, subpath) {
  let manifest = {};
  const manifestPath = join(packageRoot, "package.json");
  if (existsSync(manifestPath)) {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  }
  if (subpath) {
    const exportsField = manifest.exports;
    if (exportsField && typeof exportsField === "object") {
      const target = exportsField[`./${subpath}`];
      if (target) return exportsLeaf(packageRoot, target);
      return pickFile(join(packageRoot, subpath));
    }
    return pickFile(join(packageRoot, subpath));
  }
  for (const field of [manifest.main, manifest.module]) {
    if (typeof field !== "string") continue;
    const candidate = pickFile(join(packageRoot, field.replace(/^\.\//, "")));
    if (candidate) return candidate;
  }
  if (manifest.exports) {
    const leaf = exportsLeaf(packageRoot, manifest.exports);
    if (leaf) return leaf;
  }
  return pickFile(join(packageRoot, "index"));
}

/** 按 Node 语义解析一个 specifier：相对路径直接解析；裸 specifier 逐级向上找 node_modules。 */
function resolveSpecifier(fromFile, specifier, lookupRoots) {
  if (specifier.startsWith(".")) {
    return pickFile(join(dirname(fromFile), specifier));
  }
  if (specifier.startsWith("node:")) return undefined;
  const segments = specifier.split("/");
  const packageName = specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
  const subpath = specifier.slice(packageName.length).replace(/^\//, "");
  let directory = dirname(fromFile);
  for (;;) {
    const candidate = join(directory, "node_modules", packageName);
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      const entry = packageEntryFile(candidate, subpath);
      if (entry) return entry;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  // 装在同级 node_modules 之外的布局（pnpm 虚拟 store）兜底
  try {
    const packageRoot = resolveInstalledPackage(packageName, lookupRoots);
    return packageEntryFile(packageRoot, subpath);
  } catch {
    return undefined;
  }
}

function collectRuntimeClosure(entryFile, lookupRoots) {
  const reachable = new Set();
  /** 跨包依赖边：裁剪后要靠它决定「同名多版本」往哪一层嵌套。 */
  const edges = [];
  const queue = [entryFile];
  while (queue.length > 0) {
    const file = queue.pop();
    if (reachable.has(file)) continue;
    reachable.add(file);
    let source = "";
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const pattern of SPEC_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(source)) !== null) {
        const resolved = resolveSpecifier(file, match[1], lookupRoots);
        if (!resolved) continue;
        edges.push({ from: file, to: resolved });
        if (!reachable.has(resolved)) queue.push(resolved);
      }
    }
  }
  return { files: reachable, edges };
}

/** 文件所属「已安装包根」的绝对路径（最后一个 node_modules 之后那段的第一层）。 */
function installedPackageRoot(file) {
  const marker = `${sep}node_modules${sep}`;
  const index = file.lastIndexOf(marker);
  if (index === -1) return undefined;
  const rest = file.slice(index + marker.length);
  const segments = rest.split(sep);
  const name = segments[0].startsWith("@") ? segments.slice(0, 2).join(sep) : segments[0];
  return file.slice(0, index + marker.length) + name;
}

/**
 * 把一个已安装文件映射成载荷内的相对路径，**保留 Node 的解析布局**。
 *
 * 规则：以 lookupRoot/node_modules 之后的那段路径为准（例如
 * `node_modules/lazystream/node_modules/readable-stream/lib/x.js` →
 * `lazystream/node_modules/readable-stream/lib/x.js`）。
 * 这样同名不同版本的包各自留在原来的父级下，require 时解析到的版本与安装树一致。
 */
function placeInPayload(file, lookupRoots) {
  const posixFile = toPosix(file);
  for (const root of lookupRoots) {
    const prefix = `${toPosix(resolve(root, "node_modules"))}/`;
    if (!posixFile.startsWith(prefix)) continue;
    const relativePath = posixFile.slice(prefix.length);
    const packageRootRelative = owningPackageName(relativePath);
    // 包根直接用**绝对路径**推导（与 installedPackageRoot 同语义），而不是拿相对路径再拼一次：
    // 嵌套依赖的相对路径里含 `node_modules` 段，重新拼接容易在租户/虚拟 store 布局下拼错。
    return {
      packageRootRelative,
      relativePath,
      sourcePackageRoot: installedPackageRoot(file) ?? resolve(root, "node_modules", ...packageRootRelative.split("/")),
    };
  }
  throw new Error(
    `[office-node-payload] 无法把 ${file} 映射进载荷：不在任何 lookupRoot 的 node_modules 下`,
  );
}

/**
 * 从相对路径取「该文件所属的那个包」，用**最后一个 `node_modules/` 之后**的那一段。
 *
 * 为什么是最后一个而不是第一个：载荷保留安装树的嵌套布局，嵌套依赖会出现在
 * `exceljs/node_modules/uuid/dist/index.js` 这种路径里。若取最外层（`exceljs`），
 * 补 `package.json`/`LICENSE` 时会补到**父包**上，嵌套包自己拿不到 `package.json` ——
 * 实测后果是 `require('uuid')` 直接 `MODULE_NOT_FOUND`（载荷里 uuid 只有 dist/ 没有元数据）。
 * 取最后一个才与 Node 的解析语义一致：离文件最近的那个 node_modules 才是它的包根。
 */
function owningPackageName(relativePath) {
  const segments = relativePath.split("/");
  let start = 0;
  for (let i = 0; i < segments.length; i += 1) {
    if (segments[i] === "node_modules") start = i + 1;
  }
  const first = segments[start];
  if (first === undefined) return segments[0];
  const end = first.startsWith("@") ? start + 2 : start + 1;
  // 返回**包根相对路径**（保留嵌套前缀），而不是裸包名：
  // 嵌套依赖必须落回它自己在安装树里的位置（`exceljs/node_modules/uuid`），
  // 否则补 package.json 时会写到顶层同名包上 —— 实测后果是嵌套包缺 package.json
  // （dist/ 在但没元数据）而顶层包被写成嵌套版的元数据，require 直接失败。
  return segments.slice(0, end).join("/");
}

/**
 * 把三个库的运行时闭包 stage 到 `<glmDir>/packages/<plugin>/${OFFICE_NODE_PAYLOAD_DIR}`。
 *
 * 返回逐库的 id/版本/字节数，供出包前校验与构建日志使用；任一库缺失即抛错（附可操作提示）。
 */
export function stageOfficeNodePayloads({ lookupRoots, glmDir }) {
  const staged = [];
  for (const payload of OFFICE_NODE_PAYLOADS) {
    const libraryRoot = resolveInstalledPackage(payload.library, lookupRoots);
    const manifest = JSON.parse(readFileSync(join(libraryRoot, "package.json"), "utf8"));
    const entryFile = join(libraryRoot, payload.entry);
    if (!existsSync(entryFile)) {
      throw new Error(`[office-node-payload] ${payload.library} 缺少入口 ${payload.entry}`);
    }
    // collectRuntimeClosure 同时返回跨包边（edges）；pnpm 布局下的「同名多版本按需嵌套」
    // 要用它决定落点，见模块头「已知缺口」注释。
    const closure = collectRuntimeClosure(entryFile, lookupRoots);
    const targetRoot = resolve(glmDir, "packages", payload.plugin, OFFICE_NODE_PAYLOAD_DIR);
    rmSync(targetRoot, { recursive: true, force: true });
    mkdirSync(targetRoot, { recursive: true });

    const packageBytes = new Map();
    const sourceRoots = new Map();
    for (const file of closure.files) {
      // 归属到最内层 node_modules 里的那个包（含租户/虚拟 store 布局）
      const placed = placeInPayload(file, lookupRoots);
      // 关键：**保留安装树里的解析布局**，不要按包名扁平化。
      // 扁平化会把同一包名的多个版本（如 readable-stream v3 与嵌套的 v4）合并进一个目录，
      // 出来的既不是 v3 也不是 v4 —— 实测这条会让 exceljs 的读路径报
      // "iterable is not async iterable"（smoke 矩阵抓到的真实缺陷）。
      const target = resolve(targetRoot, "node_modules", ...placed.relativePath.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      cpSync(file, target);
      packageBytes.set(
        placed.packageRootRelative,
        (packageBytes.get(placed.packageRootRelative) ?? 0) + statSync(file).size,
      );
      sourceRoots.set(placed.packageRootRelative, placed.sourcePackageRoot);
    }
    // 每个被用到的包补 package.json 与 LICENSE（许可登记与 ESM/CJS 识别都要它们）
    for (const packageRootRelative of packageBytes.keys()) {
      const sourcePackageRoot = sourceRoots.get(packageRootRelative);
      const targetPackageRoot = resolve(
        targetRoot,
        "node_modules",
        ...packageRootRelative.split("/"),
      );
      if (!sourcePackageRoot) continue;
      for (const extra of ["package.json", "LICENSE", "LICENSE.md", "LICENSE.txt"]) {
        const source = resolve(sourcePackageRoot, extra);
        if (!existsSync(source)) continue;
        const target = resolve(targetPackageRoot, extra);
        mkdirSync(dirname(target), { recursive: true });
        cpSync(source, target);
        packageBytes.set(
          packageRootRelative,
          (packageBytes.get(packageRootRelative) ?? 0) + statSync(source).size,
        );
      }
    }
    const bytes = [...packageBytes.values()].reduce((sum, value) => sum + value, 0);
    staged.push({
      library: payload.library,
      plugin: payload.plugin,
      version: manifest.version,
      packages: packageBytes.size,
      files: closure.size,
      bytes,
      targetRoot,
    });
  }
  return staged;
}

/** 载荷在插件目录内的相对落点（skills 与校验脚本按它 require）。 */
export const OFFICE_NODE_PAYLOAD_RELATIVE_DIR = OFFICE_NODE_PAYLOAD_DIR;
