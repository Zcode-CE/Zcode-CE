// 消息文字块的规范拼接（bootstrap 侧唯一一份）。
//
// blockIndex 落地后一条消息可以有多个文字 part：assistant 在流里每块写一个 part，user 侧
// 来自导入、插件或旧版本。把多个块直接拼起来（join("")）会粘掉块边界——冷恢复投影出的
// userInput 文本变成 "ab" 而不是两段，翻新模型重试拿到的 prompt 也跟着走样。
//
// 约定：块之间留一个空行（与 session-transcript、subagent-session-query 的现有呈现一致），
// 空块与 ignored 块不参与拼接。单块消息的结果与旧的直接拼接逐字节相同，旧数据不受影响。
// 维护命令识别这类比对命令原文的地方不要用本函数（块间空行会改变原文形态）。
import type { MessagePart } from "@zcode/contracts";

export const MESSAGE_TEXT_BLOCK_SEPARATOR = "\n\n";

export function joinMessageTextBlocks(parts: readonly MessagePart[]): string {
  const blocks: string[] = [];
  for (const part of parts) {
    if (part.type !== "text" || part.ignored === true || part.text.length === 0) continue;
    blocks.push(part.text);
  }
  return blocks.join(MESSAGE_TEXT_BLOCK_SEPARATOR);
}
