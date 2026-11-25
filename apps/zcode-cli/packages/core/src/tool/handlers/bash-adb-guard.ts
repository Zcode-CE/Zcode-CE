// Modified by ZCode: adb 准入按上游 4.0.0（Apache-2.0）移植，并从 bash.ts 拆出——CE 单文件有
// 400 行上限，拆出后 bash.ts 只保留调用点；判定顺序与上游一致，仅把引号转义抽成常量。
import { CoreErrorType, createCoreError, type ExecutionShellSelection } from "@zcode/contracts";
import type { ToolExecutionContext } from "../types.js";
import { analyzeBashCommand, directAdbWord } from "./bash-command-parser.js";
import { analyzeCmdCommand } from "./guarded/cmd.js";

/** POSIX 单引号原样转义：路径里出现单引号时写成 '\'' 才能传给 shell。 */
const POSIX_SINGLE_QUOTE = "'";
const POSIX_QUOTED_SINGLE_QUOTE = "'\\''";

/**
 * 把命令里真正会被执行的 adb 换成已校验的工作区外绝对路径。
 *
 * 根因（上游 4.0.0）：禁用 adb 曾按命令名匹配，工作区里放一个 adb 就能绕过 ——
 * Shell 会优先命中 cwd 与 PATH 里的项目目录；而完全禁名又会误伤合法 SDK。
 * 现在的规则按位置而不是名字：词法候选与 realpath 都必须在工作区之外，
 * 命中后替换成 canonical 绝对路径，Shell 不再做第二次查找。
 */
export async function prepareAdbCommand(
  command: string,
  context: ToolExecutionContext,
  cwd: string,
  dialect: ExecutionShellSelection["dialect"],
): Promise<string> {
  // legacy-shell 只在 POSIX 找不到 bash/zsh 时回落 /bin/sh，Windows 不再产出，只按 POSIX 语法识别。
  // 不能额外用 CMD 解析器分析同一命令：CMD 不认 POSIX 单引号和 heredoc，会把文本里的 adb 当命令改写。
  const cmd = dialect === "cmd";
  const windows = cmd || dialect === "git-bash";
  const invocations = cmd
    ? analyzeCmdCommand(command).commands
    : analyzeBashCommand(command).commands.map((invocation) => invocation.words);
  const replacements = new Map<number, { end: number; text: string }>();
  for (const words of invocations) {
    const word = directAdbWord(words, windows, cmd, command);
    if (!word || replacements.has(word.start)) continue;
    const resolve = context.executionPort?.resolveAdbExecutable;
    if (!resolve) {
      throw createCoreError(
        CoreErrorType.ConfigurationError,
        "Execution adapter cannot resolve adb safely",
      );
    }
    const result = await resolve.call(context.executionPort, {
      file: word.value,
      cwd,
      workspaceRoot: context.workspaceRoot,
    });
    if (result.status !== "resolved") {
      const inWorkspace = result.status === "workspace";
      throw createCoreError(
        inWorkspace ? CoreErrorType.PermissionDenied : CoreErrorType.ConfigurationError,
        inWorkspace
          ? "Workspace-controlled adb execution is blocked. Use an installed SDK outside the workspace."
          : "adb was not found outside the workspace. Configure Android SDK/PATH or use an installed SDK absolute path.",
        {
          context: { reason: inWorkspace ? "workspace-adb-blocked" : "adb-not-found" },
          recoverable: true,
        },
      );
    }
    // 校验后固定到真实绝对路径，避免 Shell 再查找时命中项目里的 adb。
    if (cmd && /[%!"\r\n]/.test(result.path)) {
      throw createCoreError(
        CoreErrorType.ConfigurationError,
        "adb path cannot be safely quoted for CMD",
      );
    }
    const path = dialect === "git-bash" ? result.path.replaceAll("\\", "/") : result.path;
    const text = cmd
      ? `"${path}"`
      : `'${path.replaceAll(POSIX_SINGLE_QUOTE, POSIX_QUOTED_SINGLE_QUOTE)}'`;
    replacements.set(word.start, { end: word.end, text });
  }
  for (const [start, item] of [...replacements].sort(([a], [b]) => b - a)) {
    command = command.slice(0, start) + item.text + command.slice(item.end);
  }
  return command;
}
