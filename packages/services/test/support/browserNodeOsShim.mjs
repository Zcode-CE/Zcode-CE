// 测试用的模块钩子：把 node:os 换成「浏览器产物里的那个空对象」。
//
// 为什么需要它：packages/services/src/paths.ts 会被 web 客户端打进浏览器产物
// （packages/ui 以值导入 @zcode/services），而 Vite 对浏览器构建里的 node 内置模块
// 不做 polyfill —— 实测产物里它就是一个空 CJS 模块（`t.exports={}`），因此
// `import { homedir } from "node:os"` 拿到 undefined，调用即
// `TypeError: (0, R2e.homedir) is not a function`（真浏览器控制台原文）。
//
// 只替换 node:os，不替换其它内置模块：本缺陷的加载期触发点就是它
// （paths.ts 里 node:fs / node:fs/promises / node:crypto / node:path 的调用都在函数体内，
// 不在模块顶层）。把面收窄到出问题的那一个，探针才不会因为无关模块而假红。
//
// 另一半「浏览器形状」由调用方负责：子进程的 env 里不含 HOME 与 ZCODE_DATA_BASE_DIR
// （浏览器里 `process.env` 被替换成 `{}`，读任何键都是 undefined）。
// 两半合起来，paths.ts 顶层的 `process.env.HOME?.trim() || homedir()` 才会走到 homedir()。
//
// 用法：node --import tsx --import ./test/support/browserNodeOsShim.mjs <probe>
import { registerHooks } from "node:module";

const STUB_URL = new URL("./browserNodeOsStub.mjs", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "node:os") {
      return { url: STUB_URL, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
