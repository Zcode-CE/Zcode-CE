import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import type { NodeReplCuaAppIdentity, NodeReplRequestMeta, NodeReplSession } from "@zcode/core";
import { CUA_APP_ASSOCIATIONS_META_KEY } from "@zcode/zcode-cua/host-display-contract";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const NODE_REPL_CUA_BRIDGE_SYMBOL = Symbol.for("zcode.node-repl.computer-use-bridge");
export const CUA_UNAVAILABLE_IN_SUBAGENT_MESSAGE = "Computer Use is not available in subagent";

// 方案 (a)：bridge 不可用时**停下并如实报告**，严禁自愈式安装。实测原文案（仅陈述「不可用」）
// 会被模型当成「环境缺依赖」，于是自行 npm install 猜包名（附图那次连猜两个不存在的包名）。
// 文案必须同时给「谁来做」（用户在设置里开启）与「不要做什么」（装包/换驱动）。
export const CUA_UNAVAILABLE_IN_SESSION_MESSAGE =
  "Computer Use is unavailable for this node_repl session: the runtime is provided by the " +
  "host and is not enabled for this client. Do not install, upgrade or guess a driver " +
  "package. Tell the user to enable Computer Use in Settings → Computer Use, then stop.";
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export interface ActiveCuaNodeReplCall {
  generation: number;
  requestMeta: NodeReplRequestMeta;
  signal: AbortSignal;
}

export interface NodeReplCuaBrokerConnection {
  socketPath: string;
  token: string;
}

export interface ComputerUseRuntimeBridge {
  /** 私有 capability 请求；这里不是 MCP tool 调用，MCP 只承载外层 node_repl。 */
  call(method: string, input: unknown): Promise<CallToolResult>;
  assertAvailable(): void;
  documentationRoot: string;
}

export function createComputerUseBridgeGlobals(input: {
  broker?: NodeReplCuaBrokerConnection;
  generation: number;
  getActiveCall: () => ActiveCuaNodeReplCall | undefined;
  session: () => NodeReplSession;
  documentationRoot: string;
}): Record<PropertyKey, unknown> {
  const assertActive = (): ActiveCuaNodeReplCall => {
    const active = input.getActiveCall();
    if (!active || active.generation !== input.generation) {
      throw new Error("Computer Use runtime binding is stale after kernel reset");
    }
    return active;
  };
  const assertAvailable = (): ActiveCuaNodeReplCall => {
    const active = assertActive();
    if (active.requestMeta.runtime_scope === "subagent") {
      throw new Error(CUA_UNAVAILABLE_IN_SUBAGENT_MESSAGE);
    }
    if (!input.broker) {
      // 方案 (a)：bridge 不可用即停下，明确禁止自愈式安装。原文案只陈述「不可用」，
      // 实测模型会据此自行 npm install 猜包名（附图那次连猜两个不存在的包名）。
      throw new Error(CUA_UNAVAILABLE_IN_SESSION_MESSAGE);
    }
    return active;
  };

  const bridge: ComputerUseRuntimeBridge = {
    documentationRoot: input.documentationRoot,
    assertAvailable: () => {
      assertAvailable();
    },
    call: async (method, methodInput) => {
      const active = assertAvailable();
      const result = await sendCuaBrokerRequest(
        input.broker!,
        {
          method,
          input: methodInput,
          context: requestContext(active.requestMeta),
        },
        active.signal,
      );
      assertActive();
      if (result.responseMeta) input.session().mergeResponseMeta(result.responseMeta);
      // 目标应用身份必须在这里取：broker 响应是模型看不见也改不了的一跳。等到
      // `projectToHost` 把 `_meta` 交给 `nodeRepl.emitStructuredResult` 就已经落在模型可写的
      // sandbox 通道上，无法再区分「producer 给的」和「cell 里自己写的」。
      const app = readPrimaryAppIdentity(result.result);
      if (app) input.session().recordCuaAppIdentity(app);
      return result.result;
    },
  };

  return { [NODE_REPL_CUA_BRIDGE_SYMBOL]: bridge };
}

/**
 * 从 producer 的 app-associations 元数据里取出单一目标应用。
 *
 * 只读 `primary`：`list_apps` 用的是 `items` 模式（按结果下标关联，node_repl 下没有逐条列表卡），
 * `request_access` / `stop_computer_control` 声明 `none`，这三者都不该覆盖同一 cell 里前面动作
 * 已经确立的身份。producer 自带的内联 icon PNG 刻意不取：会话协议不承载图标字节，UI 按
 * appKey 派生 locator 后交平台服务解析。
 */
function readPrimaryAppIdentity(result: CallToolResult): NodeReplCuaAppIdentity | undefined {
  const meta = result._meta;
  if (!meta || typeof meta !== "object") return undefined;
  const associations = (meta as Record<string, unknown>)[CUA_APP_ASSOCIATIONS_META_KEY];
  if (!associations || typeof associations !== "object" || Array.isArray(associations)) {
    return undefined;
  }
  const primary = (associations as { primary?: unknown }).primary;
  if (!primary || typeof primary !== "object" || Array.isArray(primary)) return undefined;
  const { appKey, displayName } = primary as { appKey?: unknown; displayName?: unknown };
  if (typeof appKey !== "string" || !appKey.trim()) return undefined;
  return {
    appKey: appKey.trim(),
    ...(typeof displayName === "string" && displayName.trim()
      ? { displayName: displayName.trim() }
      : {}),
  };
}

function requestContext(meta: NodeReplRequestMeta): Record<string, unknown> {
  const stringMeta = (key: string): string | undefined => {
    const value = meta[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const sessionId = stringMeta("session_id");
  if (!sessionId) throw new Error("node_repl CUA request is missing session_id metadata");
  const workspacePath = stringMeta("workspace_path");
  const workspaceIdentity = stringMeta("workspace_identity");
  const workspaceKey = stringMeta("workspace_key") ?? workspaceIdentity ?? workspacePath;
  if (!workspaceKey) throw new Error("node_repl CUA request is missing workspaceKey metadata");
  const clientMode = stringMeta("client_mode") ?? "desktop-continuous";
  const deliveryKind = stringMeta("delivery_kind") ?? clientMode;
  return {
    runtimeScope: meta.runtime_scope === "subagent" ? "subagent" : "main",
    sessionId,
    ...(workspacePath ? { workspacePath } : {}),
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    workspaceKey,
    ...(stringMeta("remote_session_id")
      ? { remoteSessionId: stringMeta("remote_session_id") }
      : {}),
    ...(stringMeta("turn_id") ? { turnId: stringMeta("turn_id") } : {}),
    clientMode,
    deliveryKind,
    ...(stringMeta("trace_id")
      ? {
          trace: {
            traceId: stringMeta("trace_id"),
            ...(stringMeta("span_id") ? { spanId: stringMeta("span_id") } : {}),
            ...(stringMeta("parent_span_id")
              ? { parentSpanId: stringMeta("parent_span_id") }
              : {}),
          },
        }
      : {}),
  };
}

async function sendCuaBrokerRequest(
  broker: NodeReplCuaBrokerConnection,
  request: { method: string; input: unknown; context: Record<string, unknown> },
  signal: AbortSignal,
): Promise<{ result: CallToolResult; responseMeta?: Record<string, unknown> }> {
  const id = randomUUID();
  return await new Promise((resolve, reject) => {
    const socket = createConnection(broker.socketPath);
    let buffer = "";
    let settled = false;
    const finish = (error?: unknown, value?: { result: CallToolResult; responseMeta?: Record<string, unknown> }) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      socket.destroy();
      if (error) reject(error);
      else if (value) resolve(value);
      else reject(new Error("Computer Use broker returned no response"));
    };
    const onAbort = () => finish(signal.reason ?? new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id, token: broker.token, ...request })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > MAX_RESPONSE_BYTES) {
        finish(new Error("Computer Use broker response exceeded the 32 MiB limit"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const payload = JSON.parse(buffer.slice(0, newline)) as {
          id?: unknown;
          ok?: unknown;
          error?: unknown;
          result?: CallToolResult;
          responseMeta?: Record<string, unknown>;
        };
        if (payload.id !== id) throw new Error("Computer Use broker response id mismatch");
        if (payload.ok !== true) throw new Error(typeof payload.error === "string" ? payload.error : "Computer Use broker failed");
        if (!payload.result) throw new Error("Computer Use broker returned no result");
        finish(undefined, { result: payload.result, responseMeta: payload.responseMeta });
      } catch (error) {
        finish(error);
      }
    });
    socket.once("error", finish);
    socket.once("close", () => {
      if (!settled) finish(new Error("Computer Use broker closed before returning a response"));
    });
    if (signal.aborted) onAbort();
  });
}
