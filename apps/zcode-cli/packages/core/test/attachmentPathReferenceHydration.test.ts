import assert from "node:assert/strict";
import test from "node:test";
import type { FilePart } from "@zcode/contracts";
import { filePartToContentBlock } from "../src/agent/file-part-hydration.js";

/**
 * 冷恢复必须还原「按本地路径引用」的说明原文（上游 3.16.2 X4）。
 *
 * 缺陷形态：原说明只存在于 contentBlock 里，持久化时没存；恢复时重新按 local_ref 降级，
 * 降级原因与读取提示可能变样甚至丢失 ⇒ 模型看到的历史前缀与首次请求不同，附件错乱。
 * 修法：写路径引用时把原文存进 metadata.pathReferenceText，恢复时优先还原它。
 *
 * 断言打在最终消费点：filePartToContentBlock 是冷恢复生成模型消息内容的入口。
 */

const PATH_REFERENCE_TEXT = [
  "Attached text/plain: notes.txt",
  "The file was sent by local path because the clipboard text was deferred.",
  "Use the available file reading tools if you need to inspect the file contents.",
].join("\n");

function filePart(metadata: FilePart["metadata"]): FilePart {
  return {
    id: "part-1",
    sessionID: "session-1",
    messageID: "message-1",
    type: "file",
    mime: "text/plain",
    filename: "notes.txt",
    url: "file:///tmp/notes.txt",
    metadata,
  } as unknown as FilePart;
}

test("判据 1：local_ref 带 pathReferenceText ⇒ 逐字还原原文", async () => {
  const block = await filePartToContentBlock(
    filePart({ storageKind: "local_ref", recoverability: "metadata_only", pathReferenceText: PATH_REFERENCE_TEXT }),
    undefined,
  );
  assert.deepEqual(block, { type: "text", text: PATH_REFERENCE_TEXT });
});

test("判据 2：local_ref 没有 pathReferenceText ⇒ 维持既有降级标签，不误判为原文", async () => {
  const block = await filePartToContentBlock(
    filePart({ storageKind: "local_ref", recoverability: "metadata_only" }),
    undefined,
  );
  assert.equal(block.type, "text");
  assert.notEqual(block.type === "text" ? block.text : "", PATH_REFERENCE_TEXT);
  assert.match(block.type === "text" ? block.text : "", /^\[Attached text\/plain: /u);
});

test("判据 3：非 local_ref 即使带同名文本也不走该分支", async () => {
  const block = await filePartToContentBlock(
    filePart({ storageKind: "inline", recoverability: "provider_ready", pathReferenceText: PATH_REFERENCE_TEXT }),
    undefined,
  );
  assert.notDeepEqual(block, { type: "text", text: PATH_REFERENCE_TEXT });
});
