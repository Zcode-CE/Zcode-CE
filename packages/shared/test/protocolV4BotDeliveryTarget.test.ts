import assert from "node:assert/strict";
import test from "node:test";
import { parseCommandEnvelope } from "@zcode/shared/zcode-protocol-v4";

/**
 * 协议 v4 sendText 的 botDeliveryTarget 键（additive 可选）契约测试。
 *
 * 为什么这一层需要单独钉住 —— 两个各自都会静默的失效方向：
 *
 *   1. 键被删掉。zod 的 z.object 对未知键是「剥离」而不是「拒绝」（本文件对照②实测：
 *      同一路径喂一个未声明的键，解析成功且该键消失）。所以只断言 safeParse 成功
 *      完全没有牙齿：键删掉之后照样成功。判据必须落在「值是否活着穿过这一层」。
 *   2. 键被当成必填。老发送端不带它，一旦变成必填，整条 sendText 被拒 ——
 *      表现为用户输入发不出去，而对端重投的是同一批字节。
 *
 * 判据落在真实入口：parseCommandEnvelope 是 v4 网关与 CommandInbox 校验 payload 的
 * 唯一收口（v4-gateway.ts:2389/2401、command-inbox.ts:118）。停在内层 schema.safeParse
 * 只能证明一半 —— 信封层的类型判别与 CAS 检查同样在这条路径上。
 *
 * 运行：cd packages/shared && node --import tsx --test test/protocolV4BotDeliveryTarget.test.ts
 */

/** 一条合法回推地址：定时任务完成后 Bot 回推用的稳定会话地址。 */
const DELIVERY_TARGET = {
  provider: "feishu",
  botId: "bot-1",
  providerUserId: "user-1",
  chatType: "private",
} as const;

/** 一封 sendText 信封；payload 由调用方给。 */
function sendTextEnvelope(payload: Record<string, unknown>) {
  return {
    commandId: "c-1",
    clientId: "client-1",
    sessionId: "s-1",
    type: "sendText",
    payload,
    issuedAt: 1,
  };
}

test("① 事实：带 botDeliveryTarget 的 sendText 载荷被接受，且该值活着穿过 admission", () => {
  const parsed = parseCommandEnvelope(
    sendTextEnvelope({ text: "hi", botDeliveryTarget: DELIVERY_TARGET }),
  );
  assert.equal(parsed.ok, true, "带该键的载荷必须被接受");
  // 关键断言：不是「接受了就算」——值必须原样保留。键被删掉时这里变红，
  // 因为 z.object 会把未声明的键静默剥掉（见对照②）。
  assert.deepEqual(
    parsed.ok ? parsed.envelope.payload.botDeliveryTarget : undefined,
    DELIVERY_TARGET,
    "该键必须作为已声明字段被保留，而不是被剥离",
  );
  assert.equal(parsed.ok && parsed.envelope.payload.text, "hi", "其余字段一个不少");
});

test("② 对照：同一路径会剥离未声明的键 —— 证明 ① 的保留不是自动的", () => {
  const parsed = parseCommandEnvelope(
    sendTextEnvelope({ text: "hi", notADeclaredField: DELIVERY_TARGET }),
  );
  assert.equal(parsed.ok, true, "未知键不拒收（z.object 是剥离语义）");
  assert.equal(
    parsed.ok && "notADeclaredField" in parsed.envelope.payload,
    false,
    "未知键必须消失：若这里为 true，说明该 schema 已改成 passthrough，① 的判据随之失效",
  );
});

test("③ 事实：不带 botDeliveryTarget 的 sendText 照旧被接受（additive 可选，老发送端不受影响）", () => {
  const parsed = parseCommandEnvelope(sendTextEnvelope({ text: "hi" }));
  assert.equal(parsed.ok, true, "缺省该键不得让整条载荷失败");
  assert.equal(
    parsed.ok && parsed.envelope.payload.botDeliveryTarget,
    undefined,
    "缺省 = 该字段缺席，不得补默认值",
  );
  assert.equal(parsed.ok && parsed.envelope.payload.text, "hi");
});

test("④ 事实：该键的取值域仍然硬拒 —— 不是 passthrough 的口子", () => {
  // provider 不在闭集里。
  const badProvider = parseCommandEnvelope(
    sendTextEnvelope({
      text: "hi",
      botDeliveryTarget: { ...DELIVERY_TARGET, provider: "not-a-provider" },
    }),
  );
  assert.equal(badProvider.ok, false, "非法 provider 必须拒收");
  // 必填项缺失（botId 为空串，被 .min(1) 拦下）。
  const emptyBotId = parseCommandEnvelope(
    sendTextEnvelope({ text: "hi", botDeliveryTarget: { ...DELIVERY_TARGET, botId: "" } }),
  );
  assert.equal(emptyBotId.ok, false, "空 botId 必须拒收");
  // strict：多带一个键也要拒（该 schema 是 .strict()）。
  const extraKey = parseCommandEnvelope(
    sendTextEnvelope({
      text: "hi",
      botDeliveryTarget: { ...DELIVERY_TARGET, unexpected: 1 },
    }),
  );
  assert.equal(extraKey.ok, false, "该 schema 是 .strict()，多余键必须拒收");
});

test("⑤ 事实：该键与既有的 automationId 共存，且不触发互斥校验", () => {
  // superRefine 只对 automationId/offPeakTaskId、offPeakRunType、modelExecution 三组互斥，
  // botDeliveryTarget 不属于任何一组 —— 定时任务会话会同时带 automationId 与回推地址。
  const parsed = parseCommandEnvelope(
    sendTextEnvelope({
      text: "hi",
      automationId: "a-1",
      botDeliveryTarget: DELIVERY_TARGET,
    }),
  );
  assert.equal(parsed.ok, true, "automationId + botDeliveryTarget 必须共存");
  assert.deepEqual(
    parsed.ok ? parsed.envelope.payload.botDeliveryTarget : undefined,
    DELIVERY_TARGET,
  );
  assert.equal(parsed.ok && parsed.envelope.payload.automationId, "a-1");
});
