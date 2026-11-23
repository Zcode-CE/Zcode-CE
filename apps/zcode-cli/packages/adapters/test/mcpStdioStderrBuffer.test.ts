import assert from "node:assert/strict";
import test from "node:test";
import { createBoundedTextBuffer, sanitizeMcpStdioStderr } from "../src/mcp/stdio-stderr.js";

/**
 * MCP stdio 子进程 stderr 的「最后 N 字符」缓冲与脱敏。
 *
 * 为什么测这一层：这段文本会进入生产日志 —— `attachStdioLogging` 在连接关闭时把缓冲附到失败
 * 事件上（单独的 Connection closed 无法定位子进程退出原因）。裸 slice 截断会落在键名中间：
 * `VE_SPEECH_MCP_TOKEN=...` 被切成 `KEN=...`，键名正则匹配不到 ⇒ 密钥值原样写进日志。所以
 * 断言必须打在「截断 + 脱敏」的最终输出上，而不是缓冲长度或正则本身。
 *
 * 运行：cd apps/zcode-cli/packages/adapters && mise exec node@24.14.0 -- node --import tsx --test test/mcpStdioStderrBuffer.test.ts
 */

const SECRET = "s3cr3t-value-0123456789";
const SECRET_KEY = "VE_SPEECH_MCP_TOKEN=";

test("截断落在键名中间时不输出任何密钥片段", () => {
  const keyHead = SECRET_KEY;
  const secretLine = `${keyHead}${SECRET}`;
  // 保留区从键名内部开始（键名前 16 个字符被截掉），裸 slice 会从 "KEN=" 开始输出。
  const cutInsideKey = 16;
  const buffer = createBoundedTextBuffer(secretLine.length + 1 - cutInsideKey);
  buffer.append(`first line\n${secretLine}\n`);

  const text = buffer.read();
  assert.equal(text.includes(SECRET), false);
  assert.equal(text.includes(keyHead.slice(cutInsideKey)), false);
  assert.equal(sanitizeMcpStdioStderr(text).includes(SECRET), false);
});

test("只有一个超长行（没有任何换行）时整段都不输出", () => {
  const buffer = createBoundedTextBuffer(32);
  buffer.append(`${SECRET_KEY}${SECRET.repeat(2)}`);

  assert.equal(buffer.read(), "");
});

test("跨多次 append 的截断同样丢弃首行残片", () => {
  const buffer = createBoundedTextBuffer(30);
  buffer.append(`${SECRET_KEY}${SECRET}`);
  buffer.append("\n");

  assert.equal(buffer.read().includes(SECRET.slice(-8)), false);
});

test("完整行里的前缀式环境变量名同样脱敏（键名不在行首，拿不到 word boundary）", () => {
  const text = sanitizeMcpStdioStderr(`${SECRET_KEY}${SECRET}\n`);

  assert.equal(text.includes(SECRET), false);
  assert.equal(text, `${SECRET_KEY}[Redacted]\n`);
});

test("ANSI 控制序列不进入日志", () => {
  assert.equal(sanitizeMcpStdioStderr("\u001b[31mboom\u001b[0m"), "boom");
});

test("未发生截断时缓冲原样返回", () => {
  const buffer = createBoundedTextBuffer(64);
  buffer.append("line one\nline two");

  assert.equal(buffer.read(), "line one\nline two");
});

test("截断后丢弃的只有首行残片，后续完整行照常脱敏", () => {
  const secretLine = `api_key=${SECRET}\n`;
  // 保留区 = 上一行末尾 3 个字符 + 换行 + 完整密钥行：只有首行是残片。
  const fragment = 3;
  const buffer = createBoundedTextBuffer(fragment + 1 + secretLine.length);
  buffer.append(`${"n".repeat(40)}\n${secretLine}`);

  const text = sanitizeMcpStdioStderr(buffer.read());
  assert.equal(text.includes(SECRET), false);
  assert.equal(text, `api_key=[Redacted]\n`);
});
