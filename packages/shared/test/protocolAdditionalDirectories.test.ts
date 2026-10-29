import assert from "node:assert/strict";
import test from "node:test";
import {
  zcodeSessionCreateParamsSchema,
  zcodeSessionResumeParamsSchema,
  zcodeSessionRuntimePreferencesResultSchema,
} from "../src/zcode-protocol/index.js";
import {
  commandPayloadSchemas,
  v4ConversationSubscribeParamsSchema,
} from "@zcode/shared/zcode-protocol-v4";

/**
 * 上游 3.16.2 X16（附加目录进对话上下文）/ Y19（重启恢复不丢子目录）的 wire 契约。
 *
 * 三条断言原则：
 * 1. 可选：旧客户端 / 旧 Host / 旧快照不携带该键必须照旧解析通过（additive）。
 * 2. 不伪造默认：runtime preferences 缺键时结果是 undefined，不是 `[]`——
 *    `[]` 会变成「Host 已解析且结果为空」的事实，掩盖「旧 Host 根本没这个概念」。
 * 3. 有界：>256 条与空字符串在协议边界拒绝（路径安全第一道闸，第二道在 CLI 归一）。
 */

const DIRS = ["/work/backend", "/work/shared"];
const WORKSPACE = { workspaceKey: "/work/app", workspacePath: "/work/app" };

test("legacy session/create：缺席即无附加目录，携带则原样保留", () => {
  const without = zcodeSessionCreateParamsSchema.parse({ workspace: WORKSPACE });
  assert.equal(without.additionalDirectories, undefined);
  assert.equal(Object.hasOwn(without, "additionalDirectories"), false);

  const withDirs = zcodeSessionCreateParamsSchema.parse({
    additionalDirectories: DIRS,
    workspace: WORKSPACE,
  });
  assert.deepEqual(withDirs.additionalDirectories, DIRS);
});

test("legacy session/resume：同语义（冷恢复靠它把范围带回来）", () => {
  const without = zcodeSessionResumeParamsSchema.parse({ sessionId: "s1" });
  assert.equal(without.additionalDirectories, undefined);

  const withDirs = zcodeSessionResumeParamsSchema.parse({
    sessionId: "s1",
    additionalDirectories: DIRS,
  });
  assert.deepEqual(withDirs.additionalDirectories, DIRS);
});

test("runtime preferences：缺键保持 undefined，不回填空数组", () => {
  const without = zcodeSessionRuntimePreferencesResultSchema.parse({
    nativeSearchEnhancementsEnabled: true,
  });
  assert.equal(without.additionalDirectories, undefined);

  const withDirs = zcodeSessionRuntimePreferencesResultSchema.parse({
    additionalDirectories: DIRS,
    nativeSearchEnhancementsEnabled: true,
  });
  assert.deepEqual(withDirs.additionalDirectories, DIRS);
});

test("v4 createSession payload：与 legacy create 等价透传", () => {
  const parsed = commandPayloadSchemas.createSession.parse({
    additionalDirectories: DIRS,
    workspaceId: "/work/app",
  });
  assert.deepEqual(parsed.additionalDirectories, DIRS);

  const without = commandPayloadSchemas.createSession.parse({ workspaceId: "/work/app" });
  assert.equal(without.additionalDirectories, undefined);
});

test("v4 subscribe：冷恢复 hint 会被 trim，缺席不报错", () => {
  const parsed = v4ConversationSubscribeParamsSchema.parse({
    additionalDirectories: ["  /work/backend  "],
    clientMode: "desktop-continuous",
    connectionId: "c1",
    topic: "conversation/s1",
  });
  assert.deepEqual(parsed.additionalDirectories, ["/work/backend"]);

  const without = v4ConversationSubscribeParamsSchema.parse({
    clientMode: "desktop-continuous",
    connectionId: "c1",
    topic: "conversation/s1",
  });
  assert.equal(without.additionalDirectories, undefined);
});

test("有界：>256 条与空字符串在协议边界拒绝", () => {
  const tooMany = Array.from({ length: 257 }, (_, index) => `/dir/${index}`);
  for (const schema of [
    (value: unknown) =>
      zcodeSessionCreateParamsSchema.parse({ additionalDirectories: value, workspace: WORKSPACE }),
    (value: unknown) =>
      zcodeSessionResumeParamsSchema.parse({ additionalDirectories: value, sessionId: "s" }),
  ]) {
    assert.throws(() => schema(tooMany), "超限必须拒绝");
    assert.throws(() => schema([""]), "空字符串必须拒绝");
    assert.throws(() => schema("not-an-array"), "非数组必须拒绝");
  }
});
