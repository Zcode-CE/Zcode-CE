/**
 * 沙箱安全：vm.createContext 求值单元的隔离契约。
 *
 * 移植上游 v3.18.2 `tests/security.test.ts` 的逃逸链断言。上游那套跑在 vitest + runWorkflowScript
 * facade 上；本包没有 facade 测试环境，而 vm 契约本身才是被测对象——脚本按设计**无法**通过
 * facade typecheck（直接摸 process/import 等），所以这里直接驱动 `childMain`、把手写的 lowered
 * 函数体投喂进去，这是正当做法。
 *
 * 回归对象（每条都曾经真实可用，见 child-source.ts 沙箱构造处的注释）：
 *   - 沙箱对象是外层 `{}` ⇒ `globalThis.constructor.constructor("return process")()`；
 *   - `__send` / `__finish` 挂在全局 ⇒ `__send.constructor.constructor("return process")()`；
 *   - 外层现取现调 `sandbox.__deliver(line)` ⇒ 脚本换掉它即收到外层沙箱对象当 `this`；
 *   - 外层对 cell promise 调 `.then` ⇒ 脚本改写 `Promise.prototype.then` 即收到外层回调。
 *
 * 运行：cd apps/zcode-cli/packages/dynamic-workflow-runtime && \
 *   mise exec node@24.14.0 -- node --import tsx --test test/security.test.ts
 */

import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import test from "node:test";
import vm from "node:vm";
import { childMain } from "../src/child-source.js";

interface CompleteLine {
  kind: string;
  ok: boolean;
  value?: unknown;
  error?: { name?: string; message?: string };
}

/**
 * 在 cell 内把「这个值是否来自外层 realm」判成布尔：`Function` 是 context 自己的，所以外层函数/
 * 对象身上的 `.constructor.constructor` 一定不等于它。断言一律写成「脚本看不到外层 realm 的
 * Function」，而不是「process 拿不到」—— 后者会漏掉别的出口。
 */
const FOREIGN = [
  "(v) => (typeof v === 'function' || (typeof v === 'object' && v !== null))",
  "  && v.constructor !== undefined && v.constructor.constructor !== Function",
].join("");

interface RunOptions {
  /** 观察/干预出站行；抛出即模拟宿主传输故障（外层 realm 的异常）。 */
  onWrite?: (chunk: string) => void;
}

/** 起一个 childMain，自动应答 request，返回最后一条 complete（父进程侧视角）。 */
async function runChild(lowered: string, options: RunOptions = {}): Promise<CompleteLine> {
  const lines: string[] = [];
  const stdin = new PassThrough();
  const stdout = {
    write(chunk: string): unknown {
      options.onWrite?.(chunk);
      lines.push(chunk);
      let message: { kind?: string; id?: string } | undefined;
      try {
        message = JSON.parse(chunk) as { kind?: string; id?: string };
      } catch {
        return true;
      }
      // 应答语义本身由父进程 harness 负责；这里只要保证 request 永远有回应，脚本不会悬住。
      if (message.kind === "request") {
        setImmediate(() => {
          stdin.write(
            `${JSON.stringify({ kind: "response", id: message.id, ok: true, value: [] })}\n`,
          );
        });
      }
      return true;
    },
  };
  await childMain({ vm, createInterface, stdin, stdout, payload: { lowered, args: {} } });
  const last = lines.at(-1);
  assert.ok(last, "child emitted no line at all");
  return JSON.parse(last) as CompleteLine;
}

/** 跑一个直接 return 表达式的沙箱体，取回 complete 里的 value。 */
async function evalInSandbox(expression: string, options: RunOptions = {}): Promise<unknown> {
  const complete = await runChild(`return ${expression};`, options);
  assert.equal(complete.kind, "complete");
  assert.equal(complete.ok, true, `sandbox body failed: ${complete.error?.message}`);
  return complete.value;
}

test("沙箱安全：Node 全局缺席，ES intrinsics 在场", async () => {
  for (const name of ["process", "fetch", "require", "Buffer", "global"]) {
    assert.equal(await evalInSandbox(`typeof ${name}`), "undefined", `${name} should be absent`);
  }
  assert.equal(await evalInSandbox("typeof globalThis.process"), "undefined");
  assert.equal(await evalInSandbox("typeof JSON"), "object");
  assert.equal(await evalInSandbox("typeof Promise"), "function");
  assert.equal(await evalInSandbox("Array.isArray([1,2])"), true);
});

test("沙箱安全：动态 import() 抛 ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING", async () => {
  const result = await evalInSandbox(
    `(await (async () => { try { await import("node:fs"); return "NO-THROW"; } catch (e) { return String(e && (e.code || e.name)); } })())`,
  );
  assert.match(String(result), /ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING/u);
});

test("沙箱安全：运行期不确定性禁令（belt）", async () => {
  assert.match(
    String(await evalInSandbox('(() => { try { Date.now(); return "NO"; } catch (e) { return e.message; } })()')),
    /Date\.now\(\)/u,
  );
  assert.match(
    String(await evalInSandbox('(() => { try { new Date(); return "NO"; } catch (e) { return e.message; } })()')),
    /argless new Date\(\)/u,
  );
  assert.equal(await evalInSandbox("new Date(0).getTime()"), 0);
  assert.match(
    String(await evalInSandbox('(() => { try { Math.random(); return "NO"; } catch (e) { return e.message; } })()')),
    /Math\.random\(\)/u,
  );
});

test("沙箱安全：eval 绑定同一套受控全局（隔离不靠改写脚本文本）", async () => {
  assert.equal(await evalInSandbox('eval("typeof process")'), "undefined");
  assert.equal(
    await evalInSandbox('(() => { try { eval("Date.now()"); return "NO"; } catch (e) { return "THREW"; } })()'),
    "THREW",
  );
});

test("沙箱安全：__host 通路在加固后仍然可用（createActor / ask / log / args）", async () => {
  const result = await evalInSandbox(`await (async () => {
    const actor = __host.createActor("site#1", "worker", null);
    const answer = await __host.ask("site#2", actor, "hi");
    __host.log("hello");
    __host.enterPhase("phase");
    __host.report("site#3", { ok: true });
    return { actor, answer, args: __host.args };
  })()`);
  assert.deepEqual(result, { actor: "local#1", answer: [], args: {} });
});

// —— 跨 realm 逃逸回归 ——

test("realm boundary：全局对象不继承自外层 realm", async () => {
  // 曾经：沙箱对象是外层 realm 的 `{}`，context 全局的属性查找落到外层 Object.prototype 上。
  assert.equal(
    await evalInSandbox(
      '(() => { try { return typeof globalThis.constructor.constructor("return process")(); } catch (e) { return "blocked"; } })()',
    ),
    "blocked",
  );
});

test("realm boundary：传输函数对脚本不可见", async () => {
  // 曾经：宿主箭头函数 `__send` 原样挂在全局上，`__send.constructor` 即外层 Function。
  assert.deepEqual(await evalInSandbox("[typeof globalThis.__send, typeof globalThis.__finish]"), [
    "undefined",
    "undefined",
  ]);
});

test("realm boundary：全局与 __host 上没有任何外层 realm 的值", async () => {
  const foreign = await evalInSandbox(`(() => {
    const foreign = ${FOREIGN};
    const hits = [];
    for (const k of Object.getOwnPropertyNames(globalThis)) {
      let v; try { v = globalThis[k]; } catch (e) { continue; }
      if (foreign(v)) hits.push(k);
    }
    for (const k of Object.keys(__host)) if (foreign(__host[k])) hits.push("__host." + k);
    return hits;
  })()`);
  assert.deepEqual(foreign, []);
});

test("realm boundary：宿主传输异常过界后是 context-native 错误", async () => {
  // 曾经：`${line}` 在宿主函数里对 Symbol 求值抛外层 TypeError；宿主 write 抛错也一样。
  const result = await evalInSandbox(
    `(() => {
      const send = globalThis.__emitLine ?? globalThis.__send;
      const foreign = ${FOREIGN};
      try { send("probe-transport"); return "no-throw"; } catch (e) { return foreign(e) ? "FOREIGN" : "native"; }
    })()`,
    {
      onWrite: (chunk) => {
        if (chunk.includes("probe-transport")) throw new Error("host transport boom");
      },
    },
  );
  assert.equal(result, "native");
});

test("realm boundary：外层不会调用脚本换进来的入口函数", async () => {
  // 曾经：外层每次现取现调 `sandbox.__deliver(line)`，脚本换掉它就能拿到外层沙箱对象当 `this`。
  const result = await evalInSandbox(`await (async () => {
    const foreign = ${FOREIGN};
    const seen = [];
    const orig = globalThis.__deliver;
    globalThis.__deliver = function (line) {
      seen.push(foreign(this) ? "FOREIGN-this" : "called");
      return orig(line);
    };
    const paths = await __host.worldRead("world-read#1", "glob", ["*"]);
    return { paths, seen };
  })()`);
  assert.deepEqual(result, { paths: [], seen: [] });
});

test("realm boundary：外层不会对 cell promise 调 then()", async () => {
  // 曾经：外层对 __execute 返回的 promise 调 `.then(hostFn, hostFn)`；脚本先改写
  // Promise.prototype.then（在第一个 await 之前同步完成）就能收到这两个宿主函数。
  const result = await evalInSandbox(`await (async () => {
    const foreign = ${FOREIGN};
    const origThen = Promise.prototype.then;
    let leaked = "none";
    Promise.prototype.then = function (a, b) {
      if (foreign(a) || foreign(b)) leaked = "host";
      return origThen.call(this, a, b);
    };
    await null;
    await __host.worldRead("world-read#1", "glob", ["*"]);
    Promise.prototype.then = origThen;
    return leaked;
  })()`);
  assert.equal(result, "none");
});