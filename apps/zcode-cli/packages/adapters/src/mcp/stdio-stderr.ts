// Modified by ZCode: 自上游 zai-org/ZCode v4.0.0 (a4b44451, Apache-2.0) 的 mcp/index.ts 抽出并保持行为一致。
//
// MCP stdio 子进程 stderr 的有界缓冲与脱敏。
//
// 为什么独立成模块：这是「MCP 子进程退出前最后一段 stderr」进入生产日志的唯一通道，截断边界和
// 脱敏规则都需要单测直接覆盖；`mcp/index.ts` 属于包的公开导出面（src/index.ts 里 export *），
// 把这两个内部函数留在那里就只能靠扩大公开 API 才测得到。
//
// 行为与上游 4.0.0 的同名函数对齐：截断后丢弃首行残片、单个超长行整段不输出；脱敏前剥离 VT
// 控制序列，并识别 MCP 常见的 PREFIX_TOKEN 式变量名（见 test/mcpStdioStderrBuffer.test.ts）。

import { stripVTControlCharacters } from "node:util";

export function createBoundedTextBuffer(maxChars: number): {
  append(text: string): void;
  read(): string;
} {
  let value = "";
  let truncated = false;
  return {
    append(text: string) {
      if (!text) return;
      value = `${value}${text}`;
      if (value.length > maxChars) {
        value = value.slice(-maxChars);
        truncated = true;
      }
    },
    read() {
      // 尾部截断可能把 VE_SPEECH_MCP_TOKEN=... 切成 KEN=...，键名正则匹配不到会泄露值。
      // 截断后丢弃第一行残片，保证脱敏看到的每一行都完整。
      // 行边界含 \r（进度条只用 \r 刷新）。尾部完全没有换行时（单个超长行），
      // 空白/分隔符可能位于带引号的凭证值内部（KEN="a b" 的 b），从那里恢复会丢失键名和引号上下文而泄露后缀，
      // 没有可靠的字段边界就不输出，只保留传输错误。
      if (!truncated) return value;
      const lineEnd = value.search(/[\r\n]/);
      return lineEnd < 0 ? "" : value.slice(lineEnd + 1);
    },
  };
}

export function sanitizeMcpStdioStderr(text: string): string {
  text = stripVTControlCharacters(text);
  // 插件常给敏感环境变量加前缀，例如 API_TOKEN、VE_SPEECH_MCP_TOKEN，不能只匹配裸 token。
  const sensitiveKey = String.raw`(?:[a-z0-9_.-]*[_-])?(?:api[_-]?key|access[_-]?key|secret(?:[_-]?key)?|private[_-]?key|token|password|passwd|pass|mysql_pass|mysql_password)`;
  let result = text.replace(/(bearer\s+)[^\s"']+/gi, "$1[Redacted]");
  result = result.replace(
    /(\bauthorization\b\s*[:=]\s*)(bearer\s+)?[^\r\n]+/gi,
    (_match, prefix: string, bearer: string | undefined) =>
      `${prefix}${bearer ? "Bearer " : ""}[Redacted]`,
  );
  result = result.replace(new RegExp(`([?&]${sensitiveKey}=)[^&\\s]+`, "gi"), "$1[Redacted]");
  // 引号中的凭证可能包含空格或转义引号，必须整体替换，不能只遮住第一个词。
  const quotedValue = String.raw`(["'])(?:\\.|(?!\2)[^\\\r\n])*\2`;
  result = result.replace(
    new RegExp(String.raw`(["']${sensitiveKey}["']\s*:\s*)${quotedValue}`, "gi"),
    "$1$2[Redacted]$2",
  );
  result = result.replace(
    new RegExp(String.raw`(\b${sensitiveKey}\b\s*[:=]\s*)${quotedValue}`, "gi"),
    "$1$2[Redacted]$2",
  );
  result = result.replace(
    new RegExp(`(\\b${sensitiveKey}\\b\\s*[:=]\\s*)(["']?)[^\\s"',;)}]+`, "gi"),
    "$1$2[Redacted]",
  );
  return result.replace(/([a-z][a-z0-9+.-]*:\/\/)[^:\s/@]+:[^@\s/]+@/gi, "$1[Redacted]@");
}
