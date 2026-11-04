import { expandCustomCommandPrompt } from "@zcode/contracts";
import { loadZCodeCustomCommand, type ListZCodeCustomCommandsOptions } from "./custom-commands.js";
import { isReservedZCodeSlashCommandName } from "./slash-command-surface.js";

const CUSTOM_COMMAND_NOT_FOUND_PATTERN = /not found/i;
const PROMPT_CUSTOM_COMMAND_PATTERN = /^\/([^\s]+)(?:\s+([\s\S]*))?$/;

interface ResolveZCodeCustomCommandPromptOptions extends ListZCodeCustomCommandsOptions {
  /**
   * 本会话不可寻址的自定义命令名（小写）。与 `isReservedZCodeSlashCommandName` 是同一个
   * 概念的两个来源：那个是全局保留字，这个是调用方按会话下发的门禁，目前唯一使用者是
   * 动态工作流灰度关闭时的 `workflow`。
   * 刻意按**命令名**而不是禁用路径表达：`workflow` 来自随 CLI 打包的 zcode-guide 插件，
   * 其 SKILL/命令文件落在插件缓存目录，调用方拿不到稳定路径。
   */
  disabledCommandNames?: readonly string[];
}

export async function resolveZCodeCustomCommandPrompt(
  input: string,
  options: ResolveZCodeCustomCommandPromptOptions = {},
): Promise<string | undefined> {
  const invocation = parsePromptCustomCommandInvocation(input);
  // 保留名（含内置 `workflow`）在这里直接返回 undefined，与「命令不存在」同形：内置命令由
  // builtin-prompt-command.ts 先行展开，这里拒绝的是借同名自定义命令绕过内置语义（或灰度门）的路径。
  if (!invocation || isReservedZCodeSlashCommandName(invocation.name)) {
    return undefined;
  }
  // 最小侵入点：这里是 `/name` 变成一条命令查找的唯一入口，也是保留字判定已经落脚的地方。
  // 放在 load 之前，被门禁挡住的命令连文件都不读；返回 undefined 与「命令不存在」同形，
  // 上层 input facade 会把原文当普通 prompt 交给模型，不会出现半展开的提示词。
  if (options.disabledCommandNames?.includes(invocation.name)) {
    return undefined;
  }

  try {
    const command = await loadZCodeCustomCommand({
      ...options,
      name: invocation.name,
    });
    // 解析只改写文本：`!` 块交给模型经 Bash 工具执行，见 contracts 的 handOffCustomCommandShellBlocks。
    return expandCustomCommandPrompt({
      args: invocation.args,
      command,
    }).prompt;
  } catch (error) {
    if (error instanceof Error && CUSTOM_COMMAND_NOT_FOUND_PATTERN.test(error.message)) {
      return undefined;
    }
    throw error;
  }
}

function parsePromptCustomCommandInvocation(input: string): { args: string; name: string } | null {
  const match = PROMPT_CUSTOM_COMMAND_PATTERN.exec(input.trim());
  if (!match?.[1]) {
    return null;
  }
  return {
    args: match[2]?.trim() ?? "",
    name: match[1].toLowerCase(),
  };
}
