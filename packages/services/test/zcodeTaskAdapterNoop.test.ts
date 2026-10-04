import assert from "node:assert/strict";
import test from "node:test";
import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";
import { createZCodeTaskServiceAdapter } from "../src/zcode-agent/zcodeTaskServiceAdapter.js";

/**
 * resolveInteraction 的 noop 收口语义（133-im-bot-approval-loop B3）。
 *
 * 背景：CLI 侧 resolveInteraction 是「先到先得，晚到 noop」（interaction-registry）。
 * 修复前 adapter 的 respondPermission / respondElicitation 把 noop 也当成功返回 true，
 * Bot 侧于是回复「已提交 / 已允许」——但本次提交并未生效（别端或自动裁决先收口了），
 * 用户被误导以为自己刚点的选择生效了。
 *
 * 修复后：noop 不抛错（是多端并发应答的正常幂等语义），但返回 false，Bot 侧
 * 据此回复「该权限 / 问答已处理」。本测试直接钉 adapter 边界的返回值。
 *
 * 运行：cd packages/services && node --import tsx --test test/zcodeTaskAdapterNoop.test.ts
 */

function makeAck(status: CommandAck["status"]): CommandAck {
  return { commandId: "cmd-1", status, revisionAtDecision: 1 };
}

function makeAdapter(ack: CommandAck) {
  const calls: string[] = [];
  const service = createZCodeTaskServiceAdapter({
    zcodeAgentService: {
      sendConversationCommandV4: async () => {
        calls.push("sent");
        return ack;
      },
    } as never,
    // 构造期会订阅 sessions-index 的 terminal / ready 事件（会话终态收口），
    // 这里给空订阅 + 空 dispose，respondPermission / respondElicitation 不触发它们。
    taskIndexSyncer: {
      onSessionTerminalEvent: () => ({ dispose: () => undefined }),
      onSessionReadyEvent: () => ({ dispose: () => undefined }),
    } as never,
  });
  return { service, calls };
}

test("respondPermission：noop ⇒ 返回 false（本次提交未生效，Bot 应回复「已处理」）", async () => {
  const { service, calls } = makeAdapter(makeAck("noop"));
  const submitted = await service.respondPermission({
    taskId: "task-1",
    workspacePath: "/tmp/workspace",
    requestId: "req-1",
    optionId: "allow",
    response: { decision: "allow" } as never,
  });
  assert.equal(calls.length, 1, "命令必须真实发出一次");
  assert.equal(submitted, false, "noop 表示 interaction 已被别端收口，不得当作已提交");
});

test("respondPermission：accepted ⇒ 返回 true（正常成功路径不变）", async () => {
  const { service } = makeAdapter(makeAck("accepted"));
  const submitted = await service.respondPermission({
    taskId: "task-1",
    workspacePath: "/tmp/workspace",
    requestId: "req-1",
    optionId: "allow",
    response: { decision: "allow" } as never,
  });
  assert.equal(submitted, true);
});

test("respondElicitation：noop ⇒ 返回 false（且不投递 replayable 应答事件）", async () => {
  const { service, calls } = makeAdapter(makeAck("noop"));
  const submitted = await service.respondElicitation({
    taskId: "task-1",
    workspacePath: "/tmp/workspace",
    requestId: "req-2",
    action: "accept",
  });
  assert.equal(calls.length, 1, "命令必须真实发出一次");
  assert.equal(submitted, false, "noop 时本次应答未生效，不得当作已提交");
});

test("respondElicitation：accepted ⇒ 返回 true（正常成功路径不变）", async () => {
  const { service } = makeAdapter(makeAck("accepted"));
  const submitted = await service.respondElicitation({
    taskId: "task-1",
    workspacePath: "/tmp/workspace",
    requestId: "req-2",
    action: "accept",
  });
  assert.equal(submitted, true);
});
