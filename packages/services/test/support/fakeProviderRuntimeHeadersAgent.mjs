#!/usr/bin/env node
/**
 * 极简 ZCode Protocol app-server 假实现（stdio，LF 分帧，与
 * packages/services/src/zcode-agent/zcodeStdioTransport.ts 的 framing 同口径）。
 *
 * 为什么必须有它：本批缺陷（spec §4.2/§4.3）发生在 host 的
 * `interaction/requestProviderRuntimeHeaders` 入站请求处理与渲染层应答合并上，
 * 而不是某个纯函数里。只测「合并白名单」这种纯逻辑会漏掉最可能的回归 ——
 * 守卫写反、pending key 对不上、应答入口根本没接上。所以测试必须让 host 真的跑一遍
 * spawn → wire → 反向请求 → 应答 的完整链路。
 *
 * 它只实现测试需要的最小面：
 *   1. 应答 `session/subscribe`（host 建立旧协议订阅面的必经步骤）；
 *   2. 主动发起 `interaction/requestProviderRuntimeHeaders`（模拟 agent 在模型请求前取头）；
 *   3. 把收到的应答逐行 JSON 追加写到 `FAKE_AGENT_OUT`，供测试断言。
 *
 * 行为由 env 驱动（全部经 command.env 注入，不依赖继承的进程环境）：
 *   FAKE_AGENT_OUT          应答落盘路径（必填，否则只跑不断言）
 *   FAKE_AGENT_MODE         `start-plan` | `individual`（决定 accountAccess.mode）
 *   FAKE_AGENT_REQUEST_ID   业务 requestId
 *   FAKE_AGENT_SESSION_ID   会话 id
 *   FAKE_AGENT_WORKSPACE    workspace 路径
 *   FAKE_AGENT_AUTO_REQUEST `1` = 启动后立刻发请求，不等 session/subscribe。
 *                           用于验证「无订阅者 ⇒ 快速失败」（spec §4.4）：
 *                           默认行为要等订阅，就永远测不到无订阅者那条分支。
 */
import { appendFileSync, readFileSync } from "node:fs";

const outPath = process.env.FAKE_AGENT_OUT;
const mode = process.env.FAKE_AGENT_MODE ?? "start-plan";
const requestId = process.env.FAKE_AGENT_REQUEST_ID ?? "req-1";
const sessionId = process.env.FAKE_AGENT_SESSION_ID ?? "sess-1";
const workspacePath = process.env.FAKE_AGENT_WORKSPACE ?? process.cwd();
const autoRequest = process.env.FAKE_AGENT_AUTO_REQUEST === "1";
const triggerFile = process.env.FAKE_AGENT_TRIGGER_FILE;
/** 触发文件第二行可覆盖 mode（用于同一进程内切换 accountAccess.mode 的用例）。 */
let modeOverride = "";

const PROVIDER_ID = "zai-start-plan";
const MODEL_ID = "glm-5";

/** 假 agent 自己发出的反向请求的 protocol id（host 用它回 result）。 */
const HEADERS_PROTOCOL_ID = "fake-agent-provider-runtime-headers-1";

function record(entry) {
  if (!outPath) return;
  appendFileSync(outPath, `${JSON.stringify(entry)}\n`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function accountAccess() {
  if ((modeOverride || mode) === "start-plan") {
    return { type: "zhipu-account", accountType: "zai", mode: "start-plan", entitled: true };
  }
  return {
    type: "zhipu-account",
    accountType: "zai",
    mode: "individual-coding-plan",
    entitled: true,
  };
}

/**
 * 已发出的 protocol id 集合：一次进程内可能发多个请求（触发文件驱动），
 * 每个请求必须有独立 id，否则 host 的响应会串到同一个 pending 上。
 */
const outstandingProtocolIds = new Set();

function requestRuntimeHeaders(requestIdOverride) {
  const protocolId = `${HEADERS_PROTOCOL_ID}-${outstandingProtocolIds.size}`;
  outstandingProtocolIds.add(protocolId);
  send({
    id: protocolId,
    method: "interaction/requestProviderRuntimeHeaders",
    params: {
      requestId: requestIdOverride ?? requestId,
      sessionId,
      workspace: { workspacePath, workspaceKey: workspacePath },
      modelSelection: { providerId: PROVIDER_ID, modelId: MODEL_ID },
      providerId: PROVIDER_ID,
      accountAccess: accountAccess(),
      reason: "model-request",
    },
  });
}

function handle(message) {
  if (typeof message !== "object" || message === null) return;

  // host 对反向请求的应答：{ id: <protocolId>, result | error }
  if (typeof message.id === "string" && outstandingProtocolIds.has(message.id)) {
    record(
      "error" in message
        ? { kind: "error", error: message.error }
        : { kind: "result", result: message.result },
    );
    return;
  }

  if (typeof message.method !== "string" || message.id === undefined) return;

  if (message.method === "session/subscribe") {
    send({
      id: message.id,
      result: { sessionId, eventSeq: 0, events: [] },
    });
    // 订阅建立后立刻取头：这正是 agent 在模型请求前的真实时序。
    requestRuntimeHeaders();
    return;
  }

  // 其余方法一律回 -32601（host 对未实现方法有既有降级路径），
  // 但显式记录，避免测试悄悄依赖一个我们没意识到的调用。
  record({ kind: "unhandled-method", method: message.method });
  send({
    id: message.id,
    error: { code: -32601, message: `fake agent: method not found: ${message.method}` },
  });
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim()) {
      try {
        handle(JSON.parse(line));
      } catch (error) {
        record({ kind: "parse-error", message: String(error) });
      }
    }
    index = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(0));

if (autoRequest) {
  // 不等 session/subscribe：模拟「host 侧没有任何会话事件订阅者」的场景。
  // 必须等 stdin 就绪（host 的 wire 已建立）再发，否则请求会丢在 host 未接线之前。
  setImmediate(() => requestRuntimeHeaders());
}

if (triggerFile) {
  // 由测试驱动的确定性触发：文件出现后发一个指定 requestId 的请求。
  //
  // 为什么不用定时器：本组用例要区分「有订阅者」与「订阅者已 dispose」两个时刻，
  // 定时器会让断言依赖 sleep 时长而 flaky；文件触发把「何时发」交给测试显式控制。
  // 为什么不用「等 host 发消息」：无订阅者场景下 host 初始不会向 agent 发任何帧，
  // 没有可同步的入站消息。
  let lastToken = "";
  const timer = setInterval(() => {
    let raw;
    try {
      raw = readFileSync(triggerFile, "utf8").trim();
    } catch {
      return;
    }
    if (!raw || raw === lastToken) return;
    lastToken = raw;
    const [nextRequestId, nextMode] = raw.split("\n");
    if (nextMode) modeOverride = nextMode.trim();
    requestRuntimeHeaders(nextRequestId?.trim() || undefined);
  }, 20);
  timer.unref?.();
}
