import assert from "node:assert/strict";
import test from "node:test";
import { zcodeTurnStartedEventPayloadSchema } from "../src/zcode-protocol/index.js";

/**
 * B-1f（3.17.2 移植）：`turn.started` 必须声明 CLI 已经在写的那三个归因字段。
 *
 * 为什么必须钉住：CLI 的 `core/src/runtime/methods/turn.ts` 会把 Host 准入的后台执行归因写进
 * `turn.started`（`automationId`，或 `offPeakTaskId` + `offPeakRunType`）；这张 schema 是 `.strict()`，
 * 漏声明时整个 payload 校验失败，按会话事件信封解析的消费方会丢弃整条开始事件——复用中的
 * Bot 私聊订阅因此无法切换到新轮次。上游 3.17.2 的注释记录了同一次修复。
 *
 * 运行：cd packages/shared && node --import tsx --test test/protocolTurnStartedAttribution.test.ts
 */

const BASE = { turnNumber: 1, input: "hello" };

test("automation 归因：与 CLI 写入形状一致时原样保留", () => {
  const parsed = zcodeTurnStartedEventPayloadSchema.parse({
    ...BASE,
    automationId: "automation_fixture",
  });
  assert.equal(parsed.automationId, "automation_fixture");
});

test("闲时任务归因：offPeakTaskId 与 init/resume 两档都接受", () => {
  for (const offPeakRunType of ["init", "resume"] as const) {
    const parsed = zcodeTurnStartedEventPayloadSchema.parse({
      ...BASE,
      offPeakRunType,
      offPeakTaskId: "offpeak_fixture",
    });
    assert.equal(parsed.offPeakTaskId, "offpeak_fixture");
    assert.equal(parsed.offPeakRunType, offPeakRunType);
  }
});

test("缺席即无归因：旧 CLI 不带这三个键照旧解析通过", () => {
  const parsed = zcodeTurnStartedEventPayloadSchema.parse(BASE);
  assert.equal(Object.hasOwn(parsed, "automationId"), false);
  assert.equal(Object.hasOwn(parsed, "offPeakTaskId"), false);
});

test("schema 仍是 strict：未声明的字段照旧被拒（修复不是放宽）", () => {
  assert.throws(
    () => zcodeTurnStartedEventPayloadSchema.parse({ ...BASE, unexpectedField: 1 }),
    /unrecognized|Unrecognized/i,
  );
});
