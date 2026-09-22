// Computer Use 驱动（@trycua/cua-driver）的原生运行时 staging。
//
// 与 koffi 是同一类问题、同一套解法：驱动是 uniffi 生成的 Rust 原生库，
// esbuild **无法** bundle 它（`dist/native/node-runtime.js` 用 createRequire 在运行时
// 解析 `.node`，`@ubjs/node` 再按平台三元组 require 对应平台包），所以
// node-repl-host 的产物里保留的是 `await import("@trycua/cua-driver")`。
//
// 而桌面正式包把 agent 运行时 stage 到 `resources/glm`，**staged 树没有 node_modules**
// （electron-builder 的 extraResources 只拷 bundled-agents/<key>/glm）。于是在正式包里
// 这一跳会 ERR_MODULE_NOT_FOUND —— 表现为「Computer Use 装好了但用不了」的静默失效。
//
// 解法：把驱动及其依赖闭包按目标平台 stage 到
// `glm/packages/node-repl-host/node_modules/`。
//
// 为什么不是 `glm/node_modules/`：electron-builder 的 util/filter.js 对**源根直属**的
// node_modules 有硬编码丢弃（`if (relative === "node_modules") return false;`），
// walk 不会下钻，写什么 filter 都没用（实测四种 filter 写法全部失败）。
// 放进 node-repl-host 子目录既绕开那条规则，又正好落在 bundle 的祖先目录上 ——
// Node 解析原生依赖时依次查 node_modules、../node_modules、../..，
// 命中 packages/node-repl-host/node_modules。
//
// ⚠️ 还有**第二条**同类规则（2026-09-23 发现并修复）：stage 到磁盘 ≠ 运行时可加载。
// 官方插件 seed 到用户 cache 时还要再走一遍顶层白名单
// （`bootstrap/src/app/bundled-plugins.ts` 的 `includedTopLevelPaths`），`node_modules`
// 不在其中时会被**整棵静默丢弃、零告警**。两条规则都只认「插件根直属」，
// 所以 `packages/node-repl-host/node_modules` 是唯一同时满足的落点 ——
// 本文件原先只写了 electron-builder 那条，导致该落点在正式包里**从未真正生效**：
// 驱动永远解析不到，而驱动是懒加载的，症状要等到首次 CUA 调用才以
// 「Cannot find package '@trycua/cua-driver'」暴露（点名包名 ⇒ 诱导模型自行装包）。
// 改动这条链时，验收必须从 **seed 后的 cache** 出发。见
// `.reverse/29-cua-seed/CUA-SEED-PAYLOAD.md`。
//
// 只 stage 目标平台的原生包：驱动与 @ubjs 的平台包都是 optionalDependencies 全集，
// 全拷会把六个平台的二进制一起打进安装包（Linux x64 只需 42 MB，全拷是数百 MB）。
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";

/** 目录总字节数。只用于把体积写进构建日志（用户需要知道安装包会变大多少）。 */
function directorySize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += directorySize(path);
    else if (entry.isFile()) total += statSync(path).size;
  }
  return total;
}

/**
 * 原生依赖相对 `glm` 的落点。
 *
 * 必须是**子目录**下的 node_modules（原因见模块头注释），且要在 node-repl-host
 * bundle 的祖先链上。
 */
const CUA_DRIVER_NODE_MODULES_RELATIVE = "packages/node-repl-host/node_modules";

/** 运行时必需的包；平台变体由 {@link platformPackagesFor} 追加。 */
const CUA_DRIVER_RUNTIME_PACKAGES = ["@trycua/cua-driver", "@ubjs/core", "@ubjs/node"];

/**
 * 平台三元组 → 该平台的原生包名。
 *
 * 三元组口径与 `@ubjs/node` 的 `detectNodeTriple` 以及 `@trycua/cua-driver` 的
 * optionalDependencies 一致；两者命名相同，所以一张表覆盖两个包族。
 * Linux 区分 gnu/musl —— 传错会 stage 一个加载不起来的 .so。
 */
function platformPackagesFor(targetPlatform) {
  const { os, arch } = targetPlatform;
  if (os === "darwin" && (arch === "x64" || arch === "arm64")) return `darwin-${arch}`;
  if (os === "win32" && (arch === "x64" || arch === "arm64")) return `win32-${arch}-msvc`;
  if (os === "linux" && (arch === "x64" || arch === "arm64")) {
    return `linux-${arch}-${targetPlatform.npmLibc === "glibc" ? "gnu" : "musl"}`;
  }
  throw new Error(
    `[cua-driver-assets] unsupported target platform: ${os}/${arch} ` +
      "(supported: darwin-{x64,arm64}, linux-{x64,arm64}-{gnu,musl}, win32-{x64,arm64}-msvc)",
  );
}

/**
 * 在给定的查找根里定位一个已安装包。
 *
 * 与 koffi-package-assets.mjs 同构：pnpm 的 hoisted 布局下包可能出现在根
 * node_modules、某层嵌套 node_modules，或 .pnpm 的虚拟store 里。
 */
function resolveInstalledPackage(packageName, lookupRoots) {
  for (const root of lookupRoots) {
    const candidate = resolve(root, "node_modules", packageName);
    if (existsSync(resolve(candidate, "package.json"))) return candidate;
    // .pnpm 虚拟 store：@scope/name → @scope+name@version/node_modules/@scope/name
    const virtualStore = resolve(root, "node_modules", ".pnpm");
    if (!existsSync(virtualStore)) continue;
    const encoded = packageName.replace("/", "+");
    for (const entry of readdirSync(virtualStore)) {
      if (!entry.startsWith(`${encoded}@`)) continue;
      const nested = resolve(virtualStore, entry, "node_modules", packageName);
      if (existsSync(resolve(nested, "package.json"))) return nested;
    }
  }
  return undefined;
}

/**
 * 把 Computer Use 驱动及其平台依赖闭包 stage 到 `glmDir/node_modules`。
 *
 * 返回实际 stage 的包列表与原生库路径，供出包前校验与日志使用。
 */
export function stageCuaDriverIntoBundledAgents({ lookupRoots, glmDir, targetPlatform }) {
  if (!Array.isArray(lookupRoots) || !glmDir || !targetPlatform?.os || !targetPlatform?.arch) {
    throw new Error("[cua-driver-assets] lookupRoots, glmDir and targetPlatform are required");
  }
  const triple = platformPackagesFor(targetPlatform);
  const packages = [
    ...CUA_DRIVER_RUNTIME_PACKAGES,
    `@trycua/cua-driver-${triple}`,
    `@ubjs/node-${triple}`,
  ];

  const staged = [];
  const nodeModulesDir = resolve(glmDir, CUA_DRIVER_NODE_MODULES_RELATIVE);
  for (const packageName of packages) {
    const source = resolveInstalledPackage(packageName, lookupRoots);
    if (!source) {
      throw new Error(
        `[cua-driver-assets] cannot resolve installed package ${packageName}; ` +
          `searched: ${lookupRoots.map((root) => resolve(root, "node_modules", packageName)).join(", ")}`,
      );
    }
    const target = resolve(nodeModulesDir, packageName);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(resolve(target, ".."), { recursive: true });
    cpSync(source, target, { recursive: true });
    staged.push({ packageName, source, target, size: directorySize(target) });
  }

  return { staged, triple, nodeModulesDir };
}

/**
 * 出包前校验 staged 驱动运行时完整。
 *
 * 与 verifyStagedKoffi 同形态：返回问题列表而不是抛错，让调用方决定口径。
 * 缺任何一个都会让正式包的 Computer Use 静默不可用，所以这里逐项断言而不是抽查。
 */
export function verifyStagedCuaDriver({
  resourcesDir,
  targetPlatform,
  glmRelativePath = "glm",
  nodeReplHostRelativePath = "packages/node-repl-host",
}) {
  const issues = [];
  const nodeModulesDir = resolve(resourcesDir, glmRelativePath, CUA_DRIVER_NODE_MODULES_RELATIVE);
  let triple;
  try {
    triple = platformPackagesFor(targetPlatform);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }

  for (const packageName of [
    ...CUA_DRIVER_RUNTIME_PACKAGES,
    `@trycua/cua-driver-${triple}`,
    `@ubjs/node-${triple}`,
  ]) {
    if (!existsSync(resolve(nodeModulesDir, packageName, "package.json"))) {
      issues.push(`missing staged driver package ${packageName} for ${triple}`);
    }
  }

  // 原生库本体：只看 package.json 会把「目录在但二进制没拷进来」放过去。
  const nativeLibrary = resolve(
    nodeModulesDir,
    `@trycua/cua-driver-${triple}`,
    targetPlatform.os === "win32"
      ? "cua_driver_sdk.dll"
      : targetPlatform.os === "darwin"
        ? "libcua_driver_sdk.dylib"
        : "libcua_driver_sdk.so",
  );
  if (!existsSync(nativeLibrary)) issues.push(`missing staged native driver: ${nativeLibrary}`);

  const nodeRuntime = resolve(
    nodeModulesDir,
    `@trycua/cua-driver-${triple}`,
    "cua_driver_node_runtime.node",
  );
  if (!existsSync(nodeRuntime)) issues.push(`missing staged node runtime: ${nodeRuntime}`);

  // node-repl-host 的 bundle 是驱动的消费者；它不在 staged 树里时，staging 到 glm/node_modules
  // 也不会被任何模块解析到（说明 stage 顺序或路径约定被改坏了）。
  const hostBundle = resolve(
    resourcesDir,
    glmRelativePath,
    nodeReplHostRelativePath,
    "dist/mcp/server.js",
  );
  if (!existsSync(hostBundle)) {
    issues.push(`missing staged node_repl host bundle: ${hostBundle}`);
  } else {
    const source = readFileSync(hostBundle, "utf8");
    // 驱动的加载必须是运行时 import()，被 esbuild 内联进来反而说明 bundle 策略变了。
    if (!source.includes("@trycua/cua-driver")) {
      issues.push(
        `staged node_repl host does not reference @trycua/cua-driver: ${hostBundle} (bundle strategy changed?)`,
      );
    }
  }

  return issues;
}
