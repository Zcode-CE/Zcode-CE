// 引导式授权（ENH-2）的纯规则层。
//
// 背景（task-67 / .reverse/30-sudo-auth/SUDO-AUTH-EVAL.md）：本项目**不引入** agent 可交互提权
// 通道（PTY 透传 / askpass / 密码框），改做「引导式授权」—— agent 给出确切命令，UI 提供
// 「发送到终端」，**由用户自己按回车**。审批与执行是同一个动作，TOCTOU 从结构上不可能发生。
//
// 本模块承担这条链路里唯一可以纯函数化的部分：判定一段代码块是不是「可以送到终端的命令」，
// 以及把文本规整成可安全粘贴的形态。它不碰终端、不碰 React、不碰服务，因此可以被单测穷尽覆盖。
//
// **核心不变量（最重要）**：投递出去的文本必须**不可能自行执行**。
//   - 拒绝一切 C0 控制字符（ESC 可伪造 \x1b[201~ 提前闭合括号粘贴信封，\r 在信封外就是「回车」）；
//   - 多行文本是否可投递由调用方按终端实际的括号粘贴（DECSET 2004）状态再判一次，
//     见 canPasteGuidedTerminalCommand —— 未启用括号粘贴时多行粘贴会被 shell 逐行立即执行。
//   ⇒ 用户按下回车，是这条链路上唯一的执行触发点。

/** 允许投递的代码块语言。只收 shell 系，避免把 json/ts 之类的普通代码块也变成命令入口。 */
const GUIDED_TERMINAL_COMMAND_LANGUAGES: ReadonlySet<string> = new Set([
  "bash",
  "sh",
  "shell",
  "shell-session",
  "shellsession",
  "console",
  "zsh",
  "fish",
  "ksh",
  "dash",
  "powershell",
  "pwsh",
  "cmd",
  "bat",
  "batch",
]);

/**
 * 需要提权的命令（sudo 及其同类）。只用于**提示用户**这条命令会要管理员权限，
 * 不参与任何授权判定 —— 授权永远由用户在终端里按下回车完成。
 */
const ELEVATION_COMMANDS = ["sudo", "doas", "pkexec", "gsudo", "runas", "su"] as const;

const ELEVATION_PATTERN = new RegExp(`(?:^|[\\n;&|(])\\s*(?:${ELEVATION_COMMANDS.join("|")})\\b`);

/**
 * 除制表符与换行符之外的全部 C0 控制字符 + DEL。
 * 归一化已把 CR 折成 LF，所以这里连 CR 一起拒绝：留下任何 CR 都意味着有路径绕过了归一化。
 *
 * 用码点比较而不是正则：控制字符正则会被 oxlint 的 no-control-regex 标为"意外控制字符"，
 * 而这里**必须**匹配它们（这正是该函数的全部职责）。码点写法也把区间意图写得更直白：
 * C0 里放行 \t(0x09) 与 \n(0x0a)，其余（含 CR 0x0d）与 DEL(0x7f) 全拒。
 */
function isForbiddenControlCodePoint(codePoint: number): boolean {
  return codePoint <= 0x08 || (codePoint >= 0x0b && codePoint <= 0x1f) || codePoint === 0x7f;
}

export type GuidedTerminalPrivilege = "elevated" | "standard";

/** 命令被拒绝投递的原因。用于 UI 文案与测试断言，不用错误文本做流程判断。 */
export type GuidedTerminalCommandRejection =
  /** 归一化后为空（纯空白 / 只有注释之外的空白）。 */
  | "empty"
  /** 语言不在 shell 系白名单里。 */
  | "unsupported-language"
  /** 含控制字符，粘贴可能绕过「用户按回车」这一唯一执行点。 */
  | "control-characters";

export interface GuidedTerminalCommandPlan {
  /** 归一化后、可直接交给 xterm paste 的文本。 */
  text: string;
  privilege: GuidedTerminalPrivilege;
  /** 归一化后的行数；多行文本需要终端启用括号粘贴才允许投递。 */
  lineCount: number;
  /** 是否是多行文本（= 需要括号粘贴保护）。 */
  multiline: boolean;
}

export type GuidedTerminalCommandResolution =
  | { ok: true; plan: GuidedTerminalCommandPlan }
  | { ok: false; reason: GuidedTerminalCommandRejection };

export function normalizeGuidedTerminalLanguage(language: string): string {
  return language.trim().toLowerCase();
}

/** 该语言是否属于可投递的 shell 命令块。 */
export function isGuidedTerminalCommandLanguage(language: string): boolean {
  return GUIDED_TERMINAL_COMMAND_LANGUAGES.has(normalizeGuidedTerminalLanguage(language));
}

/**
 * 文本归一化：CRLF / CR 折成 LF，去掉首尾空行与尾部空白，保留首行缩进与内部换行。
 * 保留内部换行是必须的 —— 多行命令（heredoc、\ 续行、&& 链）是合法且常见的形态。
 *
 * **归一化只做空白与换行，不做任何"清洗"**：这里绝不能顺手删掉控制字符。
 * 清洗会让危险载荷变成"看起来正常"的命令被投递 —— 那比拒绝更糟，因为用户在代码块里看到的
 * 与终端里收到的不是同一段文本，正是本方案要消灭的"审批—执行不一致"。
 * 所以尾部只裁**空白**（\s 不含 NUL 等控制字符），控制字符一律留给
 * hasForbiddenGuidedTerminalControlCharacters 显式拒绝。
 */
export function normalizeGuidedTerminalCommandText(code: string): string {
  return code.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/^\n+/, "").replace(/\s+$/, "");
}

export function detectGuidedTerminalPrivilege(text: string): GuidedTerminalPrivilege {
  return ELEVATION_PATTERN.test(text) ? "elevated" : "standard";
}

/** 文本是否含会破坏「只有用户回车才执行」这一不变量的控制字符。 */
export function hasForbiddenGuidedTerminalControlCharacters(text: string): boolean {
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && isForbiddenControlCodePoint(codePoint)) return true;
  }
  return false;
}

/**
 * 把一段代码块解析成投递计划。这是「发送到终端」按钮与投递方共用的唯一判定入口：
 * 按钮用它决定是否渲染，投递方用它决定是否粘贴，两边不会各写一套规则。
 */
export function resolveGuidedTerminalCommand(params: {
  code: string;
  language: string;
}): GuidedTerminalCommandResolution {
  if (!isGuidedTerminalCommandLanguage(params.language)) {
    return { ok: false, reason: "unsupported-language" };
  }

  const text = normalizeGuidedTerminalCommandText(params.code);
  if (!text.trim()) {
    return { ok: false, reason: "empty" };
  }
  if (hasForbiddenGuidedTerminalControlCharacters(text)) {
    return { ok: false, reason: "control-characters" };
  }

  const lineCount = text.split("\n").length;
  return {
    ok: true,
    plan: {
      text,
      privilege: detectGuidedTerminalPrivilege(text),
      lineCount,
      multiline: lineCount > 1,
    },
  };
}

/**
 * 终端侧的最后一关：多行文本只有在终端启用了括号粘贴（DECSET 2004）时才允许投递。
 *
 * 为什么必须再判一次：xterm 的 paste 只在 bracketedPasteMode 为真时才包上 \x1b[200~…\x1b[201~。
 * 未启用时，文本里的换行会被 shell 逐行**立即执行** —— 那就等于命令绕过了用户按回车。
 * 单行文本没有这个问题（没有换行就没有执行点），所以照常放行。
 */
export function canPasteGuidedTerminalCommand(params: {
  multiline: boolean;
  bracketedPasteMode: boolean;
}): boolean {
  return !params.multiline || params.bracketedPasteMode;
}
