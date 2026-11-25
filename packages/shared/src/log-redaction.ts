// Modified by ZCode: 脱敏规则自上游 zai-org/ZCode v4.0.0 (a4b44451, Apache-2.0) 的 exportLogs.ts 抽出，
// 行为逐条对齐（行级 JSON、值形态兜底、PEM 块、`__proto__` 无原型重建、深度上限），并补多行 JSON 与 VT 剥离。
/**
 * 日志脱敏的单一实现：桌面「导出日志」与反馈诊断归档共用同一套规则。
 *
 * 为什么在 shared：两条导出入口都要处理同一批日志。规则一旦分叉，迟早一条入口补了、
 * 另一条没跟上 —— 本批的缺陷就是反馈归档只做了「能匹配到键名」的文本替换：JSONL 行带敏感键时
 * 整行被替换成 [REDACTED]（诊断信息与 JSON 合法性一起丢），而 JWT / sk- / AKIA 这类只有值形态
 * 特征的密钥直接漏出。导出入口只负责收集、编码识别、流式读写与压缩。
 *
 * 边界：本模块只用字符串与 JSON，不得引入 node:fs / node:path / Buffer 等 Node-only 依赖 ——
 * shared 根入口会被 renderer 打进浏览器产物。编码探测与流式读写留在 desktop 侧
 * （packages/desktop/src/main/exportLogs.ts）。
 */

const REDACTED_PLACEHOLDER = "***REDACTED***";
// 已脱敏过的键名：敏感父字段下的键会被整体替换，重跑时必须原样保留，
// 否则每导出一次就多一层序号，脱敏不幂等。
const REDACTED_KEY_NAME_REGEX = /^\*\*\*REDACTED\*\*\*(?: \(\d+\))?$/;
// 键名不可识别时按值形态兜底：凭据的前缀和 JWT 结构本身就足以判定，
// 不依赖字段叫 apiKey 还是 api-key 还是自定义名字。
const CREDENTIAL_SHAPED_VALUE_REGEX = new RegExp(
  [
    "\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}",
    "\\b(?:sk|rk)-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{16,}",
    "\\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{16,}",
    "\\bgithub_pat_[A-Za-z0-9_]{16,}",
    "\\bglpat-[A-Za-z0-9_-]{16,}",
    "\\bxox[baprs]-[A-Za-z0-9-]{10,}",
    "\\bnpm_[A-Za-z0-9]{16,}",
    "\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b",
    "\\bAIza[0-9A-Za-z_-]{35}\\b",
  ].join("|"),
  "g",
);
// 私钥块跨行出现，脱敏按行推进：BEGIN 之后到 END 之前每一行都换成占位行，
// 保留行数是为了让日志时间戳与行号仍能对齐。
const PRIVATE_KEY_BEGIN_REGEX = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;
const PRIVATE_KEY_END_REGEX = /-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/;
const REDACTED_PRIVATE_KEY_LINE = `${REDACTED_PLACEHOLDER} private key block`;
// 敏感键名“族”：只要键名里包含这些子串就视为敏感（兜底通配），
// 从而覆盖自定义命名（如 db_password、my_secret、x-conn-string 等）而不必逐个精确列举。
// 注意：`token` / `auth` 等是宽松子串，配合下方白名单排除误伤项（如 input_tokens、author）。
const SENSITIVE_KEY_SUBSTRING_PATTERN = [
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "credential",
  "api(?:_|-)?key",
  "access(?:_|-)?key",
  "private(?:_|-)?key",
  "auth",
  "cookie",
  "dsn",
  "conn(?:ection)?(?:_|-)?str(?:ing)?",
  "database(?:_|-)?url",
  "db(?:_|-)?url",
].join("|");
const SENSITIVE_KEY_NAME_REGEX = new RegExp(`(?:${SENSITIVE_KEY_SUBSTRING_PATTERN})`, "i");
// 白名单：命中敏感子串但实际并非密钥的常见键名，避免脱掉排障需要的上下文。
// 不能把任意 "*_tokens" 都白名单化，否则 access_tokens/session_tokens 会被原样导出；
// max_tokens/budget_tokens 是模型输出与思考预算，不是凭据，需保留用于判断 provider 请求是否撞限；
// 因此这里只放行明确的 LLM token 计数/预算字段，以及 author/authority 这类含 "auth" 的普通词。
// 敏感键下的数字也会被脱敏，计数键必须逐个列进来：前缀只由“计数用词”组成（不含 access/session/
// refresh/id/read/write 单独出现），覆盖各家 provider 的用量字段（cache_read_input_tokens、
// ephemeral_5m_input_tokens、*_tokens_details、max_completion_tokens、*TokenCount）和 ZCode 内部的
// camelCase 计数（cacheReadTokens、maxOutputTokens）。buildSnapshot 是快照耗时，误中了 "dsn" 子串。
// 下面的 "_" 是键名分隔符占位，组装完整个正则后统一换成“可选的 _ 或 -”（兼容 camelCase）。
const TOKEN_COUNT_KEY_PREFIX_PATTERN = [
  "prompt",
  "completion",
  "total",
  "input",
  "output",
  "reasoning",
  "max",
  "budget",
  "audio",
  "candidates",
  "thoughts",
  "accepted_prediction",
  "rejected_prediction",
  "tool_use_prompt",
  "max_output",
  "max_completion",
  "prompt_cache_(?:hit|miss)",
  "(?:un)?cached(?:_(?:read|write|content))?(?:_input)?",
  "cache_(?:read|write|creation)(?:_input)?",
  "ephemeral_\\d+[mh]_input",
].join("|");
const NON_SENSITIVE_KEY_NAME_ALLOWLIST_REGEX = new RegExp(
  [
    "^(?:public_key|keywords?|tokenizer|token_count|build_snapshot|author(?:s|ity|ed)?",
    `|(?:total_)?(?:${TOKEN_COUNT_KEY_PREFIX_PATTERN})_(?:tokens(?:_details)?|token_count))$`,
  ]
    .join("")
    .replaceAll("_", "(?:_|-)?"),
  "i",
);

function isSensitiveKeyName(keyName: string): boolean {
  if (NON_SENSITIVE_KEY_NAME_ALLOWLIST_REGEX.test(keyName)) {
    return false;
  }
  return SENSITIVE_KEY_NAME_REGEX.test(keyName);
}
// 以下正则先宽松捕获“键名 + 值”，再由 isSensitiveKeyName 决定是否脱敏，
// 这样键名黑名单不再是硬编码列表，而是“敏感族 + 通配 + 白名单例外”。
// 第三个分支只取对象/数组的开括号，由 redactJsonStyleValues 按括号配对整段替换（见该函数）。
const JSON_STYLE_SENSITIVE_VALUE_REGEX =
  /(["'])([A-Za-z0-9_.-]+)\1(\s*:\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[[{]|[^,\r\n}\]]+)/g;
// 赋值行允许行首之外的空白或分隔符前缀：真实日志常带时间戳或级别前缀
// （如 "[info] OPENAI_API_KEY=…"），只在行首匹配会让这类敏感字段漏脱敏。
const ASSIGNMENT_STYLE_SENSITIVE_VALUE_REGEX =
  /((?:^|[\s,;])[ \t]*)([A-Za-z0-9_.-]+)([ \t]*=[ \t]*)([^\r\n#]+)/g;
const HEADER_STYLE_SENSITIVE_VALUE_REGEX =
  /((?:^|\n)[ \t]*)([A-Za-z0-9-]+)([ \t]*:[ \t]*)([^\r\n]+)/g;
// Bearer、URL query、连接串三条规则与 staging 一致：值里的引号和反斜杠一律当内容。
// JSONL 行已按结构脱敏，这里只处理已解码的字符串和解析不了的文本行；为保护文本里内嵌的 JSON
// 而在引号处停下，会让 `p"a"s`、`ex'ample` 这类口令整段或部分原样导出（审查两次复现）。
// 代价是文本行里的内嵌 JSON 可能被多替换一段（例如吞到下一个字段的 @），只损失上下文，不泄露。
const BEARER_TOKEN_REGEX = /(Bearer\s+)([^\s"']+)/g;
const QUERY_TOKEN_REGEX =
  /([?&](?:key|api(?:_|-)?key|access(?:_|-)?token|refresh(?:_|-)?token|token|password|passwd|pwd|secret|client(?:_|-)?secret|auth(?:_|-)?token|session(?:_|-)?token)=)([^&#\s]+)/gi;
// 按“值形态”脱敏：连接串 scheme://user:pass@host 里的凭据部分，
// 不依赖键名即可覆盖 postgres/mysql/mongodb/redis/amqp 等数据库连接信息。保留 scheme 与 host 便于排障。
// 用户名段允许为空以覆盖 redis://:password@host；口令段贪婪匹配到最后一个 @（host 段不含 @），
// 这样口令里含裸 @（如 P@ssw0rd）也能整段脱敏，不残留片段。
const CONNECTION_STRING_CREDENTIALS_REGEX =
  /\b([a-z][a-z0-9+.-]*:\/\/)([^:/\s]*):([^/\s]+)@(?=[^@/\s])/gi;
// 结构化脱敏的递归深度上限。真实日志不到几十层；超限的行整行换成占位行，避免栈溢出中断导出。
const MAX_JSON_REDACTION_DEPTH = 256;
const JSON_DEPTH_EXCEEDED = Symbol("json-redaction-depth-exceeded");
const JSON_DEPTH_EXCEEDED_LINE = JSON.stringify({
  exportRedaction: `line replaced: JSON nested deeper than ${MAX_JSON_REDACTION_DEPTH} levels`,
});
function redactValue(rawValue: string, quoteBareValue = false): string {
  const leadingSpaces = rawValue.match(/^\s*/)?.[0] ?? "";
  const trailingSpaces = rawValue.match(/\s*$/)?.[0] ?? "";
  const core = rawValue.trim();
  // JSON 键（双引号）下的裸值（数字、布尔、null）换成带引号的占位符，保证该行仍是合法 JSON。
  const quote =
    core.startsWith('"') && core.endsWith('"')
      ? '"'
      : core.startsWith("'") && core.endsWith("'")
        ? "'"
        : quoteBareValue
          ? '"'
          : "";
  const redacted = quote ? `${quote}${REDACTED_PLACEHOLDER}${quote}` : REDACTED_PLACEHOLDER;
  return `${leadingSpaces}${redacted}${trailingSpaces}`;
}

function redactHeaderValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (/^bearer\s+/i.test(trimmed)) {
    return trimmed.replace(/^bearer\s+.+$/i, `Bearer ${REDACTED_PLACEHOLDER}`);
  }
  return REDACTED_PLACEHOLDER;
}

function redactConnectionStringCredentials(rawContent: string): string {
  // postgres://admin:secret@host → postgres://*REDACTED*:*REDACTED*@host
  return rawContent.replace(
    CONNECTION_STRING_CREDENTIALS_REGEX,
    (_match, scheme: string) => `${scheme}${REDACTED_PLACEHOLDER}:${REDACTED_PLACEHOLDER}@`,
  );
}

/** 从开括号位置起按字符串感知的括号配对找结束位置（结束括号之后）；同一行内配不上返回 -1。 */
function findBracketedValueEnd(content: string, start: number): number {
  let depth = 0;
  let stringQuote = "";
  for (let index = start; index < content.length; index += 1) {
    const char = content[index];
    if (char === "\n" || char === "\r") return -1;
    if (stringQuote) {
      if (char === "\\") index += 1;
      else if (char === stringQuote) stringQuote = "";
      continue;
    }
    if (char === '"' || char === "'") stringQuote = char;
    else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

/**
 * 文本里 `"key": value` 形式的敏感值。对象/数组值不能只看第一个字段：内层键名不敏感时
 * （`{"token":{"value":"…"}}`）凭据会原样导出，因此按括号配对整段换成带引号的占位符；
 * 同一行内配不上（截断的 JSON）就替换到行尾。只有开括号、后面没有内容的行是多行格式化 JSON
 * （config.json）的开头，保持原样，后续行仍逐行按键名脱敏，不破坏文件结构。
 */
function redactJsonStyleValues(content: string): string {
  const pattern = JSON_STYLE_SENSITIVE_VALUE_REGEX;
  pattern.lastIndex = 0;
  let output = "";
  let cursor = 0;
  for (let match = pattern.exec(content); match; match = pattern.exec(content)) {
    // 四个捕获组在正则里都是必选的，默认值只为满足 noUncheckedIndexedAccess。
    const [whole, quote = '"', keyName = "", , rawValue = ""] = match;
    if (!isSensitiveKeyName(keyName)) continue;
    const valueStart = match.index + whole.length - rawValue.length;
    let valueEnd = valueStart + rawValue.length;
    let replacement: string;
    if (rawValue === "{" || rawValue === "[") {
      const bracketEnd = findBracketedValueEnd(content, valueStart);
      if (bracketEnd === -1) {
        const lineBreak = content.slice(valueStart).search(/[\r\n]/);
        const lineEnd = lineBreak === -1 ? content.length : valueStart + lineBreak;
        if (content.slice(valueStart + 1, lineEnd).trim() === "") continue;
        valueEnd = lineEnd;
      } else {
        valueEnd = bracketEnd;
      }
      replacement = `${quote}${REDACTED_PLACEHOLDER}${quote}`;
    } else {
      replacement = redactValue(rawValue, quote === '"');
    }
    output += content.slice(cursor, valueStart) + replacement;
    cursor = valueEnd;
    pattern.lastIndex = valueEnd;
  }
  pattern.lastIndex = 0;
  return output + content.slice(cursor);
}

function sanitizeSensitiveLogContent(rawContent: string): string {
  // 导出日志不能按文件原样拷贝：会把用户配置和协议日志里的 token/apiKey 一并带出。
  // 线上排障需要“保留文件结构和上下文”，但不应该泄露密钥本体；
  // 这里在导出阶段统一对常见敏感值做脱敏，字段和日志行仍完整保留，支持继续定位问题。
  // 键名不再是硬编码黑名单，而是“敏感键名族 + 子串通配 + 白名单例外”（isSensitiveKeyName），
  // 并叠加按值形态的连接串脱敏，以覆盖数据库连接串等自定义命名的敏感信息。
  return redactJsonStyleValues(redactConnectionStringCredentials(rawContent))
    .replace(
      ASSIGNMENT_STYLE_SENSITIVE_VALUE_REGEX,
      (match, prefix: string, keyName: string, separator: string, rawValue: string) =>
        isSensitiveKeyName(keyName)
          ? `${prefix}${keyName}${separator}${redactValue(rawValue)}`
          : match,
    )
    .replace(
      HEADER_STYLE_SENSITIVE_VALUE_REGEX,
      (match, prefix: string, headerName: string, separator: string, rawValue: string) =>
        isSensitiveKeyName(headerName)
          ? `${prefix}${headerName}${separator}${redactHeaderValue(rawValue)}`
          : match,
    )
    .replace(BEARER_TOKEN_REGEX, `$1${REDACTED_PLACEHOLDER}`)
    .replace(QUERY_TOKEN_REGEX, `$1${REDACTED_PLACEHOLDER}`)
    .replace(CREDENTIAL_SHAPED_VALUE_REGEX, REDACTED_PLACEHOLDER);
}

interface JsonRedactionState {
  changed: boolean;
}

type JsonRedactionResult =
  | { kind: "invalid" }
  | { kind: "unchanged" }
  | { kind: "changed"; text: string };

// TS 6 的 lib 还没有 JSON.rawJSON / JSON.isRawJSON 的声明；Node 24 与 Electron 44（V8 15）都已支持。
const RAW_JSON = JSON as unknown as {
  rawJSON?: (text: string) => unknown;
  isRawJSON?: (value: unknown) => boolean;
};

function isRawJsonNumber(value: unknown): boolean {
  return RAW_JSON.isRawJSON?.(value) === true;
}

/**
 * 重写一行时数字按原始字面量写回：超过 2^53 的整数（请求 id、纳秒时间戳）和 `1.50` 这类写法
 * 经 Number 往返会被改写。只包装往返后会变的数字，其余仍是普通 number。
 */
function parseJsonPreservingNumbers(text: string): unknown {
  const rawJSON = RAW_JSON.rawJSON;
  if (!rawJSON) return JSON.parse(text) as unknown;
  return JSON.parse(text, (_key, value: unknown, context?: { source?: string }) =>
    typeof value === "number" && context?.source !== undefined && String(value) !== context.source
      ? rawJSON(context.source)
      : value,
  ) as unknown;
}

/**
 * 解析并脱敏一段 JSON 文本。先用普通 JSON.parse 判断是否需要改；只有需要改时才按原始数字字面量
 * 重新解析再写回，未命中的行不承担 reviver 的开销，也不会被重新序列化。
 */
function redactJsonText(text: string, depth: number): JsonRedactionResult {
  const parsed = parseJsonLine(text);
  if (parsed === undefined) return { kind: "invalid" };
  const probe: JsonRedactionState = { changed: false };
  redactJsonValue(parsed.value, false, probe, depth);
  if (!probe.changed) return { kind: "unchanged" };
  const state: JsonRedactionState = { changed: false };
  const redacted = redactJsonValue(parseJsonPreservingNumbers(text), false, state, depth);
  return { kind: "changed", text: JSON.stringify(redacted) };
}

function redactJsonStringValue(value: string, state: JsonRedactionState, depth: number): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    // 字符串里嵌着的 JSON（请求体、工具参数）按结构递归，否则内层的 api_key 会被当成普通文本漏掉。
    // 嵌套 JSON 与外层共用深度预算，字符串里一层套一层也不能绕过上限。
    const nested = redactJsonText(trimmed, depth + 1);
    if (nested.kind === "unchanged") return value;
    if (nested.kind === "changed") {
      state.changed = true;
      return nested.text;
    }
  }
  const sanitized = sanitizeSensitiveLogContent(value);
  if (sanitized !== value) state.changed = true;
  return sanitized;
}

/**
 * 对象键也可能是凭据：连接串、带 token 的 URL、`Bearer …` 被当作键时，按值形态脱敏后再写回。
 * 两个键脱敏后可能相同，加序号避免后写的覆盖先写的。
 *
 * `nextSuffix` 按对象记录每个脱敏结果下次从哪个序号试起：敏感父字段下的键全部脱敏成同一个占位符，
 * 每个键都从 ` (2)` 重新试会是 O(n²)，一行几千个键就会长时间阻塞主进程。试过的候选都已被占用，
 * 占用只增不减（结果对象只增加键、原对象不变），所以接着上次往后试，结果与逐个从头试完全相同。
 */
function redactJsonObjectKey(
  key: string,
  source: object,
  result: Record<string, unknown>,
  nextSuffix: Map<string, number>,
  state: JsonRedactionState,
  sensitive: boolean,
): string {
  // 上一次导出留下的占位键原样保留：再脱一次会让序号不断增长，二次导出不再幂等。
  if (REDACTED_KEY_NAME_REGEX.test(key)) return key;
  let sanitized: string;
  if (sensitive) {
    // 敏感父字段下的键本身就可能是凭据（`{"token":{"tok_…":{…}}}` 这类以 token 为键的映射），
    // 不能指望它带有连接串、URL、Bearer 等可识别的形态：和值一样整体换成占位符，重名加序号。
    sanitized = REDACTED_PLACEHOLDER;
  } else {
    // 绝大多数键是标识符：文本规则都要求 `://`、`=`、`:`、空格、`?`、`&` 或引号之一，纯标识符
    // 不可能命中，跳过以免每个键都跑一遍全部正则（本机 10 万行日志里这一步占了新增耗时的大头）。
    if (!/[^\w.$-]/.test(key)) return key;
    sanitized = sanitizeSensitiveLogContent(key);
    if (sanitized === key) return key;
  }
  state.changed = true;
  // 序号 1 表示不加后缀的原样结果。
  let index = nextSuffix.get(sanitized) ?? 1;
  let candidate = index === 1 ? sanitized : `${sanitized} (${index})`;
  while (Object.hasOwn(result, candidate) || Object.hasOwn(source, candidate)) {
    index += 1;
    candidate = `${sanitized} (${index})`;
  }
  nextSuffix.set(sanitized, index + 1);
  return candidate;
}

function redactJsonValue(
  value: unknown,
  sensitive: boolean,
  state: JsonRedactionState,
  depth = 0,
): unknown {
  if (depth > MAX_JSON_REDACTION_DEPTH) throw JSON_DEPTH_EXCEEDED;
  if (typeof value === "string") {
    if (sensitive) {
      state.changed = true;
      return REDACTED_PLACEHOLDER;
    }
    return redactJsonStringValue(value, state, depth);
  }
  const isNumber = typeof value === "number" || isRawJsonNumber(value);
  if (isNumber && sensitive) {
    // 数字可能就是凭据本身（纯数字密码、PIN）：敏感键下换成字符串占位符，该行仍是合法 JSON。
    // 非敏感键下的数字（token 计数、耗时）原样保留；计数键靠上面的白名单免于误伤。
    state.changed = true;
    return REDACTED_PLACEHOLDER;
  }
  if (isNumber) return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactJsonValue(item, sensitive, state, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    // 用无原型对象重建：普通 {} 上写 `__proto__` 会触发原型 setter，这个键会从导出里消失。
    const result = Object.create(null) as Record<string, unknown>;
    const nextSuffix = new Map<string, number>();
    for (const [key, item] of Object.entries(value)) {
      // 键名是否敏感按原键判断；父字段已敏感时，键自己也按敏感处理。
      const outputKey = redactJsonObjectKey(key, value, result, nextSuffix, state, sensitive);
      result[outputKey] = redactJsonValue(
        item,
        sensitive || isSensitiveKeyName(key),
        state,
        depth + 1,
      );
    }
    return result;
  }
  // 布尔和 null 只有 true/false/null 三个取值，承载不了凭据，即使在敏感键下（auth 开关、
  // token: null 表示未配置）也原样保留，排障时能看出“有没有配置”。
  return value;
}

function parseJsonLine(line: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(line) as unknown };
  } catch {
    return undefined;
  }
}

/**
 * 整行是 JSON（model-io / CLI 日志的 JSONL）时按结构脱敏再序列化，导出后每行仍能 JSON.parse。
 * 根因：文本正则直接改 JSON 文本，会留下未加引号的占位符、吞掉 `\"` 的反斜杠、把对象值切掉半截。
 * 未命中敏感内容的行原样输出；命中的行重写时数字保留原始字面量。
 * 顶层是 JSON 字符串的行（`"{\"password\":…}"`）也按结构处理，否则转义后的内层凭据只经过文本规则。
 */
function sanitizeSensitiveJsonLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (!/^[[{"]/.test(trimmed)) return undefined;
  let result: JsonRedactionResult;
  try {
    result = redactJsonText(trimmed, 0);
  } catch (error) {
    // 超深的行无法安全逐层判断，整行换成说明占位（仍是合法 JSON），导出继续，原文不进归档。
    if (error === JSON_DEPTH_EXCEEDED) return JSON_DEPTH_EXCEEDED_LINE;
    throw error;
  }
  if (result.kind === "invalid") return undefined;
  if (result.kind === "unchanged") return line;
  const leading = line.match(/^\s*/)?.[0] ?? "";
  const trailing = line.match(/\s*$/)?.[0] ?? "";
  return `${leading}${result.text}${trailing}`;
}

export interface PrivateKeyRedactionState {
  insidePrivateKeyBlock: boolean;
}

export function createPrivateKeyRedactionState(): PrivateKeyRedactionState {
  return { insidePrivateKeyBlock: false };
}

/**
 * 私钥块可能跨 stream chunk：未见到对应的 END 行时保持 inside 状态，块体每行都换成占位行。
 * 返回 null 表示这一行与私钥块无关，交回按行 JSON 与文本规则处理。
 */
function redactPrivateKeyBlockLine(line: string, state: PrivateKeyRedactionState): string | null {
  if (state.insidePrivateKeyBlock) {
    if (PRIVATE_KEY_END_REGEX.test(line)) {
      state.insidePrivateKeyBlock = false;
    }
    return REDACTED_PRIVATE_KEY_LINE;
  }
  if (!PRIVATE_KEY_BEGIN_REGEX.test(line)) {
    return null;
  }
  // BEGIN 与 END 同行是异常形态，仍整行替换，避免残留块体。
  if (!PRIVATE_KEY_END_REGEX.test(line)) {
    state.insidePrivateKeyBlock = true;
  }
  return REDACTED_PRIVATE_KEY_LINE;
}

export function sanitizeSensitiveLogChunk(chunk: string, state: PrivateKeyRedactionState): string {
  return chunk.replace(/[^\r\n]+/g, (line) => {
    const privateKeyLine = redactPrivateKeyBlockLine(line, state);
    if (privateKeyLine !== null) {
      return privateKeyLine;
    }
    return sanitizeSensitiveJsonLine(line) ?? sanitizeSensitiveLogContent(line);
  });
}

/**
 * 整份文件是一个 JSON 值时按结构脱敏（config.json 这类多行格式化 JSON）。
 * 逐行文本规则只能按行判断键名：`"token": {` 与后续 `"value": …` 分属不同行，
 * 内层键名不敏感时凭据会原样留下；因此这里先整份解析。
 * 返回 null 表示不是单值 JSON（JSONL、普通文本日志）或已无需改写，交回逐行文本脱敏。
 */
export function sanitizeJsonDocumentText(text: string): string | null {
  const probe = parseJsonLine(text);
  if (!probe) return null;
  const probeState: JsonRedactionState = { changed: false };
  redactJsonValue(probe.value, false, probeState);
  if (!probeState.changed) return text;
  const state: JsonRedactionState = { changed: false };
  const redacted = redactJsonValue(parseJsonPreservingNumbers(text), false, state);
  return `${JSON.stringify(redacted, null, 2)}\n`;
}

/**
 * 两条导出入口的清单共用这段脱敏说明。用户会把这个包发给别人，所以既要写清已经脱敏了什么，
 * 也要写清哪些形态按原样保留：形态上与普通文本无法区分的自定义字段。
 * 二进制文件的处置两条入口不同（导出日志原样复制、反馈归档不打包），
 * 由各入口用自己的事实单独声明，避免清单写成对方的行为。
 */
export const LOG_REDACTION_NOTICE_LINES: readonly string[] = [
  "日志脱敏说明",
  "- 导出前对可识别的文本日志做结构化脱敏：JSON/JSONL 按键名与结构处理，覆盖嵌套对象和字符串里转义的 JSON。",
  "- 键名族包含 token、apiKey、authorization、cookie、password、secret、privateKey、连接串等；",
  "  另外按值形态处理 URL query 凭据、Authorization/Bearer、连接串口令、PEM 私钥块，以及 JWT、sk- 等常见密钥形态。",
  "- 自定义字段里形态上与普通文本无法区分的字符串无法自动识别，导出前请确认日志中没有手工粘贴的凭据。",
];

/**
 * 多行格式化 JSON（config.json 这类）才按整份解析：单行就是完整 JSON 的文件交给按行结构脱敏，
 * 保持原有紧凑格式，不被重排成多行。
 */
export function isFormattedJsonDocumentText(text: string): boolean {
  const firstSignificantChar = text.trimStart()[0];
  // 只有对象或数组开头的文件才可能是一个 JSON 值，提前返回以免给每个日志文件都跑一次解析。
  if (firstSignificantChar !== "{" && firstSignificantChar !== "[") return false;
  const firstLineBreakIndex = text.indexOf("\n");
  if (firstLineBreakIndex < 0) return false;
  const firstLine = text.slice(0, firstLineBreakIndex).trim();
  return firstLine.length === 0 || parseJsonLine(firstLine) === undefined;
}

/**
 * 单个文本文件内容的统一脱敏入口（两条导出入口共用）。
 *
 * 顺序与导出日志一致：先试整份 JSON —— 多行格式化配置里的嵌套凭据（`"token": {` 与内层
 * `"value": …` 分属不同行，逐行规则只会按行判断键名）只能按结构处理；再按行推进，
 * 用同一份行级实现（JSONL 结构脱敏 + 文本规则 + 跨行私钥块状态机）。
 */
export function redactLogTextContent(text: string): string {
  try {
    if (isFormattedJsonDocumentText(text)) {
      const documentText = sanitizeJsonDocumentText(text);
      if (documentText !== null) return documentText;
    }
    return sanitizeSensitiveLogChunk(text, createPrivateKeyRedactionState());
  } catch (error) {
    // 超深 JSON 无法逐层判断：整份换成说明占位（仍是合法 JSON），原文不外发。
    // 不能退化成逐行处理 —— 多行格式化 JSON 的内层键名不敏感时，值会原样留下。
    if (error === JSON_DEPTH_EXCEEDED) return `${JSON_DEPTH_EXCEEDED_LINE}\n`;
    throw error;
  }
}
