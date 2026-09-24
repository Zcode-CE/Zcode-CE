import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hydrateReadFileStateFromSession } from "../src/agent/read-file-state-hydrator.js";
import { createReadFileStateMetadataFromEntry } from "../src/tool/read-file-state-metadata.js";
import { createReadFileStateKey } from "../src/tool/read-file-state.js";
import type { ReadFileStateMap } from "../src/tool/types.js";

/**
 * resume 后草稿的 read-state 必须回来（上游 3.14.3 的 C5 第二半）。
 *
 * 为什么单独钉这一条：草稿的 read-state 只活在内存里，会话恢复时**只从 tool part 的
 * metadata 重建**（hydrator）。不落 metadata 或 hydrator 不认这两个工具名时，内存态看着是
 * 对的、当次会话也确实是好的 —— 只有 resume 之后同一个 FILE_NOT_READ 原样回来。
 * 这是典型的「当次验证全绿、恢复后失效」，只能靠直接跑 hydrator 抓到。
 *
 * 运行：cd apps/zcode-cli/packages/core && node --import tsx --test test/workflowDraftReadStateResume.test.ts
 */

const SOURCE = "export const stages = [];\n";

function draftMetadata(toolName: "CreateWorkflow" | "AmendWorkflow", path: string) {
  const entry = {
    content: SOURCE,
    isPartialView: false,
    // mtimeMs 是必需的：createReadFileStateMetadataFromEntry 对缺 freshness metadata 的
    // 历史状态显式返回 undefined（不能拿没有时间戳的状态冒充已读，否则会放过 stale 写入）。
    mtimeMs: 1_700_000_000_000,
    path,
    readAt: new Date(1_700_000_000_000),
    revisionId: "rev_1",
    sizeBytes: SOURCE.length,
    sourceTool: toolName,
  };
  return createReadFileStateMetadataFromEntry({
    completedAt: entry.readAt,
    entry,
    toolName,
  });
}

async function hydrate(toolName: "CreateWorkflow" | "AmendWorkflow", path: string) {
  const dir = mkdtempSync(join(tmpdir(), "zcode-draft-resume-"));
  try {
    const readFileState: ReadFileStateMap = new Map();
    const result = await hydrateReadFileStateFromSession({
      messages: [
        {
          info: { id: "msg_1", role: "assistant" },
          parts: [
            {
              // dedupeParts 按 part.id 去重：没有 id 的 part 会全部塌成一个，测试就测不到东西。
              id: "part_" + toolName,
              // 生产链路上 metadata 是包在 { readFileState } 里落到 tool part 上的
              // （runtime/methods/tool-part-metadata.ts），hydrator 也只认这个形状。
              state: {
                metadata: { readFileState: draftMetadata(toolName, path) },
                output: {},
                status: "completed",
              },
              tool: toolName,
              type: "tool",
            },
          ],
        },
      ],
      readFileState,
      workingDirectory: dir,
      workspaceRoot: dir,
    } as never);
    return { readFileState, result };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("CreateWorkflow 的草稿在 resume 后回到 read-state", async () => {
  const path = join(tmpdir(), "draft-resume.workflow.ts");
  const { readFileState, result } = await hydrate("CreateWorkflow", path);
  assert.equal(result.restoredCount, 1, "resume 必须恢复草稿的 read-state");
  const entry = readFileState.get(createReadFileStateKey(path, 1, undefined));
  assert.notEqual(entry, undefined, "恢复出来的键必须与写入侧同一个口径");
  assert.equal(entry?.sourceTool, "CreateWorkflow");
  assert.equal(entry?.content, SOURCE);
});

test("AmendWorkflow 的草稿同理", async () => {
  const path = join(tmpdir(), "draft-resume-amend.workflow.ts");
  const { readFileState, result } = await hydrate("AmendWorkflow", path);
  assert.equal(result.restoredCount, 1);
  assert.equal(
    readFileState.get(createReadFileStateKey(path, 1, undefined))?.sourceTool,
    "AmendWorkflow",
  );
});
