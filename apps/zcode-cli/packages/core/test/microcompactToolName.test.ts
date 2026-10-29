import assert from "node:assert/strict";
import test from "node:test";
import {
  MICROCOMPACT_CLEARED_TOOL_RESULT_PREFIX,
  maybeLocalMicrocompactMessages,
  type LocalMicrocompactMessage,
} from "../src/compact/microcompact.js";

/**
 * X3：tool result 自身没有 toolName 时，候选分类必须能读到权威目标身份。
 *
 * 回归形态是静默的：压缩报告「没有候选」，长会话在上下文上限附近继续无响应。
 * 这里用最小消息序列验证「解析器给白名单名字 ⇒ 成为候选并被清理」。
 */

function textContent(text: string): LocalMicrocompactMessage["content"] {
  return [{ type: "text", text }] as LocalMicrocompactMessage["content"];
}

function buildMessages(): LocalMicrocompactMessage[] {
  return [
    {
      role: "assistant",
      content: textContent("running"),
      toolCalls: [{ id: "call-1", name: "Bash", input: {} }],
    },
    { role: "tool", toolCallId: "call-1", content: textContent("x".repeat(4000)) },
    {
      role: "assistant",
      content: textContent("running"),
      toolCalls: [{ id: "call-2", name: "Bash", input: {} }],
    },
    { role: "tool", toolCallId: "call-2", content: textContent("y".repeat(4000)) },
  ];
}

const CONFIG = {
  thresholdTokens: 1,
  keepRecentToolResults: 1,
  compactableToolNames: ["Bash"],
  minTokenSavings: 1,
} as const;

test("解析器给出白名单名字时，缺 toolName 的 tool result 成为可清理候选", () => {
  const result = maybeLocalMicrocompactMessages({
    config: CONFIG,
    messages: buildMessages(),
    resolveToolResultName: () => "Bash",
  });
  assert.equal(result.decision.reason, "applied");
  assert.ok(JSON.stringify(result.messages).includes(MICROCOMPACT_CLEARED_TOOL_RESULT_PREFIX));
});

test("没有解析器时保持既有行为（no_candidates）", () => {
  const result = maybeLocalMicrocompactMessages({ config: CONFIG, messages: buildMessages() });
  assert.equal(result.decision.reason, "no_candidates");
});

test("解析器给出非白名单名字时不清", () => {
  const result = maybeLocalMicrocompactMessages({
    config: CONFIG,
    messages: buildMessages(),
    resolveToolResultName: () => "Read",
  });
  assert.equal(result.decision.reason, "no_candidates");
});