/**
 * 沙箱 preload 的 require 白名单策略（issue #6）。
 *
 * 为什么需要这条策略：Electron 的 renderer 默认 sandbox=true，preload 在沙箱里运行，它的 `require`
 * 只有一份极简实现（`node:electron/js2c/sandbox_bundle` 的 preloadRequire），只认 `electron` 与
 * Node 内建模块。任何被打成外置依赖的第三方包（`require("zod")`）都会在 preload 脚本加载时抛
 * `module not found`，后果是 contextBridge 从未建立 ⇒ `window.zcode` 缺失 ⇒ renderer 在模块求值期
 * 解引用它而抛 TypeError ⇒ 一个 React 节点都不挂载 ⇒ 整窗空白（Windows 上因宿主底色是
 * `#00000000` 未开 transparent，表现为纯黑）。
 *
 * 已发生的实例：3b241a9 把 `zod` 登记进 packages/desktop/package.json 的 dependencies 后，
 * tsup 默认把 dependencies 当 external，preload 产物里留下 69 处裸 `require("zod")`（7 个 preload
 * 产物中 6 个带），3.16.3-ce.1 的安装包因此全部窗口启动空白。
 *
 * 本模块只做纯判定，不读文件、不碰 asar，方便单测；真正的产物校验在 bundle.mjs 里调用。
 */

import { builtinModules } from "node:module";

// preload 产物是 CJS（tsup format: "cjs"），外置依赖在产物里就是裸 `require("x")`；esbuild 不会把它
// 改名成 `__require`。lookbehind 排除三类明显不是「模块解析入口」的形态：
//   · 前面是标识符字符（`myrequire(` / `__require(`）—— 不是真的 require；
//   · 前面是 `.`（`loader.require("x")`）—— 属性访问，不走模块解析；
//   · 前面是引号（`"require('x')"`）—— 被整段包在字符串字面量里，是把 require 当文本。
// 仍会漏判的边角：字符串里带空格的同形文本（如 `"cannot require('zod')"`）会被误报；
// 这种误报只会让构建失败并指出文件/模块名，代价可接受（宁可多看一眼，不要放过真违规）。
const REQUIRE_CALL_PATTERN = /(?<![\w$."'`])require\s*\(\s*(['"])((?:\\.|(?!\1)[^\\])*?)\1\s*\)/g;

/** Node 内建模块名（不含 `node:` 前缀）。`node:fs` 这类带前缀写法另行判定。 */
const NODE_BUILTIN_MODULES = new Set(builtinModules);

/** Electron 沙箱 preload 唯一允许的第三方入口。 */
const ALLOWED_SANDBOX_MODULES = new Set(["electron"]);

function isRelativeOrAbsoluteSpecifier(specifier) {
  if (specifier === "." || specifier === "..") {
    return true;
  }
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return true;
  }
  // 产物内的绝对路径（POSIX 或 Windows 盘符/UNC）：preload 产物一般不会出现，但出现了也不是
  // 第三方包解析问题，按放行处理，避免误报挡住构建。
  return (
    specifier.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(specifier) || specifier.startsWith("\\\\")
  );
}

/**
 * 单个模块标识符是否允许出现在沙箱 preload 的 `require(...)` 里。
 *
 * @param {string} specifier
 * @returns {boolean}
 */
export function isAllowedPreloadRequire(specifier) {
  if (ALLOWED_SANDBOX_MODULES.has(specifier)) {
    return true;
  }
  // Node 内建：`fs` 与 `node:fs` 两种写法都要放行（后者由 bundlers 显式加上前缀）。
  if (specifier.startsWith("node:")) {
    return NODE_BUILTIN_MODULES.has(specifier.slice("node:".length));
  }
  if (NODE_BUILTIN_MODULES.has(specifier)) {
    return true;
  }
  return isRelativeOrAbsoluteSpecifier(specifier);
}

/**
 * 找出 preload 产物里沙箱不可用的 `require`。
 *
 * 只按「真实调用形态」匹配 `require("x")` / `require('x')`，不处理注释里的同形文本
 * （注释误报可接受：宁可让人看一眼，也不要漏掉真违规）。相对/绝对路径与 Node 内建、
 * `electron` 放行；其余一切模块名都算违规。
 *
 * @param {ReadonlyArray<{ path: string, content: string }>} files
 * @returns {ReadonlyArray<{ file: string, module: string }>}
 */
export function findDisallowedPreloadRequires(files) {
  const violations = [];
  const seen = new Set();

  for (const file of files) {
    const matches = file.content.matchAll(REQUIRE_CALL_PATTERN);
    for (const match of matches) {
      const specifier = match[2];
      if (isAllowedPreloadRequire(specifier)) {
        continue;
      }
      // 同一文件里同一个模块可能出现几十次（zod 的实例就是 69 次），按 file+module 去重，
      // 只报「这个文件里有这个外置依赖」，便于直接定位要补进 noExternal 的包名。
      const key = `${file.path}\u0000${specifier}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      violations.push({ file: file.path, module: specifier });
    }
  }

  return violations;
}
