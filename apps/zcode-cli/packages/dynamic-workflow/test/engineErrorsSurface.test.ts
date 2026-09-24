import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * 引擎结构纯化后的公开面守卫（上游 3.14.3 的 max-lines 拆分）。
 *
 * 为什么需要它：errors.ts 与 workflow-driver-submit-bridge.ts 都是「把一个已经抵 400 行门的
 * 文件里的整段搬出去」。这类搬迁的失败模式不是崩溃，而是公开面悄悄变窄 ——
 * 消费者按惯例从 types / workflow-driver 取这些符号，少一个再导出就是编译期错误（还好），
 * 但「类型从 types 取不到、却能从 errors 取到」这种半搬迁会让两个入口给出不同结论。
 *
 * 运行：cd apps/zcode-cli/packages/dynamic-workflow && node --import tsx --test test/engineErrorsSurface.test.ts
 */

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

function read(relative: string): string {
  return readFileSync(join(packageRoot, relative), "utf8");
}

/**
 * 剥掉整行注释与块注释后的代码。
 *
 * 为什么必须剥：这些文件的注释里本来就在讲这件事（桥接文件头部写着「只把 `this.` 换成
 * `host.`」）。不剥注释的断言会被自己的说明文字判红 —— 与 copy-and-format 里「判据要落在
 * 代码上，不要被注释里的引用命中」是同一条教训。
 */
function readCode(relative: string): string {
  return read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

test("errors.ts 承载错误码 / 可序列化形态 / WorkflowError 本体", () => {
  const errors = read("src/engine/errors.ts");
  assert.match(errors, /export type WorkflowErrorCode =/, "错误码联合类型必须在 errors.ts");
  assert.match(errors, /export interface WorkflowErrorMismatch/);
  assert.match(errors, /export interface WorkflowErrorJson/);
  assert.match(errors, /export class WorkflowError extends Error/);
});

test("types.ts 原样再导出（消费者按惯例从 types 取，公开面不得变窄）", () => {
  const types = read("src/engine/types.ts");
  assert.match(types, /export \{ WorkflowError \} from "\.\/errors\.js";/);
  assert.match(
    types,
    /export type \{ WorkflowErrorCode, WorkflowErrorJson, WorkflowErrorMismatch \} from "\.\/errors\.js";/,
  );
  // 搬迁之后 types.ts 里不得再有本体的第二份定义（否则就是两份真相源）。
  assert.equal(/export class WorkflowError\b/.test(types), false, "WorkflowError 本体只能有一份");
  assert.equal(/export type WorkflowErrorCode =/.test(types), false, "错误码联合类型只能有一份");
});

test("submit 桥接是自由函数 + 显式宿主面，driver 上只剩一处委托", () => {
  const bridge = read("../bootstrap/src/app/workflow-driver-submit-bridge.ts");
  assert.match(bridge, /export interface SubmitBridgeHost/);
  assert.match(bridge, /export function makeSessionSubmitPort\(/);
  // 桥接不得持有自己的状态：对 driver 的触碰全部经 host 递进来。
  const bridgeCode = readCode("../bootstrap/src/app/workflow-driver-submit-bridge.ts");
  assert.equal(/this\./.test(bridgeCode), false, "桥接代码里不得出现 this.（它是自由函数）");
  const driver = read("../bootstrap/src/app/workflow-driver.ts");
  assert.match(
    driver,
    /private makeSubmitPort\(sessionId: SessionId\): WorkflowSubmitPort \{\s*return makeSessionSubmitPort\(this\.submitHost, sessionId\);\s*\}/,
    "driver 上只留一处委托",
  );
});
