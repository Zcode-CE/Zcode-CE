import assert from "node:assert/strict";
import test from "node:test";
import { createCommandCenter } from "../src/command-center/create.js";
import { parseSlashCommand } from "../src/command-center/slash-commands.js";

/**
 * `/workflow` 的路由：它是 bootstrap 展开的内置 prompt 命令，不是命令中心命令。
 *
 * 为什么必须钉住（上游 3.14.3 的 11+8 行，序 10 的一部分）：
 * - 缺 `parseSlashCommand` 的 workflow 分支时，`/workflow` 被判成 unknown，headless 会走
 *   命令中心回一句「Unknown command」（可用命令表里却列着它）；
 * - 只补那一处、不补命令中心的分支时，TUI 侧更糟：known 但没有对应分支，会一路落到
 *   文件末尾的 resume 兜底 —— `/workflow 数一下 md 文件` 变成「尝试恢复一个叫这个的会话」。
 *   两处是配套的，缺任一处都是用户可见的错。
 *
 * 运行：cd apps/zcode-cli/packages/cli && node --import tsx --test test/workflowCommandRouting.test.ts
 */

test("parseSlashCommand 把 /workflow 认成 known（不是 unknown）", () => {
  const parsed = parseSlashCommand("/workflow 数一下 md 文件");
  assert.equal(parsed?.type, "known");
  assert.equal(parsed?.name, "workflow");
  assert.equal(parsed?.args, "数一下 md 文件");
  // 无参数形式也必须认。
  assert.equal(parseSlashCommand("/workflow")?.name, "workflow");
});

test("命令中心把 /workflow 原文交给 submitPrompt，而不是落进 resume 兜底", async () => {
  let submitted: string | undefined;
  let resumeTouched = false;
  const center = createCommandCenter({
    getApp: async () =>
      ({
        sessionId: "sess_probe",
        submitPrompt: async (text: string) => {
          submitted = text;
          return { response: "ok" };
        },
      }) as never,
    getMode: () => "yolo",
    listCustomCommands: async () => [],
    resumeApp: async () => {
      resumeTouched = true;
      throw new Error("resumeApp must not be reached for /workflow");
    },
  } as never);

  await center("/workflow 数一下 md 文件", {} as never);

  assert.equal(resumeTouched, false, "/workflow 不得落进 resume 兜底");
  assert.equal(
    submitted,
    "/workflow 数一下 md 文件",
    "原文必须原样交给 submitPrompt（展开在 bootstrap 侧）",
  );
});
