import assert from "node:assert/strict";
import test from "node:test";
import { parseGlobalArgs } from "../src/arguments.js";
import { run } from "../src/run.js";
import {
  parseToolSearchModeFlag,
  toolSearchRuntimeConfig,
  TOOL_SEARCH_MODE_INVALID_ERROR,
  TOOL_SEARCH_SCOPE_ERROR,
} from "../src/tool-search-flag.js";

/**
 * `--toolsearch-mode`（上游 3.16.2 F14）的入口约定。
 *
 * 为什么必须钉住：
 * - 非法值必须报错退出，不能退回 off —— 脚本传错拼写时会以为功能已开，实际工具全被隐藏；
 * - 作用域必须显式拒绝（本参数只对 --prompt/--target/tui 有意义），静默忽略会让
 *   「我在别的命令上传了 native」变成一个看不出来的空操作；
 * - 取值必须原样进入 runtimeConfig.toolSearch：core 只读这一份事实，中间重映射会让
 *   auto/native/local 三态在某一层被悄悄折叠成 on/off。
 *
 * 运行：cd apps/zcode-cli/packages/cli && node --import tsx --test test/toolSearchFlag.test.ts
 */

function fakeCtx(argv: string[]): {
  argv: string[];
  stdout: { write: (chunk: string) => boolean };
  stderr: { write: (chunk: string) => boolean };
  written: { stdout: string; stderr: string };
} {
  const written = { stdout: "", stderr: "" };
  const sink = (key: "stdout" | "stderr") => ({
    write: (chunk: string) => {
      written[key] += chunk;
      return true;
    },
  });
  return { argv, stdout: sink("stdout"), stderr: sink("stderr"), written };
}

test("参数定义接受 --toolsearch-mode <value>", () => {
  const parsed = parseGlobalArgs(["--toolsearch-mode", "native", "-p", "x"]);
  assert.equal(parsed.values["toolsearch-mode"], "native");
});

test("取值解析：默认 off，四态原样通过，非法值报错", () => {
  assert.equal(parseToolSearchModeFlag(undefined), "off");
  for (const mode of ["auto", "native", "local", "off"] as const) {
    assert.equal(parseToolSearchModeFlag(mode), mode);
  }
  assert.throws(() => parseToolSearchModeFlag("on"), {
    message: TOOL_SEARCH_MODE_INVALID_ERROR,
  });
  assert.equal(toolSearchRuntimeConfig("local").toolSearch.mode, "local");
});

test("非法值让 CLI 以 1 退出并打印完整取值清单", async () => {
  const ctx = fakeCtx(["--toolsearch-mode", "bogus", "-p", "x"]);
  const code = await run(ctx as never, { env: {} });
  assert.equal(code, 1);
  assert.ok(ctx.written.stderr.includes(TOOL_SEARCH_MODE_INVALID_ERROR), ctx.written.stderr);
});

test("作用域外使用被拒绝：错误信息点名合法用法", async () => {
  const ctx = fakeCtx(["--toolsearch-mode", "native", "doctor"]);
  const code = await run(ctx as never, { env: {} });
  assert.equal(code, 1);
  assert.ok(ctx.written.stderr.includes(TOOL_SEARCH_SCOPE_ERROR), ctx.written.stderr);
});
