import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EditErrorCode } from "@zcode/contracts";
import { editToolEntry } from "../src/tool/handlers/edit.js";
import { recordAuthoredWorkflowDraft } from "../src/tool/handlers/workflow-draft-read-state.js";
import type { ReadFileStateMap, ToolExecutionContext } from "../src/tool/types.js";

/**
 * 内联草稿记作「模型写过的文件」（上游 3.14.3 的 C5）。
 *
 * 为什么必须有这一条：Edit / Write 拒绝会话没读过的文件（FILE_NOT_READ）。内联草稿的字节
 * 就是产生它的那次调用的 script 入参 —— 不记这一笔，NOTE 要求的第一次 Edit 必然失败，
 * 补救是把模型自己刚写的两万 token 脚本整个 Read 一遍，正是草稿文件要省掉的那笔开销。
 *
 * 断言打在最终消费点：不是「readFileState 里多了一个键」，而是**真实的 Edit handler
 * 对这份草稿的判定结果**（修复前 FILE_NOT_READ，修复后通过）。
 *
 * 运行：cd apps/zcode-cli/packages/core && node --import tsx --test test/workflowDraftReadState.test.ts
 */

const SOURCE = [
  "export const stages = [",
  "  { name: 'scan', task: 'scan the repo' },",
  "];",
  "",
].join("\n");

function makeWorkspace(): { dir: string; draftPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "zcode-draft-read-state-"));
  const draftPath = join(dir, "draft.workflow.ts");
  writeFileSync(draftPath, SOURCE, "utf8");
  return { dir, draftPath };
}

function makeContext(input: {
  readFileState: ReadFileStateMap;
  dir: string;
  recorded: unknown[];
}): ToolExecutionContext {
  return {
    abortSignal: new AbortController().signal,
    recordReadFileStateMetadata: (metadata: unknown) => {
      input.recorded.push(metadata);
    },
    readFileState: input.readFileState,
    toolCallId: "call_probe",
    traceId: "trace_probe" as never,
    workingDirectory: input.dir,
    workspaceRoot: input.dir,
    fileSystemPort: {
      readTextFile: async () => ({
        content: SOURCE,
        revision: { id: "rev_1", mtimeMs: 1_000, sizeBytes: SOURCE.length },
      }),
      stat: async () => ({ revision: { id: "rev_1", mtimeMs: 1_000, sizeBytes: SOURCE.length } }),
      writeTextFile: async () => ({
        revision: { id: "rev_2", mtimeMs: 2_000, sizeBytes: SOURCE.length },
      }),
    },
  } as unknown as ToolExecutionContext;
}

async function runEdit(
  context: ToolExecutionContext,
  draftPath: string,
): Promise<{ ok: boolean; errorCode?: string }> {
  const handler = editToolEntry.handler;
  assert.notEqual(handler, undefined, "Edit handler 缺席，测试已与实现脱节");
  const result = (await handler!(
    { file_path: draftPath, old_string: "scan the repo", new_string: "scan the repo twice" },
    context,
  )) as Record<string, unknown>;
  // 成功与失败是两种形状：失败带 errorCode，成功带 output。这里把两者都读出来，
  // 断言才不会因为「读错了字段」而假装通过。
  const errorCode = result.errorCode ?? (result.error as { code?: unknown } | undefined)?.code;
  return { ok: errorCode === undefined, errorCode: errorCode as string | number | undefined };
}

test("不记这一笔 ⇒ Edit 被 FILE_NOT_READ 拒（这就是修复前用户付的那笔代价）", async () => {
  const { dir, draftPath } = makeWorkspace();
  try {
    const context = makeContext({ dir, readFileState: new Map(), recorded: [] });
    const result = await runEdit(context, draftPath);
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, EditErrorCode.FILE_NOT_READ);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("记了这一笔 ⇒ 同一个 Edit 通过（且写进了 resume 用的 metadata）", async () => {
  const { dir, draftPath } = makeWorkspace();
  try {
    const readFileState: ReadFileStateMap = new Map();
    const recorded: unknown[] = [];
    const context = makeContext({ dir, readFileState, recorded });

    await recordAuthoredWorkflowDraft(context, {
      path: draftPath,
      source: SOURCE,
      toolName: "CreateWorkflow",
    });

    assert.equal(readFileState.size, 1, "草稿必须进 readFileState");
    assert.equal([...readFileState.values()][0]?.sourceTool, "CreateWorkflow");
    // resume 只从 tool part metadata 恢复 read-state，不落这一笔会话恢复后同一个 bug 原样回来。
    assert.equal(recorded.length, 1, "必须同时落 metadata，否则 resume 后失效");

    const result = await runEdit(context, draftPath);
    assert.equal(
      result.ok,
      true,
      "记录之后同一个 Edit 必须通过（errorCode=" + String(result.errorCode) + "）",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("尽力而为：stat 失败不记，也不抛（退回「先 Read」的老路）", async () => {
  const { dir, draftPath } = makeWorkspace();
  try {
    const readFileState: ReadFileStateMap = new Map();
    const recorded: unknown[] = [];
    const context = makeContext({ dir, readFileState, recorded });
    (context as { fileSystemPort?: unknown }).fileSystemPort = {
      stat: async () => {
        throw new Error("stat unavailable");
      },
    };

    await recordAuthoredWorkflowDraft(context, {
      path: draftPath,
      source: SOURCE,
      toolName: "CreateWorkflow",
    });

    assert.equal(readFileState.size, 0);
    assert.equal(recorded.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
