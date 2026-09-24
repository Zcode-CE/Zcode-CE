import { readFileSync } from "node:fs";
import { build, type BuildOptions, type Plugin } from "esbuild";
import { validateRemoteServerBundle } from "./buildRemoteValidation.js";
import { loadBuiltinProviderConfig } from "../../scripts/builtin-provider-config.mjs";
import { stageThirdPartyNotices } from "../../scripts/third-party-notices.mjs";

const { version } = JSON.parse(readFileSync("../../package.json", "utf-8"));
const { content: zcodeBuiltinProviderConfigJson } = await loadBuiltinProviderConfig();

/**
 * Let esbuild bundle node-pty's JS code normally, but keep .node native
 * addon files as external requires. node-pty's loadNativeModule() searches
 * for `./build/Release/pty.node` relative to itself, which matches our
 * deploy layout on the remote.
 *
 * CJS 格式而非 ESM：node-pty 内部大量使用 __dirname，ESM 里没有这个变量，
 * 用 CJS 输出可以直接原生支持，不需要任何 polyfill。
 */
const nativeAddonPlugin: Plugin = {
  name: "native-addon",
  setup(build) {
    // Mark all .node files as external — they can't be bundled
    build.onResolve({ filter: /\.node$/ }, (args) => ({
      path: args.path,
      external: true,
    }));
  },
};

/** 两个入口共用同一套 esbuild 选项：**不要**为 HTTP 入口另写一份（否则 external/define 会漂移）。 */
const sharedOptions: BuildOptions = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  plugins: [nativeAddonPlugin],
  // CJS 环境没有 import.meta.url，通过 banner 注入等价变量，
  // 再用 define 全局替换，这样源码无需关心最终打包格式。
  banner: {
    js: 'var __import_meta_url = require("url").pathToFileURL(__filename).href; var __import_meta_dirname = __dirname;',
  },
  define: {
    "import.meta.url": "__import_meta_url",
    "import.meta.dirname": "__import_meta_dirname",
    __ZCODE_VERSION__: JSON.stringify(version),
    __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__: JSON.stringify(zcodeBuiltinProviderConfigJson),
  },
  metafile: true,
};

const entrypoints = [
  // 远端工作区部署用（单文件上传到 ~/.zcode/server/）。
  { entryPoint: "src/entry-stdio.ts", outfile: "dist/remote/zcode-server.cjs" },
  // 桌面端「本地 Web 服务（远程控制）」随包用：extraResources 里的 web-service/zcode-server-http.cjs。
  { entryPoint: "src/entry-http.ts", outfile: "dist/remote/zcode-server-http.cjs" },
];

for (const { entryPoint, outfile } of entrypoints) {
  const result = await build({ ...sharedOptions, entryPoints: [entryPoint], outfile });
  const source = readFileSync(outfile, "utf-8");
  // 两个入口都跑同一套校验（当前校验项：不得残留裸 undici 运行时导入）。
  validateRemoteServerBundle({ bundledInputs: Object.keys(result.metafile.inputs), source });
  console.log(`Built ${outfile}`);
}

// 修复：remote 单文件 bundle 内联第三方代码，dist/remote 也必须附完整声明。
await stageThirdPartyNotices("dist/remote");
