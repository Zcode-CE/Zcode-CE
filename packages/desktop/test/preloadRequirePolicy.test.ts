import assert from "node:assert/strict";
import test from "node:test";
import {
  findDisallowedPreloadRequires,
  isAllowedPreloadRequire,
} from "../scripts/preload-require-policy.mjs";

/**
 * 沙箱 preload 的 require 白名单护栏（issue #6）。
 *
 * 为什么必须钉住：preload 运行在 sandbox=true 的 renderer 里，require 只认 `electron` 与 Node 内建模块。
 * 一旦某个第三方包被 tsup 外置（3b241a9 把 zod 登记进 dependencies 后就是这么炸的），preload 会在
 * 加载阶段 module not found ⇒ contextBridge 不建立 ⇒ renderer 解引用 window.zcode 抛 TypeError
 * ⇒ 整窗空白。这类故障在 typecheck / lint / 单元测试里全都看不见，只有"产物里出现了裸 require"
 * 这一件事能作为判据，所以判定逻辑本身也要有测试。
 */

test("内置白名单：electron、Node 内建、相对路径、绝对路径都放行", () => {
  for (const specifier of [
    "electron",
    "fs",
    "path",
    "node:fs",
    "node:path",
    "node:events",
    "./chunk-abc.cjs",
    "../shared/util.cjs",
    ".",
    "..",
    "/absolute/path.cjs",
    "C:\\app\\resources\\x.cjs",
  ]) {
    assert.equal(isAllowedPreloadRequire(specifier), true, `${specifier} 应放行`);
  }
});

test("外部模块一律违规：zod / @zcode/shared 裸名 / 其它第三方", () => {
  for (const specifier of ["zod", "@zcode/shared", "@zcode/shared/mcp-apps", "electron-updater"]) {
    assert.equal(isAllowedPreloadRequire(specifier), false, `${specifier} 应判违规`);
  }
});

test("findDisallowedPreloadRequires：白名单内容零违规", () => {
  const violations = findDisallowedPreloadRequires([
    {
      path: "/out/preload/browserVideoRecorder.cjs",
      content: 'const { ipcRenderer } = require("electron"); const fs = require("node:fs");',
    },
  ]);
  assert.deepEqual(violations, []);
});

test("findDisallowedPreloadRequires：报出外置模块（含单引号与空格写法）", () => {
  const violations = findDisallowedPreloadRequires([
    {
      path: "/out/preload/index.cjs",
      content: [
        'const e = require("electron");',
        "const z = require('zod');",
        'const z2 = require ( "zod" );',
        'const s = require("@zcode/shared");',
      ].join("\n"),
    },
  ]);
  // 同一文件里 zod 出现两次（单引号 / 带空格），按 file+module 去重后只报一条。
  assert.deepEqual(violations, [
    { file: "/out/preload/index.cjs", module: "zod" },
    { file: "/out/preload/index.cjs", module: "@zcode/shared" },
  ]);
});

test("findDisallowedPreloadRequires：多文件各自定位，互不吞并", () => {
  const violations = findDisallowedPreloadRequires([
    { path: "/out/preload/index.cjs", content: 'require("zod");' },
    { path: "/out/preload/resourceManager.cjs", content: 'require("zod"); require("./x.cjs");' },
    { path: "/out/preload/browserVideoRecorder.cjs", content: 'require("electron");' },
  ]);
  assert.deepEqual(violations, [
    { file: "/out/preload/index.cjs", module: "zod" },
    { file: "/out/preload/resourceManager.cjs", module: "zod" },
  ]);
});

test("findDisallowedPreloadRequires：只认 require(...) 调用形态，属性访问不算", () => {
  const violations = findDisallowedPreloadRequires([
    {
      path: "/out/preload/index.cjs",
      // `loader.require('zod')` 是属性访问，不是本策略关心的模块解析入口。
      content: "loader.require('zod');\nconst mod = require('./local.cjs');",
    },
  ]);
  assert.deepEqual(violations, []);
});

test("findDisallowedPreloadRequires：被字符串字面量整段包住的 require 文本不算", () => {
  const violations = findDisallowedPreloadRequires([
    {
      path: "/out/preload/index.cjs",
      // 形如 `"require('zod')"`：require 前面紧贴引号，说明它只是被当作文本内容。
      content: "const hint = 'require(\"zod\")';\nconst e = require('electron');",
    },
  ]);
  assert.deepEqual(violations, []);
});
