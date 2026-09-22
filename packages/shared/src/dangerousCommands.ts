/**
 * 危险命令清单：**工具与权限策略页**与 **core 的 Bash 授权判据**共用的唯一真相源。
 *
 * 为什么放在 shared 而不是 core 或 ui：这份清单同时被两侧消费 ——
 * core 用它决定「能不能生成前缀规则 / 能不能进入持久授权」，设置页用它渲染「可查看」的列表。
 * 两处各写一份就会漂移（AGENTS.md「避免重复状态和多条写入路径」）。
 *
 * 判据是「**规范化可执行名**」而不是字面命令前缀：core 的 `unwrapCommand` 会解开
 * `time`/`env`/`sudo` 等 wrapper，所以 `sudo rm -rf /` 的规范化可执行名是 `rm`。
 * 这与 core 原 `HIGH_RISK_ROOT_COMMANDS`（只查内层可执行名）**不同** —— 后者是
 * 安全审计 task-67 §7.5「债 1」：wrapper 链完全不参与判定，于是 `sudo` 永不触发保守化。
 * 本模块把提权 wrapper 独立成项，补上那条链。
 *
 * 清单项形态（裁决 2）：
 * - **单名项**（`rm`、`npm`）：按规范化可执行名匹配；
 * - **带参数项**（`docker run`）：按**规范化前缀**匹配 —— `docker run:*` 正是实测的放大形态；
 * - **提权项**（`sudo`/`doas`/`pkexec`）：命令链里出现即视为危险，与内层命令无关。
 * 这不是「规则黑名单」：清单只决定**保守化**（只许精确匹配），不直接放行或拒绝任何命令。
 */

/**
 * 默认危险可执行名。
 * 与 core 原 `HIGH_RISK_ROOT_COMMANDS` **逐字一致**（实测 16 条；task-67 §7.5 写的 19 条是计数错误，
 * task-72 已独立纠正）。
 */
export const DEFAULT_DANGEROUS_EXECUTABLES: readonly string[] = [
  "bash",
  "chgrp",
  "chmod",
  "chown",
  "cmd",
  "dd",
  "fish",
  "mkfs",
  "mount",
  "powershell",
  "pwsh",
  "rm",
  "rmdir",
  "sh",
  "umount",
  "zsh",
];

/**
 * 提权 wrapper。独立成项的理由：core 的保守化只查 `unwrapped.executable`（内层名），
 * `sudo` 永远不在那条分支上 —— 所以 `sudo apt install foo` 会生成 `sudo apt install:*`。
 * 提权本身就是一个需要保守化的信号，与内层命令是什么无关。
 */
export const PRIVILEGE_WRAPPERS: readonly string[] = ["doas", "pkexec", "sudo"];

/** 用户自加项的数量上限。清单是安全策略，不设上限等于允许把授权面拖垮。 */
export const MAX_CUSTOM_DANGEROUS_ENTRIES = 50;
/** 单个自加项的长度上限。 */
export const MAX_DANGEROUS_PATTERN_LENGTH = 128;

/**
 * 用户自加的危险命令项。
 * - `pattern` 不含空白 ⇒ 按可执行名匹配；含空白 ⇒ 按命令前缀匹配。
 * - `enabled === false` 即「已关闭」：与删除不同，关闭可逆（裁决：关闭可逆、删除不可逆）。
 */
export interface DangerousCommandCustomEntry {
  pattern: string;
  enabled?: boolean;
}

/**
 * 用户对危险命令清单的偏差。**缺省即严格**：
 * `allowPersistentAuthorization` 缺席按 false 解释，默认项全部生效。
 */
/**
 * 注意：数组字段**不是 readonly**。这是 wire 类型 —— 它必须与
 * `validationAppSettings.ts` 里 zod 推断出的形状**逐字段可赋值**，否则 Host 侧
 * `settings.dangerousCommandPolicy` 传不进协议结果类型（readonly 数组不可赋给可变数组）。
 * 只读语义由消费方（ResolvedDangerousCommandPolicy）承担，不在这里表达。
 */
export interface DangerousCommandPolicy {
  /**
   * 危险命令是否可进入项目级/会话级授权。
   * - `false`（缺省）：只允许「仅此一次」，且**已落盘的授权规则不放行**（评估时撤销）；
   * - `true`：可进入持久授权，但**仍然只生成精确规则**，绝不生成 `:*` 前缀规则。
   */
  allowPersistentAuthorization?: boolean;
  /** 被**关闭**的默认项 id（= 可执行名）。重新打开即从数组移除。 */
  disabledEntries?: string[];
  /** 用户自加项。可关闭、可重新打开、可删除。 */
  customEntries?: DangerousCommandCustomEntry[];
}

export interface ResolvedDangerousCommandPolicy {
  allowPersistentAuthorization: boolean;
  disabledEntries: readonly string[];
  customEntries: readonly DangerousCommandCustomEntry[];
  /** 生效的单名项（默认项减去关闭的 ∪ 启用的自加单名项）。 */
  executableNames: ReadonlySet<string>;
  /** 生效的带参数项，已小写、已去重。 */
  executablePrefixes: readonly string[];
  privilegeWrappers: ReadonlySet<string>;
  /** 未被关闭的默认项。设置页据此区分「默认项」与「用户项」。 */
  enabledDefaultEntries: readonly string[];
  /** 已关闭的默认项。 */
  disabledDefaultEntries: readonly string[];
}

/** core 侧算出的「这条命令是谁」，交给本模块判定是否危险。 */
export interface DangerousCommandSubject {
  /** `unwrapCommand` 解开 wrapper 链后的内层可执行名（basename、任意大小写）。 */
  executableName: string;
  /** wrapper 链上的可执行名，例如 `time sudo apt ...` ⇒ ["time", "sudo"]。 */
  wrapperNames: readonly string[];
  /** 规范化前缀（如 `docker run`）；解析不出稳定前缀时为 undefined。 */
  prefix?: string;
  /** 规范化整条命令（assignments + argv）。带参数的自加项用它兜底匹配。 */
  invocation?: string;
}

function normalizeToken(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

/**
 * 归一化用户输入的自加项。
 * 拒绝空串与含 shell 元字符的输入：清单项是**策略标识**，不是要执行的命令片段，
 * 允许 `;`/`|` 这类字符只会让用户以为自己在写一条会被匹配的命令。
 */
export function normalizeDangerousPattern(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase().replace(/\s+/gu, " ");
  if (!trimmed || trimmed.length > MAX_DANGEROUS_PATTERN_LENGTH) return undefined;
  if (!/^[a-z0-9_./+:-]+( [a-z0-9_./+:-]+)*$/u.test(trimmed)) return undefined;
  return trimmed;
}

export function resolveDangerousCommandPolicy(
  policy?: DangerousCommandPolicy | null,
): ResolvedDangerousCommandPolicy {
  const disabled = new Set<string>();
  for (const entry of policy?.disabledEntries ?? []) {
    const normalized = normalizeToken(entry);
    if (normalized) disabled.add(normalized);
  }

  const executableNames = new Set<string>();
  const enabledDefaultEntries: string[] = [];
  const disabledDefaultEntries: string[] = [];
  for (const name of DEFAULT_DANGEROUS_EXECUTABLES) {
    if (disabled.has(name)) {
      disabledDefaultEntries.push(name);
      continue;
    }
    enabledDefaultEntries.push(name);
    executableNames.add(name);
  }

  const customEntries: DangerousCommandCustomEntry[] = [];
  const executablePrefixes: string[] = [];
  for (const entry of policy?.customEntries ?? []) {
    const pattern = normalizeDangerousPattern(entry?.pattern);
    if (!pattern) continue;
    customEntries.push({ pattern, enabled: entry.enabled !== false });
    if (entry.enabled === false) continue;
    if (pattern.includes(" ")) {
      if (!executablePrefixes.includes(pattern)) executablePrefixes.push(pattern);
    } else {
      executableNames.add(pattern);
    }
  }

  // 提权项也是**默认项**：用户可关闭它（关闭后提权不再自动触发保守化）。
  // 与可执行名项一样，关闭可逆（从 disabledEntries 移除即恢复）、不可删除。
  const privilegeWrappers = new Set<string>();
  for (const name of PRIVILEGE_WRAPPERS) {
    if (disabled.has(name)) {
      disabledDefaultEntries.push(name);
      continue;
    }
    enabledDefaultEntries.push(name);
    privilegeWrappers.add(name);
  }

  return {
    allowPersistentAuthorization: policy?.allowPersistentAuthorization === true,
    customEntries,
    disabledDefaultEntries,
    disabledEntries: [...disabled],
    enabledDefaultEntries,
    executableNames,
    executablePrefixes,
    privilegeWrappers,
  };
}

function matchesPrefix(prefix: string, candidate: string | undefined): boolean {
  if (!candidate) return false;
  const normalized = normalizeToken(candidate);
  return (
    normalized === prefix ||
    normalized.startsWith(`${prefix} `) ||
    normalized.startsWith(`${prefix}\t`)
  );
}

/** 命令是否命中生效清单（含提权项）。 */
export function isDangerousCommandSubject(
  resolved: ResolvedDangerousCommandPolicy,
  subject: DangerousCommandSubject,
): boolean {
  if (subject.wrapperNames.some((name) => resolved.privilegeWrappers.has(normalizeToken(name)))) {
    return true;
  }
  if (resolved.executableNames.has(normalizeToken(subject.executableName))) return true;
  return resolved.executablePrefixes.some(
    (prefix) => matchesPrefix(prefix, subject.prefix) || matchesPrefix(prefix, subject.invocation),
  );
}

/**
 * 规则是否可用于危险命令的**放行**判定。
 *
 * - 严格态（`allowPersistentAuthorization === false`）：**任何**持久 allow 规则都不放行 ——
 *   这就是裁决 3 的「评估时撤销」：用户加严后，此前落盘的规则不得再静默放行。
 *   它同时把「无 ruleContent 的规则匹配一切」这条放大器从危险命令上摘掉。
 * - 放宽态：只认**精确规则**；`:*` 前缀与 `*` 通配一律不认 ——
 *   因为 `docker run:*` / `npm install:*` 正是实测的放大形态。
 *
 * 只作用于 allow；deny / ask 永远用完整规则集，收紧方向不能被削弱。
 */
export function isDangerousCommandAllowRuleEffective(
  resolved: ResolvedDangerousCommandPolicy,
  ruleContent: string | undefined,
): boolean {
  if (!resolved.allowPersistentAuthorization) return false;
  if (!ruleContent) return false;
  return !ruleContent.includes("*");
}
