import { defineConfig } from "tsup";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// tsup 配置自身会被打包，构建工具需保留原始文件位置，不能被内联后重定位。
const { loadBuiltinProviderConfig } = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../scripts/builtin-provider-config.mjs")).href
);

const { content: zcodeBuiltinProviderConfigJson } = await loadBuiltinProviderConfig();

export const SERVER_CLI_DEFINES = {
  __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__: JSON.stringify(zcodeBuiltinProviderConfigJson),
};

export default defineConfig({
  entry: {
    "server-cli": "src/main.ts",
    "server-core": "src/server-core/entry.ts",
  },
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "node22",
  sourcemap: true,
  splitting: false,
  banner: {
    js: 'import { fileURLToPath as __zcodeFileURLToPath } from "node:url"; import { dirname as __zcodeDirname } from "node:path"; const __filename = __zcodeFileURLToPath(import.meta.url); const __dirname = __zcodeDirname(__filename);',
  },
  noExternal: ["@zcode/shared", "@zcode/rpc", "@zcode/services"],
  define: SERVER_CLI_DEFINES,
  external: [
    "node-pty",
    "ssh2",
    "yaml",
    "node-forge",
    "undici",
    "axios",
    "form-data",
    "combined-stream",
    "proxy-from-env",
    "follow-redirects",
    // 与 packages/server/tsup.config.ts 的 SERVER_HTTP_EXTERNAL_DEPENDENCIES 同一结论：
    // services 的反馈日志 ZIP 链路引入 CJS 包 yazl（其 require("fs")/require("stream") 被内联进
    // ESM bundle 后会落到 esbuild 的 __require 兜底上，运行时抛 Dynamic require of "fs" is not
    // supported，直接执行 dist/server-cli.js 即崩）；yauzl 是同一链路里的解包侧。两者都保留为
    // 外部依赖、交给 Node 原生加载，不引入新的 require shim 机制。
    "yazl",
    "yauzl",
    // 飞书 SDK 是可选依赖（services 里动态 import，缺包时降级到 webhook channel），
    // 与 desktop 的 externals 同口径保留外部；内联会把 qs → object-inspect 的 CJS
    // util.inspect 带进 ESM bundle，触发同一个 __require 兜底。
    "@larksuiteoapi/node-sdk",
    // services 的 workspaceFileIgnore 引入 CJS 包 ignore（require("fs")/require("path")）；
    // 内联进 ESM bundle 会落到同一个 __require 兜底，distEntrypoints 测试会因此变红。
    // 与 yazl/yauzl 同处理：保留为外部依赖，交给 Node 原生加载。
    "ignore",
    "@lydell/node-pty-darwin-arm64",
    "@lydell/node-pty-darwin-x64",
    "@lydell/node-pty-linux-arm64",
    "@lydell/node-pty-linux-x64",
  ],
});
