/* eslint-disable max-lines -- shared node_repl host 的 worker、CUA bridge 和生命周期必须保持同一边界。 */
import { resolve } from "node:path";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { INVALID_PARAMS, Server, type Tool } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { JsInputJsonSchema } from "@zcode/contracts/tools/node-repl";
// 值导入必须走 @zcode/core/repl 这条深路径：barrel 会把 core 的整张图拖进 bundle
// （tool handlers → @zcode/dynamic-workflow → typescript，实测 21.7MB 且求值即崩
// ERR_AMBIGUOUS_MODULE_SYNTAX）。宿主只需要 REPL 会话本身。
// 类型也一并从 /repl 取：总入口的顶层副作用会把 Agent、Bash 注册表和工作流编译器
// 打入每个 REPL Worker，Worker 会重复承担这份开销。
import {
  NodeReplSession,
  type NodeReplRequestMeta,
  type NodeReplRunResult,
} from "@zcode/core/repl";
import { createComputerUseRuntime, type ComputerUseRuntime } from "@zcode/zcode-cua";
import { z } from "zod";
import { createBrowserBridgeGlobals, type ActiveNodeReplCall } from "./browser-bridge.js";
import {
  createComputerUseBridgeGlobals,
  type ActiveCuaNodeReplCall,
  type NodeReplCuaBrokerConnection,
} from "./cua-bridge.js";
import { createNodeReplCuaBroker, type NodeReplCuaBroker } from "./cua-broker.js";
import {
  isDirectMcpEntrypoint,
  installNodeReplProcessGuards,
  installNodeReplShutdownTriggers,
} from "./process-lifecycle.js";
import { toMcpRunResult } from "./result.js";
import {
  resolveJsToolDescription,
  NODE_REPL_DEFAULT_TIMEOUT_MS,
  NODE_REPL_SERVER_INSTRUCTIONS,
  withComputerUseAvailabilityNote,
  NODE_REPL_SERVER_VERSION,
} from "./tool-contract.js";

const MAX_SYNC_TIMEOUT_MS = 120_000;
// 驱动包名必须与 packages/zcode-cua/cua-driver-runtime.js 的 DRIVER_PACKAGE 一致；
// 那边是 esbuild 无法内联的变量 specifier，所以两处都只能是字面量，靠这条注释与
// regression 测试（packages/services/test/platformVariantAndCuaDriverStaging.test.ts）钉住。
const CUA_DRIVER_PACKAGE_SPECIFIER = "@trycua/cua-driver";
const UNTRUSTED_SESSION_KEY = "__unscoped__";
const WORKER_KIND = "zcode-node-repl-call";
export const NODE_REPL_MCP_PROCESS_TITLE = "zcode-node-repl-mcp";
const pluginRoot = process.env.ZCODE_PLUGIN_ROOT ?? process.cwd();
// CUA 与 Browser Use 共用 node_repl host，但文档和 native 依赖必须按领域隔离；
// 否则 CUA skill 会因为 host root 恰好来自 Browser Use 而再次产生隐式依赖。
const browserDocumentationRoot = resolve(pluginRoot, "docs");
const cuaDocumentationRoot = resolve(
  process.env.ZCODE_CUA_PLUGIN_ROOT ?? pluginRoot,
  "docs",
);
const jsInputSchema = z
  .object({
    code: z.string(),
    timeout_ms: z.number().int().min(1).max(MAX_SYNC_TIMEOUT_MS).optional(),
    // tools/list 对新调用强制 title，但执行层必须继续接受旧 provider 和历史回放的 code-only 输入。
    title: z.string().min(1).max(120).optional(),
  })
  .strict();
const requestContextSchema = z
  .object({
    parent_span_id: z.string().optional(),
    runtime_scope: z.enum(["main", "subagent"]).default("main"),
    session_id: z.string().trim().min(1).optional(),
    span_id: z.string().optional(),
    trace_id: z.string().optional(),
    turn_id: z.string().optional(),
    workspace_identity: z.string().optional(),
    workspace_key: z.string().optional(),
    workspace_path: z.string().optional(),
    remote_session_id: z.string().optional(),
    client_mode: z.string().optional(),
    delivery_kind: z.string().optional(),
  })
  .passthrough();

// `js` 工具的描述随「本会话是否启用 CUA」变化：CUA 关闭时要显式告诉模型「没有 CUA，也没有东西
// 需要安装」，否则它拿到 node_repl 就会自行安装驱动并猜错包名（方案 a，见 tool-contract.ts）。
// 工具名与 inputSchema 不变，只有描述多一句后缀。
function buildNodeReplTools(input: { computerUseEnabled: boolean }): Tool[] {
  return [
    {
      name: "js",
      description: resolveJsToolDescription(input),
      // host MCP 曾手写出 title optional 的模型合同，和 built-in 合同分叉后 UI 只能显示固定完成文案。
      inputSchema: JsInputJsonSchema as Tool["inputSchema"],
    },
  ];
}

export interface NodeReplExecuteInput {
  code: string;
  requestMeta: NodeReplRequestMeta;
  signal: AbortSignal;
  syncTimeoutMs: number;
  cuaBroker?: NodeReplCuaBrokerConnection;
}

export type NodeReplExecutor = (input: NodeReplExecuteInput) => Promise<NodeReplRunResult>;

export interface NodeReplMcpRuntime {
  dispose(): void;
  server: Server;
}

interface WorkerCallData {
  code: string;
  kind: typeof WORKER_KIND;
  requestMeta: NodeReplRequestMeta;
  syncTimeoutMs: number;
  cuaBroker?: NodeReplCuaBrokerConnection;
}

export function setNodeReplMcpProcessTitle(target: { title: string } = process): void {
  target.title = NODE_REPL_MCP_PROCESS_TITLE;
}

/**
 * 测试与同进程嵌入入口使用同一条执行逻辑；生产 stdio 默认在一次性 Worker 中调用它，
 * 从而连 Node 的模块缓存也随调用一起销毁。
 */
export function createInProcessNodeReplExecutor(): NodeReplExecutor {
  return async (input) => {
    let activeCall: ActiveNodeReplCall | undefined;
    let activeCuaCall: ActiveCuaNodeReplCall | undefined;
    let session: NodeReplSession;
    const generation = 1;
    session = new NodeReplSession({
      injectedGlobals: () =>
        ({
          ...createBrowserBridgeGlobals({
            documentationRoot: browserDocumentationRoot,
            generation,
            getActiveCall: () => activeCall,
            session: () => session,
          }),
          ...createComputerUseBridgeGlobals({
            broker: input.cuaBroker,
            generation,
            getActiveCall: () => activeCuaCall,
            session: () => session,
            documentationRoot: cuaDocumentationRoot,
          }),
        }),
      restrictProcess: true,
    });
    activeCall = {
      generation,
      requestMeta: input.requestMeta,
      signal: input.signal,
    };
    activeCuaCall = {
      generation,
      requestMeta: input.requestMeta,
      signal: input.signal,
    };
    try {
      return await session.run(input.code, {
        requestMeta: input.requestMeta,
        signal: input.signal,
        syncTimeoutMs: input.syncTimeoutMs,
      });
    } finally {
      activeCall = undefined;
      activeCuaCall = undefined;
      session.dispose();
    }
  };
}

export function createNodeReplMcpRuntime(
  input: { executeJs?: NodeReplExecutor; cuaRuntime?: ComputerUseRuntime } = {},
): NodeReplMcpRuntime {
  const executeJs = input.executeJs ?? executeJsInWorker;
  const cuaRuntime =
    input.cuaRuntime ?? captureComputerUseRuntimeFromEnvironment();
  const cuaBroker = cuaRuntime
    ? createNodeReplCuaBroker({ runtime: cuaRuntime, platform: process.platform })
    : undefined;
  const queues = new Map<string, Promise<void>>();
  const activeCalls = new Set<AbortController>();
  let disposed = false;

  const serialized = async <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const previous = queues.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const next = new Promise<void>((resolveQueue) => {
      release = resolveQueue;
    });
    queues.set(key, next);
    await previous;
    try {
      return await run();
    } finally {
      release();
      if (queues.get(key) === next) queues.delete(key);
    }
  };

  const server = new Server(
    { name: "node_repl", version: NODE_REPL_SERVER_VERSION },
    {
      capabilities: { tools: {} },
      // CUA 未启用时在 instructions 里显式说明「没有 CUA，也没有东西需要安装」，
      // 避免模型拿到 node_repl 就自行安装驱动（方案 a，见 tool-contract.ts）。
      instructions: withComputerUseAvailabilityNote(NODE_REPL_SERVER_INSTRUCTIONS, {
        computerUseEnabled: cuaRuntime !== undefined,
      }),
    },
  );

  const tools = buildNodeReplTools({ computerUseEnabled: cuaRuntime !== undefined });
  server.setRequestHandler("tools/list", async () => ({ tools }));
  server.setRequestHandler("tools/call", async (request, extra) => {
    if (disposed) throw new Error("node_repl runtime is disposed");
    const name = request.params.name;
    const requestMeta = buildRequestMeta(extra.mcpReq._meta);
    const sessionKey = requestSessionKey(requestMeta);
    if (name === "js") {
      const args = parseToolInput(jsInputSchema, request.params.arguments, name);
      return await serialized(sessionKey, async () => {
        if (!args.code) {
          return {
            content: [{ type: "text" as const, text: "js expects non-empty JavaScript source" }],
            isError: true,
          };
        }
        const callController = new AbortController();
        activeCalls.add(callController);
        const timeoutMs = args.timeout_ms ?? NODE_REPL_DEFAULT_TIMEOUT_MS;
        const callMeta = { ...requestMeta, ...(args.title ? { title: args.title } : {}) };
        try {
          const signal = AbortSignal.any([
            extra.mcpReq.signal,
            callController.signal,
            AbortSignal.timeout(timeoutMs),
          ]);
          const run = await executeJs({
            code: args.code,
            requestMeta: callMeta,
            signal,
            syncTimeoutMs: Math.min(timeoutMs, MAX_SYNC_TIMEOUT_MS),
            cuaBroker: cuaBroker?.connection,
          });
          return toMcpRunResult(run);
        } finally {
          activeCalls.delete(callController);
        }
      });
    }
    invalidParams(`Tool ${name} not found`);
  });

  return {
    server,
    dispose: () => {
      disposed = true;
      for (const controller of activeCalls) controller.abort();
      activeCalls.clear();
      queues.clear();
      void cuaBroker?.close();
      void cuaRuntime?.dispose();
    },
  };
}

async function executeJsInWorker(input: NodeReplExecuteInput): Promise<NodeReplRunResult> {
  if (input.signal.aborted) throw input.signal.reason;
  const data: WorkerCallData = {
    code: input.code,
    kind: WORKER_KIND,
    requestMeta: input.requestMeta,
    syncTimeoutMs: input.syncTimeoutMs,
    cuaBroker: input.cuaBroker,
  };
  const worker = new Worker(new URL(import.meta.url), { workerData: data });
  return await new Promise<NodeReplRunResult>((resolveRun, rejectRun) => {
    let settled = false;
    const cleanup = () => {
      input.signal.removeEventListener("abort", onAbort);
      worker.removeAllListeners();
    };
    const finish = (error?: unknown, result?: NodeReplRunResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      void worker.terminate().catch(() => undefined);
      if (error !== undefined) rejectRun(error);
      else if (result) resolveRun(result);
      else rejectRun(new Error("node_repl worker returned no result"));
    };
    const onAbort = () => finish(input.signal.reason ?? new DOMException("aborted", "AbortError"));
    input.signal.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (message: unknown) => finish(undefined, message as NodeReplRunResult));
    worker.once("error", finish);
    worker.once("exit", (code) => {
      if (!settled)
        finish(new Error(`node_repl worker exited before returning a result (${code})`));
    });
    if (input.signal.aborted) onAbort();
  });
}

function parseToolInput<T>(schema: z.ZodType<T>, input: unknown, toolName: string): T {
  const parsed = schema.safeParse(input ?? {});
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  invalidParams(`${toolName}: ${issue?.message ?? "invalid arguments"}`);
}

function invalidParams(message: string): never {
  throw Object.assign(new Error(message), { code: INVALID_PARAMS });
}

function buildRequestMeta(meta: Record<string, unknown> | undefined): NodeReplRequestMeta {
  const parsed = requestContextSchema.safeParse(meta?.["com.zcode/request-context"]);
  // 安全边界：顶层 MCP _meta 是第三方可扩展字段，不能成为 ZCode session 路由凭据。
  // 只有 host client 写入的命名空间会进入 Browser bridge；旧 client 的普通 JS 仍可执行。
  return parsed.success ? parsed.data : {};
}

function requestSessionKey(meta: NodeReplRequestMeta): string {
  const sessionId = meta.session_id;
  return typeof sessionId === "string" && sessionId.trim() ? sessionId : UNTRUSTED_SESSION_KEY;
}

export { installNodeReplProcessGuards, installNodeReplShutdownTriggers };

export async function main(): Promise<void> {
  setNodeReplMcpProcessTitle();
  const runtimes = new Set<NodeReplMcpRuntime>();
  // 官方 plugin host 在 main() 返回后会清除短暂恢复的 Helper 凭据，而
  // serveStdio 的 server factory 要到 MCP initialize 时才执行。过去在 factory 内读取
  // process.env，必然得到空值，导致 node_repl 永久把 Computer Use 判为 unavailable。
  // 这里在 main() 生命周期内先捕获 runtime；Worker 只收到二次 bridge token，
  // 不会接触 Helper 的原始 socket/token。
  const computerUseRuntime = captureComputerUseRuntimeFromEnvironment();
  const handle = serveStdio(
    () => {
      const runtime = createNodeReplMcpRuntime({ cuaRuntime: computerUseRuntime });
      runtimes.add(runtime);
      return runtime.server;
    },
    { legacy: "reject" },
  );
  let shutdownStarted = false;
  const shutdown = () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    for (const runtime of runtimes) runtime.dispose();
    void handle
      .close()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  installNodeReplProcessGuards({
    onOutputClosed: shutdown,
    process,
    writeStderr: (text) => process.stderr.write(text),
  });
  installNodeReplShutdownTriggers({ process, shutdown, stdin: process.stdin });
}

if (!isMainThread && isWorkerCallData(workerData)) {
  const execute = createInProcessNodeReplExecutor();
  const controller = new AbortController();
  void execute({
    code: workerData.code,
    requestMeta: workerData.requestMeta,
    signal: controller.signal,
    syncTimeoutMs: workerData.syncTimeoutMs,
    cuaBroker: workerData.cuaBroker,
  })
    .then((result) => parentPort?.postMessage(result))
    .catch((error) => {
      parentPort?.postMessage({
        logs: "",
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        },
      } satisfies NodeReplRunResult);
    });
}

export function captureComputerUseRuntimeFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): ComputerUseRuntime | undefined {
  // 只有桌面/共享宿主会话才提供 Computer Use：ZCODE_CUA_NODE_REPL_HOST 由宿主在把
  // node_repl 作为 Computer Use 宿主拉起时设置。没有它时不要凭空创建运行时 ——
  // 否则每个普通 MCP 客户端（含 CI、测试）都会拉起一次原生驱动。
  // 取值口径与 plugin-host-command.ts 一致（严格等于 "1"）：宿主只在确实要提供
  // Computer Use 时才注入该值，写成 "0" 或空串都视为不提供。
  if (env.ZCODE_CUA_NODE_REPL_HOST !== "1") return undefined;
  // 护栏：驱动**解析不到**时不要报告「CUA 可用」。
  //
  // 为什么必须在这里探测：`createComputerUseRuntime` 总是返回一个对象，而驱动是懒加载
  // （packages/zcode-cua/cua-driver-runtime.js:144 的首次 callDriverOnce 才 ensureDriver）。
  // 于是「驱动载荷缺失」不会让 cuaRuntime 变 undefined —— 两道防「模型自行装包」的护栏
  // 因此**同时失效**：
  //   1. `js` 工具描述不再追加 JS_TOOL_DESCRIPTION_COMPUTER_USE_DISABLED_SUFFIX；
  //   2. CUA_UNAVAILABLE_IN_SESSION_MESSAGE（broker 缺失路径）不会触发。
  // 模型最终只看到首次调用抛出的「driver is unavailable … Cannot find package
  // '@trycua/cua-driver'」—— 点名包名且说「不可用」，实测正是诱导它自行 npm install
  // 猜包名的文案（cua-bridge.ts:10-15 记录过这个失效模式）。见
  // .reverse/29-cua-seed/CUA-SEED-PAYLOAD.md。
  //
  // 探测只做**解析**，不 import 驱动：不拉起原生库、不产生副作用，CI 与无图形会话
  // 也安全。解析失败即按「本会话 CUA 不可用」降级，让上面两道护栏照常生效。
  if (!isCuaDriverResolvable()) return undefined;
  // 实现选择：默认走 MIT 许可的 @trycua/cua-driver。
  //
  // 这里**不再**按 ZCODE_CUA_PERMISSION_BROKER_SOCKET 决定实现。那个 socket 是官方
  // Helper（未标注许可的私有二进制）的连接材料，本项目不使用它；仅 Linux 与 macOS
  // 的官方 Helper 也都不支持，而 cua-driver 三平台都有预编译产物。
  // 仍读取它只为把「宿主为何以为有官方 Helper」写进诊断，不改变实现选择。
  return createComputerUseRuntime({
    driver: "open-source",
    ...(env.ZCODE_CUA_PERMISSION_BROKER_SOCKET?.trim()
      ? { brokerSocketPath: env.ZCODE_CUA_PERMISSION_BROKER_SOCKET.trim() }
      : {}),
    ...(env.ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER?.trim()
      ? { refreshMarkerPath: env.ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER.trim() }
      : {}),
  });
}

/**
 * 驱动包是否能被**本模块**解析到。
 *
 * 与驱动自身的加载口径保持一致（都是 Node 的包解析，从本 bundle 所在目录向上找
 * node_modules），所以「这里解析成功」与「懒加载时 import 成功」是同一个判据。
 * 只解析、不加载：避免探测本身拉起原生库（那正是 captureComputerUseRuntimeFromEnvironment
 * 刻意避免的事 —— 普通 MCP 客户端与 CI 不该拉起驱动）。
 *
 * 用 import.meta.resolve 而不是 createRequire().resolve：驱动是 ESM-only
 * （`"type": "module"`，exports 里只有 import 条件），createRequire 会以 CJS 条件解析，
 * 实测抛 ERR_PACKAGE_PATH_NOT_EXPORTED —— 那会把「载荷在」误判成「不可用」。
 */
function isCuaDriverResolvable(): boolean {
  try {
    import.meta.resolve(CUA_DRIVER_PACKAGE_SPECIFIER);
    return true;
  } catch {
    return false;
  }
}

function isWorkerCallData(value: unknown): value is WorkerCallData {
  if (!value || typeof value !== "object") return false;
  return (value as { kind?: unknown }).kind === WORKER_KIND;
}

if (isMainThread && (await isDirectMcpEntrypoint(import.meta.url, process.argv[1]))) {
  void main().catch((error) => {
    process.stderr.write(
      `node_repl MCP server failed: ${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
