// 办公插件的 Node 运行时载荷：把三个 MIT 纯 JS 库（docx / pptxgenjs / exceljs）用 esbuild
// 打成**自包含 CJS bundle**，stage 到 `<插件根>/scripts/office-node/<库>.cjs`。
//
// 为什么要它：三个办公插件原先依赖系统 python3 + pip 包（python-docx / python-pptx / openpyxl），
// 用户没装就完全不可用。Electron 必然自带 Node，所以改用 Node 库做打底；三库都是纯 JS（0 原生模块、
// 0 install 脚本）。
//
// ## 为什么是 bundle，而不是「裁剪闭包 + node_modules」（前两个方案都被实测否决）
//
// 真正的约束是 seed 阶段的 `shouldSkipDirectory`（bootstrap/src/app/bundled-plugins.ts:642）：
//
//     return name === "node_modules" && !(depth === 0 && allowedTopLevelPaths.has(name));
//
// ⇒ **`node_modules` 只在「插件根直属（depth===0）且顶层白名单含它」时保留，任何嵌套层一律丢弃。**
// 实测过的三条路：
//   A. `vendor/office-node/node_modules` + 白名单 vendor → ❌ 库全丢（vendor 在，里面 node_modules 在 depth2 被剥）；
//   B. `<plugin>/node_modules` + 白名单 node_modules → ⚠️ 顶层包活了，但嵌套依赖仍丢
//      （`exceljs/node_modules/uuid` 在 depth2 被剥）⇒ `MODULE_NOT_FOUND: uuid`。载荷里这类嵌套依赖
//      16 个、13 个版本冲突 ⇒ 扁平化不可行；
//   D. **esbuild 自包含 bundle → `scripts/office-node/*.cjs`** → ✅ 无 node_modules 目录，
//      不受上面这条规则影响，也不受 electron-builder `util/filter.js` 对源根直属 node_modules 的
//      硬编码丢弃影响（**同一个坑在两个阶段各踩一次**：task-60 当初选 vendor/ 就是为了绕
//      electron-builder，结果撞上 seed 的同款规则）。
// `scripts` 本来就在 seed 的顶层白名单里，所以落点选它，技能正文用
// `<skill-directory>/../../scripts/office-node/<库>.cjs` 即可（task-61 已按此改写）。
//
// ## 法务：许可链的两次变化（先说结论，再说过程）
//
// **当前状态**：`unzipper` **正常内联**（它是 MIT、依赖链全绿）；**只有 `@aws-sdk/client-s3` 被 stub**
// （它没安装、且与本地 xlsx 场景无关）。`buffers`/`binary`/`chainsaw`/`traverse` 不在产物里，
// 且有断言守着不让它们回来。
//
// **过程（为什么曾一度排除 unzipper）**：exceljs 的 `lib/exceljs.nodejs.js` 会 eager require 两个子入口，
// 其中 `stream/xlsx/workbook-reader` 是**唯一**引入 `unzipper` 的地方；而 overrides 之前装的是 0.10.x：
//
//     workbook-reader.js:5  require('unzipper')
//       → unzipper@0.10.14 → binary@0.3.0 → buffers@0.1.1   ← package.json 无 license 字段、
//                                             包内无 LICENSE、npm registry 无字段、GitHub 上游 404
//                                            → chainsaw@0.1.0 → traverse@0.3.9
//
// `buffers` 是 2011 年的包，四处都查不到任何许可声明 ⇒ **不得进入分发物**（当时靠 stub 掉整个 `unzipper` 达成）。
//
// **前提已变更（task-65 落地后）**：根 `package.json` 的 `pnpm.overrides` 已把 `unzipper` 提升到
// `^0.12.3`（实际装到 0.12.5）。0.12.x 的依赖树是
// `bluebird/duplexer2/fs-extra/graceful-fs/node-int64` —— **没有 binary**，因此
// buffers/chainsaw/traverse 整条链自然消失，`unzipper` 本身是 MIT（包内有 LICENSE）。
// ⇒ **整条链的许可问题已从「仓库安装树」层面解决**（`licenses:check` 已绿）。
//
// 因此本模块**不再 stub `unzipper` 本体**（那会让 task-65 恢复的流式读在分发物里失效 ——
// 「仓库安装树已合规、但 bundle 仍按旧前提降级」，正是「验证必须打到最终消费点」的又一次实例）。
// 现在 `unzipper` **正常进 bundle**，`stream.xlsx.WorkbookReader` 在分发物里**可用**。
//
// **唯一需要 stub 的是 S3 那一处**：`unzipper@0.12.5` 的 `lib/Open/index.js:98` 有
// `require('@aws-sdk/client-s3')`（S3 可选依赖）。该包**没有安装**，裸 esbuild 会直接报
// `Could not resolve "@aws-sdk/client-s3"` 而构建失败。它与我们的场景无关（我们只读**本地**
// xlsx 文件），因此把它解析到一个明确抛错的虚拟模块 —— 本地路径完全不受影响，
// 只有真去用 `Open.s3_v3()` 时才会得到一条可读的错误，而不是模块加载期整体崩掉。
//
// **`FORBIDDEN_BUNDLED_PACKAGES` 的语义随之更新**：`unzipper` 已从该名单**移除**
// （它现在是 MIT 且依赖链全绿，属于**应当内联**的依赖）；`binary/buffers/chainsaw/traverse`
// 仍然禁止 —— 它们是「不许回来」的哨兵：若哪天 overrides 失效或有人降级 unzipper，
// 这条断言会在构建期立刻失败，而不是等许可门禁或用户发现。
//
// ## 静态可达性仍是盲区
// esbuild 对**动态 require**（`require(变量)`）同样看不见。改这里的打包选项后**必须**从
// **seed 之后的 cache 目录**跑真实 smoke —— 中间产物全绿而最终消费点失败是本项目踩过两次的坑。
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { join, resolve, sep } from "node:path";
import { build } from "esbuild";

/**
 * 三个库 → 所属插件 → 产物文件名。库与插件的对应关系由各插件 package.json 的依赖声明决定。
 *
 * 导出是给 **dev 链**用的（packages/desktop/scripts/dev-agent-payloads.mjs）：dev 也要 stage
 * 同一批载荷，而「哪些插件需要载荷」只能有一处事实源 —— 再手写一份清单就是本项目
 * 反复踩过的「平行清单各自漂移」根因。
 */
export const OFFICE_NODE_BUNDLES = [
  { file: "docx.cjs", library: "docx", plugin: "documents-plugin" },
  { file: "pptxgenjs.cjs", library: "pptxgenjs", plugin: "presentations-plugin" },
  { file: "exceljs.cjs", library: "exceljs", plugin: "spreadsheets-plugin" },
];

/** 载荷在插件目录内的相对落点（技能与校验脚本按它 require）。 */
const OFFICE_NODE_PAYLOAD_DIR = "scripts/office-node";

/**
 * 不得出现在产物里的包 —— 「不许回来」的哨兵清单。
 *
 * `buffers@0.1.1` 无任何许可依据（package.json 无 license 字段、包内无 LICENSE、
 * npm registry 无字段、GitHub 上游 404）；`binary`/`chainsaw`/`traverse` 是把它拖进来的那条链。
 * 这四者只在 `unzipper <= 0.10.x` 下才会出现，而 `pnpm.overrides` 已把 `unzipper` 锁到 `^0.12.3`。
 * 保留这条断言是为了**在前提失效时立刻失败**（overrides 被删、有人降级 unzipper、
 * 或有新依赖引入它们），而不是让它们静默进入分发物。
 *
 * **`unzipper` 本身不在此列**：0.12.x 是 MIT、依赖链全绿，是**应当内联**的依赖
 * （stub 掉它会让流式读在分发物里失效，见模块头「前提已变更」段）。
 *
 * 判定用 esbuild metafile 的模块来源路径，**不用裸 grep** —— `buffers`/`binary` 这些词会作为
 * 普通标识符或字符串字面量出现在其它包的源码里（例如 `this.buffers = []`、
 * docx 里的 `var traverse = (node) => {...}`、`"binary"` 编码名），裸 grep 必然误报。
 */
const FORBIDDEN_BUNDLED_PACKAGES = ["binary", "buffers", "chainsaw", "traverse"];

/**
 * **必须**出现在指定产物里的包 —— 与 FORBIDDEN 相对的「正向护栏」。
 *
 * 为什么需要它（这是本轮修复的直接教训）：`unzipper` 一度被本模块 stub 掉，理由是它的
 * **旧版本**传递依赖含无许可的 `buffers`。overrides 把 `unzipper` 提升到 0.12.x 后该前提失效，
 * 但 stub 没有跟着退场 —— 结果是**仓库安装树已合规、而分发物仍按旧前提降级**，
 * `stream.xlsx.WorkbookReader` 在产物里不可用。当时所有断言都是「禁止出现 X」，
 * **没有任何一条会因「X 被误排除」而失败**，所以这个缺陷只能靠人工从产物里读流式读才发现。
 * 加上这条正向断言后，「必需能力被静默 stub 掉」会在构建期立刻失败。
 */
const REQUIRED_BUNDLED_PACKAGES = {
  // 只有 exceljs 会用到 unzipper（`lib/exceljs.nodejs.js` → `stream/xlsx/workbook-reader`），
  // 另外两个库不含它，所以按库声明而不是全局声明。
  exceljs: ["unzipper"],
};

/**
 * esbuild 的 CJS 产物目标。
 *
 * 远端宿主固定跑 Node v22.16.0（prepare-prebuilds.mjs 的 nodeVersion），桌面是 Electron 41 的
 * Node 24.x，取**共同下界** node22，保证同一份产物两处都能跑。
 */
const BUNDLE_TARGET = "node22";

const S3_STUB_NAMESPACE = "office-node-s3-stub";
const S3_STUB_PATH = "s3-stub";

/**
 * S3 可选依赖的替身模块源码。
 *
 * `unzipper` 只在 `Open.s3_v3()` 里用到 `@aws-sdk/client-s3`（`lib/Open/index.js:98`），
 * 而该包没有安装（它是 unzipper 的可选集成，不在我们的依赖图里）。它抛出**可读**的错误而不是
 * 让构建失败或让模块加载期整体崩掉：我们只读本地 xlsx，这条路径本来就不会被走到。
 */
const S3_STUB_SOURCE = `"use strict";
// 由 packages/desktop/scripts/office-node-payload-assets.mjs 在 esbuild 打包时注入（见该模块注释）。
// @aws-sdk/client-s3 是 unzipper 的可选集成（只用于从 S3 直接解压），未随本仓库安装。
const MESSAGE =
  "@aws-sdk/client-s3 is not available in this bundled payload: it is an optional integration of " +
  "'unzipper' used only for streaming archives directly from S3. Reading local .xlsx files " +
  "(exceljs Workbook.readFile / stream.xlsx.WorkbookReader) is unaffected.";
function unavailable() {
  throw new Error(MESSAGE);
}
module.exports = {
  AbortMultipartUploadCommand: unavailable,
  GetObjectCommand: unavailable,
  HeadObjectCommand: unavailable,
  ListObjectsV2Command: unavailable,
  S3Client: unavailable,
};
`;

/**
 * 把裸 specifier `@aws-sdk/client-s3` 重定向到虚拟 stub，让 `unzipper` 本体能正常进 bundle。
 *
 * **只 stub 这一处**，不再 stub `unzipper` 本体 —— 后者会让 task-65 恢复的流式读在分发物里失效。
 */
function createS3StubPlugin() {
  return {
    name: "office-node-s3-stub",
    setup(builder) {
      builder.onResolve({ filter: /^@aws-sdk\/client-s3$/ }, () => ({
        namespace: S3_STUB_NAMESPACE,
        path: S3_STUB_PATH,
      }));
      builder.onLoad({ filter: /.*/, namespace: S3_STUB_NAMESPACE }, () => ({
        contents: S3_STUB_SOURCE,
        loader: "js",
      }));
    },
  };
}

function toPosix(value) {
  return value.split(sep).join("/");
}

/** 在 node_modules 里定位一个已安装包（hoisted 布局与 pnpm 虚拟 store 两处都找）。 */
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

/**
 * 取一个包的 **CJS 主入口**。
 *
 * 不能直接用 `main`：docx@9.7.1 的 `main` 是 `dist/index.umd.cjs`（给 CDN/浏览器用的 UMD），
 * 而 Node 侧 `require("docx")` 走的是 `exports["."].require.default` = `dist/index.cjs`。
 * 拿错入口会打进一套不同的代码路径，属于「能跑但行为与预期不一致」的静默错误。
 */
function resolveCjsEntry(packageRoot) {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const rootExport = manifest.exports?.["."] ?? manifest.exports;
  const candidates = [];
  if (rootExport && typeof rootExport === "object" && !Array.isArray(rootExport)) {
    const requireBranch = rootExport.require;
    if (typeof requireBranch === "string") candidates.push(requireBranch);
    else if (requireBranch && typeof requireBranch.default === "string") {
      candidates.push(requireBranch.default);
    }
    if (typeof rootExport.default === "string") candidates.push(rootExport.default);
  }
  if (typeof rootExport === "string") candidates.push(rootExport);
  if (typeof manifest.main === "string") candidates.push(manifest.main);
  for (const candidate of candidates) {
    const entry = resolve(packageRoot, candidate.replace(/^\.\//, ""));
    if (existsSync(entry)) return entry;
  }
  throw new Error(
    `[office-node-payload] ${manifest.name} 找不到 CJS 入口（候选：${candidates.join(", ")}）`,
  );
}

/**
 * 从 metafile 的输入路径里取出「该文件所属的已安装包名」。
 *
 * 取**最后一个** `node_modules` 之后的那段，与 Node 的解析语义一致：同名多版本时
 * `node_modules/exceljs/node_modules/uuid/...` 归属 `uuid`（而不是外层 `exceljs`），
 * 否则嵌套版本会被静默算到父包头上，许可清单也会漏报。
 */
function owningPackageName(inputPath) {
  const posix = toPosix(inputPath);
  // 虚拟 stub 模块不是真实包，不参与包清单（它是本模块自己注入的，见模块头）。
  if (posix.startsWith(`${S3_STUB_NAMESPACE}:`)) return undefined;
  const segments = posix.split("/");
  let start = 0;
  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index] === "node_modules") start = index + 1;
  }
  const first = segments[start];
  if (first === undefined) return undefined;
  return first.startsWith("@") ? segments.slice(start, start + 2).join("/") : first;
}

/**
 * 检查产物是否自包含，并返回内联进来的包清单。
 *
 * 三条判据：
 *   ① 产物里剩下的 `require("...")` 必须全部是 Node 内置 —— 任何裸包名都说明有东西没被打进来，
 *      会在运行时 MODULE_NOT_FOUND（这正是 seed 裁剪阶段的失效模式，必须在这里拦下）；
 *   ② metafile 的输入里不得出现 FORBIDDEN_BUNDLED_PACKAGES；
 *   ③ 该库**必需内联**的包必须真的在产物里（见 REQUIRED_BUNDLED_PACKAGES）。
 */
function assertSelfContained({ code, library, metafile }) {
  const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
  const staticRequires = [...code.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map(
    (match) => match[1],
  );
  const external = [...new Set(staticRequires)].filter((specifier) => !builtins.has(specifier));
  if (external.length > 0) {
    throw new Error(
      `[office-node-payload] ${library} 产物不自包含：出现非内置 require ${external.join(", ")}`,
    );
  }
  // 动态 require（require(变量)）esbuild 无法静态内联，运行时必然抛错或 MODULE_NOT_FOUND。
  const dynamicRequires = [...code.matchAll(/require\(\s*([^"')\s][^)]*?)\s*\)/g)].map(
    (match) => match[1],
  );
  if (dynamicRequires.length > 0) {
    throw new Error(
      `[office-node-payload] ${library} 产物含动态 require（${dynamicRequires.slice(0, 3).join("; ")}）：` +
        "esbuild 无法静态内联这类调用，运行时可能 MODULE_NOT_FOUND",
    );
  }
  const packages = [
    ...new Set(
      Object.keys(metafile.inputs)
        .map(owningPackageName)
        .filter((name) => name !== undefined),
    ),
  ].sort();
  const forbidden = packages.filter((name) => FORBIDDEN_BUNDLED_PACKAGES.includes(name));
  if (forbidden.length > 0) {
    throw new Error(
      `[office-node-payload] ${library} 产物混入了禁止分发的包：${forbidden.join(", ")}`,
    );
  }
  const missing = (REQUIRED_BUNDLED_PACKAGES[library] ?? []).filter(
    (name) => !packages.includes(name),
  );
  if (missing.length > 0) {
    throw new Error(
      `[office-node-payload] ${library} 产物缺少必需内联的包：${missing.join(", ")}；` +
        "若这些包被 stub 或 external 掉，相关能力会在分发物里静默降级（见模块头「前提已变更」段）",
    );
  }
  return packages;
}

/**
 * 打包一个库，结果按「包名@版本 + 包根」在进程内缓存。
 *
 * 远端要按 4 个平台各 stage 一次，但三库是纯 JS、四平台产物字节相同，重复打包纯属浪费
 * （3 库 × 4 平台 = 12 次 esbuild 调用）。
 */
const bundleCache = new Map();

async function buildLibraryBundle({ library, lookupRoots }) {
  const packageRoot = resolveInstalledPackage(library, lookupRoots);
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const cacheKey = `${manifest.name}@${manifest.version}|${packageRoot}`;
  const cached = bundleCache.get(cacheKey);
  if (cached) return cached;

  const result = await build({
    bundle: true,
    entryPoints: [resolveCjsEntry(packageRoot)],
    // 产物是 CJS：调用方用 require() 加载，Node 原生提供 require/module/__dirname。
    // 这里**不需要** browser-use-plugin/scripts/build.mjs 里的 createRequire banner
    // —— 那个 banner 是 ESM 产物的补丁（esbuild 在 format:"esm" 时把 CJS 依赖的 require()
    // 换成一个必然抛 `Dynamic require of "..." is not supported` 的 shim）。选 CJS 就从根上避开该坑。
    format: "cjs",
    // 许可声明随包分发在 resources/THIRD-PARTY-NOTICES.md（electron-builder extraResources）；
    // 这里不再往每个产物里塞一份注释副本，避免三份重复文本。
    legalComments: "none",
    logLevel: "warning",
    metafile: true,
    platform: "node",
    plugins: [createS3StubPlugin()],
    target: BUNDLE_TARGET,
    write: false,
  });
  const output = result.outputFiles?.[0];
  if (!output) throw new Error(`[office-node-payload] ${library} esbuild 未产出文件`);
  const code = output.text;
  const packages = assertSelfContained({ code, library, metafile: result.metafile });
  const built = {
    bytes: Buffer.byteLength(code),
    code,
    library,
    packages,
    sha256: createHash("sha256").update(code).digest("hex"),
    version: manifest.version,
  };
  bundleCache.set(cacheKey, built);
  return built;
}

/**
 * 把三个库的 bundle stage 到 `<glmDir>/packages/<plugin>/scripts/office-node/`。
 *
 * **必须在 stageOfficialPlugins() 之后调用**：那一步会 cpSync 插件的 `scripts` 目录，
 * 顺序反了会把刚写进去的 bundle 覆盖掉（prepare-agent-node-bundle.mjs 与
 * prepare-prebuilds.mjs 两处调用点都排在它后面）。
 *
 * 返回逐库的版本/体积/内联包清单，供构建日志、出包前校验与许可登记使用；任一库缺失或产物
 * 不自包含即抛错（错误信息里已给可操作提示）。
 */
export async function stageOfficeNodePayloads({ lookupRoots, glmDir }) {
  const staged = [];
  for (const payload of OFFICE_NODE_BUNDLES) {
    const built = await buildLibraryBundle({ library: payload.library, lookupRoots });
    const pluginRoot = resolve(glmDir, "packages", payload.plugin);
    if (!existsSync(pluginRoot)) {
      throw new Error(
        `[office-node-payload] 插件目录不存在：${pluginRoot}；stageOfficeNodePayloads() 必须在 stageOfficialPlugins() 之后调用`,
      );
    }
    const targetRoot = resolve(pluginRoot, OFFICE_NODE_PAYLOAD_DIR);
    mkdirSync(targetRoot, { recursive: true });
    const target = resolve(targetRoot, payload.file);
    // 先删再写：同一个 glm 目录被连续 stage（例如先桌面后远端）时，删掉可避免上一次构建留下、
    // 本次已不再产出的旧文件被 seed 进缓存。
    rmSync(target, { force: true });
    writeFileSync(target, built.code);
    if (!existsSync(target) || statSync(target).size !== built.bytes) {
      throw new Error(`[office-node-payload] ${payload.library} bundle 落盘校验失败：${target}`);
    }
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

/** 载荷在插件目录内的相对落点（技能与校验脚本按它 require）。 */
export const OFFICE_NODE_PAYLOAD_RELATIVE_DIR = OFFICE_NODE_PAYLOAD_DIR;
