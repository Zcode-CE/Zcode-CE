// 回归判据：server-cli / server-core 的 ESM bundle 不能把 CJS 依赖内联成会抛错的 __require。
//
// 背景（task-44）：tsup 输出 ESM 时，被内联的 CJS 依赖（services 反馈日志 ZIP 链路里的 yazl）
// 会留下 require("fs")/require("stream")，落到 esbuild 的 __require 兜底上，运行时抛
// "Dynamic require of \"fs\" is not supported" —— 直接执行 dist/server-cli.js 即崩。
// 修法与 packages/server/tsup.config.ts 的 SERVER_HTTP_EXTERNAL_DEPENDENCIES 同一结论：把这类 CJS 依赖保留为 external。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(packageRoot, "dist");

test("tsup 配置把 CJS ZIP 依赖保留为 external（yazl/yauzl）", () => {
  const config = readFileSync(join(packageRoot, "tsup.config.ts"), "utf8");
  const externalBlock = config.slice(config.indexOf("external: ["));
  for (const name of ["yazl", "yauzl"]) {
    assert.ok(
      externalBlock.includes('"' + name + '"'),
      `tsup external 列表缺少 ${name}：内联它会让 ESM bundle 命中 __require 兜底并在加载时崩溃`,
    );
  }
});

test("bundle 里不含会抛错的动态 require 兜底（需要先 build）", (t) => {
  const entries = ["server-cli.js", "server-core.js"].map((name) => join(distDir, name));
  if (!entries.every((file) => existsSync(file))) {
    t.skip("dist 未构建：先跑 pnpm --filter @zcode/server-cli build");
    return;
  }
  for (const file of entries) {
    const code = readFileSync(file, "utf8");
    assert.doesNotMatch(
      code,
      /Dynamic require of/,
      `${file} 仍含 __require 兜底：内联的 CJS 依赖没被外置`,
    );
  }
  const cli = readFileSync(entries[0], "utf8");
  assert.match(cli, /from "yazl"/, "server-cli.js 应以外部导入的方式引用 yazl");
  assert.doesNotMatch(cli, /node_modules\/yazl\/index\.js/, "server-cli.js 不应内联 yazl 的实现");
});

test("直接执行 dist/server-cli.js 不再崩溃（需要先 build）", async (t) => {
  const entry = join(distDir, "server-cli.js");
  if (!existsSync(entry)) {
    t.skip("dist 未构建：先跑 pnpm --filter @zcode/server-cli build");
    return;
  }
  // 用一个不存在的子命令：修复前是加载期崩溃，修复后应给出可读的 Unknown command。
  const failure = await exec(process.execPath, [entry, "__smoke_unknown_command__"]).then(
    () => undefined,
    (error) => error,
  );
  assert.ok(failure, "未知子命令应当以非零退出");
  const output = String(failure.stdout ?? "") + String(failure.stderr ?? "");
  assert.doesNotMatch(output, /Dynamic require of/, output);
  assert.match(output, /Unknown command: __smoke_unknown_command__/, output);
});
