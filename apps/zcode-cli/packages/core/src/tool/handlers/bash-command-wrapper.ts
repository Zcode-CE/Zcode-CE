/**
 * Bash argv 的 wrapper 拆解工具（从 bash-command-permission-policy.ts 拆出）。
 *
 * 拆出原因：危险命令判定（bash-command-dangerous-policy.ts）与稳定前缀解析都要用同一套
 * wrapper 语义。两处各写一份就会漂移 —— 而 wrapper 链正是安全审计 task-67 §7.5「债 1」的
 * 核心（`HIGH_RISK_ROOT_COMMANDS` 只看内层可执行名，wrapper 链完全不参与判定）。
 */

/** wrapper 的「带值选项」表：这些选项后面跟一个值，解析时要跳过两个 token。 */
export const WRAPPER_OPTIONS_WITH_VALUES: Readonly<Record<string, ReadonlySet<string>>> = {
  command: new Set(),
  env: new Set(["-C", "-S", "-u", "--argv0", "--chdir", "--split-string", "--unset"]),
  nohup: new Set(),
  sudo: new Set([
    "-C",
    "-D",
    "-R",
    "-T",
    "-a",
    "-c",
    "-g",
    "-h",
    "-p",
    "-r",
    "-t",
    "-u",
    "--askpass",
    "--chdir",
    "--chroot",
    "--close-from",
    "--group",
    "--host",
    "--prompt",
    "--role",
    "--type",
    "--user",
  ]),
  time: new Set(["-f", "-o", "--format", "--output"]),
};

/** wrapper 的无值选项。 */
export const WRAPPER_OPTIONS = new Set(["-p", "-v", "-V", "--ignore-environment"]);

export interface UnwrappedCommand {
  executable: string;
  nextIndex: number;
  /** wrapper 链上的原始 token（含 `time`/`env`/`sudo`，可能带路径）。 */
  prefix: string[];
}

/**
 * 解开 wrapper 链，返回内层可执行名与 wrapper 前缀。
 * 最多两层 wrapper（`time sudo apt ...` 可以，更深直接放弃保守化判定）。
 */
export function unwrapCommand(argv: readonly string[]): UnwrappedCommand | undefined {
  const prefix: string[] = [];
  let index = 0;
  let wrapperDepth = 0;
  while (index < argv.length) {
    const token = argv[index]!;
    const name = executableBasename(token);
    const optionsWithValues = WRAPPER_OPTIONS_WITH_VALUES[name];
    if (!optionsWithValues) {
      return { executable: token, nextIndex: index + 1, prefix };
    }
    wrapperDepth += 1;
    if (wrapperDepth > 2) return undefined;
    prefix.push(token);
    index += 1;
    while (index < argv.length) {
      const wrapperToken = argv[index]!;
      if (name === "env" && isStaticAssignmentToken(wrapperToken)) {
        prefix.push(wrapperToken);
        index += 1;
        continue;
      }
      const optionName = wrapperToken.includes("=")
        ? wrapperToken.slice(0, wrapperToken.indexOf("="))
        : wrapperToken;
      if (optionsWithValues.has(optionName)) {
        index += wrapperToken.includes("=") ? 1 : 2;
        continue;
      }
      if (WRAPPER_OPTIONS.has(optionName) || wrapperToken.startsWith("-")) {
        index += 1;
        continue;
      }
      break;
    }
  }
  return undefined;
}

export function isStaticAssignmentToken(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9_./:@,+-]*$/.test(token);
}

export function executableBasename(token: string): string {
  const normalized = token.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
}
