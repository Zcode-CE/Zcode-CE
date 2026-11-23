# @zcode/dynamic-workflow-runtime

沙箱 harness（dynamic workflow 执行引擎）。把一份 workflow 脚本在受控子进程里跑起来，
用 NDJSON 把子进程的 `__host.*` 调用桥接到 `@zcode/dynamic-workflow` 的纯引擎核心。

## 依赖边界

**仅**依赖 `@zcode/dynamic-workflow`（workspace）与 node 内建。**绝不** import `@zcode/core` /
`@zcode/contracts` / `@zcode/bootstrap` / `@zcode/adapters`——本包是「整条 sandbox↔engine
管线 app-free 可跑」的证明。

## 用法

```ts
import { runWorkflowScript } from "@zcode/dynamic-workflow-runtime";

const settlement = await runWorkflowScript({
  scriptText,                 // 或 lowered: <async 函数体>
  caps: { maxConcurrency: 16 },
  askSpecs,                   // site id ∈ 合成 schemas 记录即 typed
  validate,                   // @zcode/dynamic-workflow 的 validate（适配到 ValidateFn）
  makeDriver: (sink) => driver, // driver 自带 journal + emit；sink 是引擎的向上回报面
  signal,                     // 可选：AbortSignal
  timeoutMs,                  // 可选：墙钟超时
});
// settlement: { status: "completed", artifact } | { status: "failed", error } | { status: "cancelled" }
```

## 架构

```
┌─ parent (harness) ──────────────┐  NDJSON  ┌─ child (vm.createContext) ──────┐
│ runWorkflowScript               │  stdio   │ 只含 ES intrinsics + __host       │
│  - lower(scriptText)            │◀────────▶│  createActor 同步返回 local 句柄  │
│  - WorkflowEngine(driver,...)   │          │  ask/worldRead → 请求父进程       │
│  - 桥接 __host.* ↔ engine       │          │  args 冻结全局（spawn 时过界一次）  │
│  - spawn/kill/timeout/abort     │          │  Date.now/Math.random 运行期禁令  │
└─────────────────────────────────┘          └──────────────────────────────────┘
```

## NDJSON 线协议

见 `src/protocol.ts`（唯一真源）。child→parent：`create-actor`（即发即忘）/ `request`（ask、
world-read）/ `event`（log）/ `complete`；parent→child：`response`。

## 沙箱边界（防 vm 逃逸）

脚本在 `vm.createContext` 的独立 realm 里求值，外层与 cell 之间**只有字符串过界**。下面每条都
对应一条实测可用过的逃逸路径（脚本拿到外层 realm 的任意函数/对象，`.constructor.constructor`
就是外层 `Function`，`Function("return process")()` 即宿主进程），回归测试在
`test/security.test.ts`——每条断言都是「修复前红、修复后绿」：

1. 沙箱对象是 `Object.create(null)`。外层 `{}` 会让 context 全局的属性查找落到外层
   `Object.prototype`，`globalThis.constructor.constructor("return process")()` 直接拿到宿主 `process`。
2. 宿主传输函数 `__send` / `__finish` 在 BOOTSTRAP 第一句收进闭包并从全局删除；它们只接收字符串
   （不做隐式强转），宿主侧抛出的一切由 cell 侧包装转成 context-native `Error`。
3. 入口（`__deliver` / `__execute`）在脚本运行前取走、此后裸调。现取现调时脚本能把入口换掉，
   而 `sandbox.__deliver(line)` 还会把外层沙箱对象当 `this` 递进去。
4. 外层不对 cell 的 promise 调 `then`：脚本能改写 `Promise.prototype.then` 收到外层回调。收尾改由
   cell 调 `__finish` 通知（关 stdin、兑现子进程出口的 promise）。

运行：`cd apps/zcode-cli/packages/dynamic-workflow-runtime && pnpm test`（Node 版本以仓库 `mise.toml` 为准）。

## 构建顺序

测试与 typecheck 通过 `@zcode/dynamic-workflow` 的**已构建 dist** 解析依赖，故 `pretest` /
`pretypecheck` 会先 `pnpm --filter @zcode/dynamic-workflow build`。全新检出直接 `pnpm test` 即可，
不会踩到 stale-dist。

## 失败裁决与取舍

- run 的裁决归引擎所有。终结失败（脚本抛错 / 子进程崩溃 / 超时 / 协议损坏）都调
  `engine.fail(error)`——结算 `failed`、driver 侧取消在飞 ask、journal 记 `dwf_run.status =
  "failed"` + `failure_json`，journal 与调用方看到的结果一致。abort 信号是唯一的"真取消"，
  调 `engine.cancel()`（结算 `cancelled`，可 resume）。harness 侧的 first-wins finalize 只管
  子进程清理（清 timer、关 stdin、kill child），不自造结算。
